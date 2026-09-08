/**
 * Probe runner: send every generated case through the real hook process and check the chain.
 *
 * The point of the probe is to prove the enforcement point, not the authorizer. So each case
 * is a fresh `node hooks/remit-gate.mjs` process fed the same JSON Claude Code would send, and
 * the assertion is on what the hook wrote to the chain, not on an in-process return value.
 * The run ends with `verifyChain`, so a probe that passes has also proven the chain holds.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChain, verifyChain, type ChainDecision, type ChainRecord, type VerifyResult } from "../chain/index.js";
import { loadManifest } from "../manifest.js";
import { fromRoot } from "../paths.js";
import { generateCases, type ProbeCase } from "./cases.js";

export interface ProbeOptions {
  /** Chain to write to. Defaults to a fresh temporary chain that is removed afterwards. */
  chainPath?: string;
  /** Hook script. Defaults to the bundled `hooks/remit-gate.mjs`. */
  hookPath?: string;
  /** Node binary. Defaults to the current one. */
  nodePath?: string;
  /** Per-case timeout in ms. Default 30000. */
  timeoutMs?: number;
}

export interface ProbeCaseResult extends ProbeCase {
  got: ChainDecision | "NO-RECORD";
  reason: string;
  seq: number | null;
  ok: boolean;
  stderr: string;
}

export interface ProbeResult {
  manifest_path: string;
  agent_id: string;
  purpose_id: string;
  hook_path: string;
  chain_path: string;
  cases: ProbeCaseResult[];
  skipped: string[];
  verify: VerifyResult;
  ok: boolean;
  summary: { allow_expected: number; allow_ok: number; deny_expected: number; deny_ok: number };
}

interface HookReply {
  decision: "allow" | "deny";
  reason: string;
  stderr: string;
}

function parseReply(stdout: string, stderr: string): HookReply {
  const text = stdout.trim();
  if (text.length === 0) return { decision: "allow", reason: "", stderr };
  try {
    const parsed = JSON.parse(text) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    const d = parsed.hookSpecificOutput?.permissionDecision;
    return {
      decision: d === "deny" ? "deny" : "allow",
      reason: parsed.hookSpecificOutput?.permissionDecisionReason ?? "",
      stderr,
    };
  } catch {
    return { decision: "deny", reason: `hook printed something that is not the contract: ${text.slice(0, 120)}`, stderr };
  }
}

export function runProbe(manifestPath: string, opts: ProbeOptions = {}): ProbeResult {
  const manifest = loadManifest(manifestPath);
  const hookPath = opts.hookPath ?? fromRoot("hooks", "remit-gate.mjs");
  const nodePath = opts.nodePath ?? process.execPath;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const temp = opts.chainPath ? null : mkdtempSync(join(tmpdir(), "remit-probe-"));
  const chainPath = opts.chainPath ?? join(temp!, "chain.jsonl");
  const { cases, skipped } = generateCases(manifest);

  const before = readChain(chainPath).records.length;
  const results: ProbeCaseResult[] = [];
  for (const c of cases) {
    const input = {
      session_id: "probe",
      hook_event_name: "PreToolUse",
      tool_name: c.tool,
      tool_input: c.args,
      agent_type: "probe",
    };
    const proc = spawnSync(nodePath, [hookPath, "--manifest", manifestPath, "--chain", chainPath], {
      input: JSON.stringify(input),
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env, REMIT_MANIFEST: "", REMIT_CHAIN: "" },
    });
    const reply = parseReply(proc.stdout ?? "", proc.stderr ?? "");
    const records = readChain(chainPath).records;
    const last: ChainRecord | undefined = records[records.length - 1];
    const recorded = last && records.length === before + results.length + 1 && last.tool === c.tool ? last : undefined;
    const got: ChainDecision | "NO-RECORD" = recorded ? recorded.decision : "NO-RECORD";
    const replyMatchesRecord = recorded !== undefined && (reply.decision === "allow" ? got === "ALLOW" : got !== "ALLOW");
    const ok = proc.status === 0 && got === c.expect && replyMatchesRecord;
    results.push({ ...c, got, reason: recorded?.reason ?? reply.reason, seq: recorded?.seq ?? null, ok, stderr: (proc.stderr ?? "").trim() });
  }

  const verify = verifyChain(chainPath);
  const allowExpected = cases.filter((c) => c.expect === "ALLOW").length;
  const denyExpected = cases.filter((c) => c.expect === "DENY").length;
  const allowOk = results.filter((r) => r.expect === "ALLOW" && r.ok).length;
  const denyOk = results.filter((r) => r.expect === "DENY" && r.ok).length;
  const ok = results.length > 0 && results.every((r) => r.ok) && verify.ok && verify.records === before + results.length && allowExpected > 0 && denyExpected > 0;

  if (temp) rmSync(temp, { recursive: true, force: true });

  return {
    manifest_path: manifestPath,
    agent_id: manifest.agent_id,
    purpose_id: manifest.purpose_id,
    hook_path: hookPath,
    chain_path: chainPath,
    cases: results,
    skipped,
    verify,
    ok,
    summary: { allow_expected: allowExpected, allow_ok: allowOk, deny_expected: denyExpected, deny_ok: denyOk },
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);
}

function describeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (["content", "old_string", "new_string", "prompt"].includes(k)) continue;
    parts.push(`${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  }
  return parts.join(" ");
}

export function formatProbeTable(r: ProbeResult): string {
  const lines: string[] = [];
  lines.push(`probe ${r.agent_id} (${r.purpose_id}) via ${r.hook_path}`);
  lines.push(`${pad("#", 7)} ${pad("expect", 6)} ${pad("got", 9)} ${pad("seq", 4)} ${pad("tool", 22)} ${pad("call", 46)} why`);
  for (const c of r.cases) {
    const mark = c.ok ? " " : "!";
    lines.push(`${mark}${pad(c.id, 6)} ${pad(c.expect, 6)} ${pad(c.got, 9)} ${pad(c.seq === null ? "-" : String(c.seq), 4)} ${pad(c.tool, 22)} ${pad(describeArgs(c.args), 46)} ${c.why}`);
  }
  for (const s of r.skipped) lines.push(`  skipped: ${s}`);
  lines.push(
    `allow ${r.summary.allow_ok}/${r.summary.allow_expected}, deny ${r.summary.deny_ok}/${r.summary.deny_expected}, chain ${r.verify.ok ? "verified" : "BROKEN"} (${r.verify.records} records)${r.verify.error ? `: ${r.verify.error}` : ""}`,
  );
  lines.push(r.ok ? "PROBE OK" : "PROBE FAILED");
  return lines.join("\n");
}
