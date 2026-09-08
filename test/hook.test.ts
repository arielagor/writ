import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashArgs, readChain, verifyChain } from "../src/chain/index.js";
import { decideAndRecord, hookResponse, identityOf, redactReasons } from "../src/gate/decide.js";
import type { Decision } from "../src/authorize.js";
import { examplePath, NOW, ROOT } from "./helpers.js";

const HOOK = join(ROOT, "hooks", "remit-gate.mjs");
const READER = examplePath("gbrain-reader");

// Tests exercise the TypeScript sources. CI exercises the built dist/ in separate steps.
process.env["REMIT_HOOK_PREFER"] = "src";

function tempChain(): string {
  return join(mkdtempSync(join(tmpdir(), "remit-hook-")), "chain.jsonl");
}

interface HookRun {
  status: number | null;
  stdout: string;
  stderr: string;
  deny: { hookSpecificOutput: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } } | null;
}

function runHook(input: string | object, args: string[], env: Record<string, string> = {}): HookRun {
  const proc = spawnSync(process.execPath, [HOOK, ...args], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    timeout: 90_000,
    env: { ...process.env, REMIT_MANIFEST: "", REMIT_CHAIN: "", CLAUDE_AGENT_TYPE: "", ...env },
  });
  const stdout = proc.stdout ?? "";
  const deny = stdout.trim().length > 0 ? (JSON.parse(stdout) as HookRun["deny"]) : null;
  return { status: proc.status, stdout, stderr: proc.stderr ?? "", deny };
}

function hookInput(tool: string, toolInput: unknown, extra: Record<string, unknown> = {}): object {
  return { session_id: "sess-1", hook_event_name: "PreToolUse", tool_name: tool, tool_input: toolInput, ...extra };
}

test("hook: in-purpose call prints nothing, exits 0, and writes an ALLOW record with trusted identity", () => {
  const chain = tempChain();
  const args = { query: "agents", limit: "10" };
  const r = runHook(hookInput("mcp__gbrain__query", args, { agent_type: "tester" }), ["--manifest", READER, "--chain", chain]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  const { records } = readChain(chain);
  assert.equal(records.length, 1);
  const rec = records[0]!;
  assert.equal(rec.decision, "ALLOW");
  assert.equal(rec.tool, "mcp__gbrain__query");
  assert.equal(rec.purpose_id, "gbrain-read-only");
  assert.equal(rec.agent_id, "gbrain-reader");
  assert.equal(rec.identity, "tester");
  assert.equal(rec.session_id, "sess-1");
  assert.equal(rec.arg_hash, hashArgs(args));
  assert.equal(verifyChain(chain).ok, true);
});

test("hook: out-of-purpose argument prints the deny contract and writes a DENY record without the value", () => {
  const chain = tempChain();
  const r = runHook(hookInput("mcp__gbrain__get_page", { slug: "secrets/aws-root" }), ["--manifest", READER, "--chain", chain]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.deny, "expected a JSON deny on stdout");
  assert.equal(r.deny.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(r.deny.hookSpecificOutput.permissionDecision, "deny");
  assert.match(r.deny.hookSpecificOutput.permissionDecisionReason, /^gbrain-read-only: /);
  assert.match(r.deny.hookSpecificOutput.permissionDecisionReason, /regex: arg_deny\.slug/);
  const text = readFileSync(chain, "utf8");
  assert.equal(text.includes("aws-root"), false, "the argument value never reaches the chain");
  const rec = readChain(chain).records[0]!;
  assert.equal(rec.decision, "DENY");
  assert.equal(rec.tool, "mcp__gbrain__get_page");
});

test("hook: a tool the manifest does not name is denied by default", () => {
  const chain = tempChain();
  const r = runHook(hookInput("Bash", { command: "curl http://169.254.169.254/" }), ["--manifest", READER, "--chain", chain]);
  assert.ok(r.deny);
  assert.match(r.deny.hookSpecificOutput.permissionDecisionReason, /no permit matched/);
  const text = readFileSync(chain, "utf8");
  assert.equal(text.includes("169.254"), false, "commands are never written");
  assert.equal(readChain(chain).records[0]!.resource, "Bash");
});

test("hook: identity falls back to CLAUDE_AGENT_TYPE, then main; tool_input.agent_name is ignored", () => {
  const chain = tempChain();
  runHook(hookInput("mcp__gbrain__search", { query: "x", agent_name: "spoofed" }), ["--manifest", READER, "--chain", chain], { CLAUDE_AGENT_TYPE: "cron-worker" });
  runHook(hookInput("mcp__gbrain__search", { query: "y" }), ["--manifest", READER, "--chain", chain]);
  const { records } = readChain(chain);
  assert.equal(records[0]!.identity, "cron-worker");
  assert.equal(records[1]!.identity, "main");
});

test("hook fails closed: no manifest configured is a deny with an ERROR record attributed to unresolved", () => {
  const chain = tempChain();
  const r = runHook(hookInput("mcp__gbrain__search", { query: "x" }), ["--chain", chain]);
  assert.ok(r.deny);
  assert.match(r.deny.hookSpecificOutput.permissionDecisionReason, /no purpose manifest configured/);
  const rec = readChain(chain).records[0]!;
  assert.equal(rec.decision, "ERROR");
  assert.equal(rec.agent_id, "unresolved");
  assert.equal(rec.purpose_id, "unresolved");
});

test("hook fails closed: an invalid manifest is a deny naming the validation error", () => {
  const chain = tempChain();
  const bad = join(mkdtempSync(join(tmpdir(), "remit-badm-")), "bad.yaml");
  writeFileSync(bad, readFileSync(READER, "utf8").replace(/^purpose: >-[\s\S]*?purpose_id:/m, "purpose_id:"), "utf8");
  const r = runHook(hookInput("mcp__gbrain__search", { query: "x" }), ["--manifest", bad, "--chain", chain]);
  assert.ok(r.deny);
  assert.match(r.deny.hookSpecificOutput.permissionDecisionReason, /purpose manifest invalid/);
  assert.equal(readChain(chain).records[0]!.decision, "ERROR");
});

test("hook fails closed: unparseable stdin is a deny with an ERROR record", () => {
  const chain = tempChain();
  const r = runHook("{this is not json", ["--manifest", READER, "--chain", chain]);
  assert.ok(r.deny);
  assert.match(r.deny.hookSpecificOutput.permissionDecisionReason, /hook input is not JSON/);
  const rec = readChain(chain).records[0]!;
  assert.equal(rec.decision, "ERROR");
  assert.equal(rec.tool, "unknown");
});

test("hook fails closed: an allow that cannot be recorded becomes a deny", () => {
  const dir = mkdtempSync(join(tmpdir(), "remit-nochain-"));
  const blocker = join(dir, "not-a-directory");
  writeFileSync(blocker, "x", "utf8");
  const unwritable = join(blocker, "sub", "chain.jsonl");
  const r = runHook(hookInput("mcp__gbrain__search", { query: "x" }), ["--manifest", READER, "--chain", unwritable]);
  assert.equal(r.status, 0);
  assert.ok(r.deny, "an unrecordable allow must not pass silently");
  assert.match(r.deny.hookSpecificOutput.permissionDecisionReason, /audit chain could not be written/);
});

test("hook --self-test runs one allow and one deny through the same path and verifies the chain", () => {
  const proc = spawnSync(process.execPath, [HOOK, "--self-test", "--manifest", READER], { encoding: "utf8", timeout: 90_000, env: { ...process.env, REMIT_HOOK_PREFER: "src" } });
  assert.equal(proc.status, 0, proc.stderr);
  const out = JSON.parse(proc.stdout) as { ok: boolean; allow: { decision: string }; deny: { decision: string }; chain_verify: { ok: boolean; records: number } };
  assert.equal(out.ok, true);
  assert.equal(out.allow.decision, "allow");
  assert.equal(out.deny.decision, "deny");
  assert.equal(out.chain_verify.ok, true);
  assert.equal(out.chain_verify.records, 2);
});

test("decideAndRecord: an expired manifest is a deny at load time, recorded as ERROR", () => {
  const chain = tempChain();
  const out = decideAndRecord(hookInput("mcp__gbrain__search", { query: "x" }), { manifestPath: READER, chainPath: chain, now: new Date("2027-06-01T00:00:00Z") });
  assert.equal(out.decision, "deny");
  assert.equal(out.code, "manifest-invalid");
  assert.match(out.reason, /expired/);
  assert.equal(out.record?.decision, "ERROR");
  assert.equal(hookResponse(out)?.hookSpecificOutput.permissionDecision, "deny");
});

test("decideAndRecord: allow returns no hook response and a record whose policy version matches the manifest", () => {
  const chain = tempChain();
  const out = decideAndRecord(hookInput("mcp__gbrain__search", { query: "x" }), { manifestPath: READER, chainPath: chain, now: NOW });
  assert.equal(out.decision, "allow");
  assert.equal(hookResponse(out), null);
  assert.equal(out.record?.policy_version, out.authorization?.policy_version);
  assert.equal(out.record?.decision, "ALLOW");
});

test("redactReasons strips argument values and keeps policy ids and constraint keys", () => {
  const d: Decision = {
    decision: "deny",
    reasons: ["gbrain-read-only.expired", 'regex: arg_deny.slug: "secrets/aws-root" matches /^(secrets|credentials)\\//'],
    errors: [],
    evaluated_at: NOW.toISOString(),
    agent_id: "a",
    purpose_id: "p",
    policy_version: "v",
    tool: "t",
    resource: "t",
    arg_regex_ok: false,
  };
  const text = redactReasons(d);
  assert.equal(text, "gbrain-read-only.expired; regex: arg_deny.slug");
  assert.equal(redactReasons({ ...d, reasons: [], errors: [] }), "no permit matched (deny by default)");
  assert.equal(redactReasons({ ...d, decision: "allow", reasons: ["p.t"] }), "p.t");
});

test("identityOf never reads tool_input", () => {
  assert.equal(identityOf({ agent_type: "harness", tool_input: { agent_name: "model" } }, {}), "harness");
  assert.equal(identityOf({ tool_input: { agent_name: "model" } }, { CLAUDE_AGENT_TYPE: "env" }), "env");
  assert.equal(identityOf(null, {}), "main");
});
