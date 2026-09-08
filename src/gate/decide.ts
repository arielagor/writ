/**
 * The Claude Code PreToolUse gate, as a pure function the hook script calls.
 *
 * One call in, one decision out, one chain record written, always. The rules:
 *
 *   - Identity comes from the harness-supplied hook fields (`agent_type`, `agent_name`) or the
 *     `CLAUDE_AGENT_TYPE` environment variable, never from `tool_input`, which the model writes.
 *   - Fail closed. A missing manifest, an unreadable or invalid manifest, unparseable input, a
 *     thrown authorizer, or a failed chain write is a deny, each with its own reason so the
 *     operator can tell them apart in the log.
 *   - Arguments are never written. The chain record carries their hash and the normalized
 *     resource path (or the tool name when the call has no path), nothing else.
 */

import { authorize, type Decision } from "../authorize.js";
import { appendRecord, hashArgs, type ChainRecord } from "../chain/index.js";
import { compileCedar, type CedarPolicySet } from "../compile/cedar.js";
import { loadManifest, ManifestError, type PurposeManifest } from "../manifest.js";

export interface HookInput {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  agent_type?: string;
  agent_name?: string;
  cwd?: string;
}

export interface GateOptions {
  /** Manifest path. Falls back to `WRIT_MANIFEST`. Missing means deny. */
  manifestPath?: string;
  /** Chain path. Falls back to `WRIT_CHAIN` then `<repo>/data/chain.jsonl`. */
  chainPath?: string;
  /** The clock. Defaults to the real clock. */
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export type GateReasonCode =
  | "allow"
  | "deny"
  | "input-unparseable"
  | "input-missing-tool"
  | "manifest-missing"
  | "manifest-unreadable"
  | "manifest-invalid"
  | "authorizer-error"
  | "chain-write-failed";

export interface GateOutcome {
  decision: "allow" | "deny";
  code: GateReasonCode;
  /** Human-readable, secret-free reason. Goes to the chain and to the hook response. */
  reason: string;
  purpose_id: string;
  agent_id: string;
  tool: string;
  record: ChainRecord | null;
  chain_error: string | null;
  authorization: Decision | null;
}

export const UNRESOLVED = "unresolved";

/** Trusted attribution only: harness fields, then the environment, then "main". */
export function identityOf(input: HookInput | null, env: NodeJS.ProcessEnv): string {
  return input?.agent_type || input?.agent_name || env["CLAUDE_AGENT_TYPE"] || "main";
}

/** Strip argument values out of authorizer reasons, keep policy ids and constraint keys. */
export function redactReasons(d: Decision): string {
  if (d.decision === "allow") {
    return d.reasons.length > 0 ? d.reasons.join("; ") : "permit matched";
  }
  const kept: string[] = [];
  for (const r of d.reasons) {
    if (r.startsWith("regex: ")) {
      const m = /^regex: (arg_(?:allow|deny)\.[^:\s]+)/.exec(r);
      kept.push(m ? `regex: ${m[1]}` : "regex: constraint failed");
    } else {
      kept.push(r);
    }
  }
  if (d.errors.length > 0) kept.push(`engine: ${d.errors[0]!.slice(0, 160)}`);
  if (kept.length === 0) return "no permit matched (deny by default)";
  return kept.join("; ");
}

function parseInput(raw: string | HookInput): { input: HookInput | null; error: string | null } {
  if (typeof raw !== "string") return { input: raw, error: null };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { input: null, error: "hook input is not an object" };
    }
    return { input: parsed as HookInput, error: null };
  } catch (e) {
    return { input: null, error: `hook input is not JSON: ${(e as Error).message}` };
  }
}

type ManifestLoad =
  | { ok: true; manifest: PurposeManifest; compiled: CedarPolicySet }
  | { ok: false; code: "manifest-missing" | "manifest-unreadable" | "manifest-invalid"; reason: string };

function loadForGate(path: string | undefined, now: Date): ManifestLoad {
  if (!path || path.length === 0) {
    return { ok: false, code: "manifest-missing", reason: "no purpose manifest configured (pass --manifest or set WRIT_MANIFEST)" };
  }
  let manifest: PurposeManifest;
  try {
    manifest = loadManifest(path, { now });
  } catch (e) {
    if (e instanceof ManifestError) {
      return { ok: false, code: "manifest-invalid", reason: `purpose manifest invalid: ${e.errors[0] ?? "unknown error"}` };
    }
    return { ok: false, code: "manifest-unreadable", reason: `purpose manifest unreadable: ${(e as Error).message}` };
  }
  try {
    return { ok: true, manifest, compiled: compileCedar(manifest) };
  } catch (e) {
    return { ok: false, code: "manifest-invalid", reason: `purpose manifest did not compile: ${(e as Error).message}` };
  }
}

/**
 * Decide one call and record it. Never throws for the failure modes it knows about; each
 * becomes a deny with a distinct code. Anything else propagates to the hook script, which
 * also denies.
 */
export function decideAndRecord(raw: string | HookInput, opts: GateOptions = {}): GateOutcome {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const manifestPath = opts.manifestPath ?? env["WRIT_MANIFEST"];
  const chainOpts = { chainPath: opts.chainPath ?? env["WRIT_CHAIN"] ?? undefined, now };

  const { input, error: inputError } = parseInput(raw);
  const identity = identityOf(input, env);
  const sessionId = input?.session_id ?? null;
  const toolName = typeof input?.tool_name === "string" && input.tool_name.length > 0 ? input.tool_name : null;
  const argHash = hashArgs(input?.tool_input);

  const loaded = loadForGate(manifestPath, now);
  const agentId = loaded.ok ? loaded.manifest.agent_id : UNRESOLVED;
  const purposeId = loaded.ok ? loaded.manifest.purpose_id : UNRESOLVED;
  const policyVersion = loaded.ok ? loaded.compiled.policy_version : "0".repeat(64);

  const deny = (code: GateReasonCode, reason: string, authorization: Decision | null, resource: string | null): GateOutcome => {
    const base: GateOutcome = {
      decision: "deny",
      code,
      reason,
      purpose_id: purposeId,
      agent_id: agentId,
      tool: toolName ?? "unknown",
      record: null,
      chain_error: null,
      authorization,
    };
    try {
      base.record = appendRecord(
        {
          agent_id: agentId,
          purpose_id: purposeId,
          policy_version: policyVersion,
          tool: toolName ?? "unknown",
          arg_hash: argHash,
          resource,
          identity,
          session_id: sessionId,
          decision: code === "deny" ? "DENY" : "ERROR",
          reason,
        },
        chainOpts,
      );
    } catch (e) {
      base.chain_error = (e as Error).message;
      base.code = "chain-write-failed";
      base.reason = `${reason}; and the audit chain could not be written: ${(e as Error).message}`;
    }
    return base;
  };

  if (inputError) return deny("input-unparseable", inputError, null, null);
  if (!loaded.ok) return deny(loaded.code, loaded.reason, null, null);
  if (!toolName) return deny("input-missing-tool", "hook input has no tool_name", null, null);

  const args = input?.tool_input !== null && typeof input?.tool_input === "object" && !Array.isArray(input.tool_input)
    ? (input.tool_input as Record<string, unknown>)
    : {};

  let authorization: Decision;
  try {
    authorization = authorize(loaded.manifest, loaded.compiled, { tool: toolName, args, now });
  } catch (e) {
    return deny("authorizer-error", `authorizer threw: ${(e as Error).message}`, null, null);
  }

  const reason = redactReasons(authorization);
  if (authorization.decision === "deny") return deny("deny", reason, authorization, authorization.resource);

  const outcome: GateOutcome = {
    decision: "allow",
    code: "allow",
    reason,
    purpose_id: purposeId,
    agent_id: agentId,
    tool: toolName,
    record: null,
    chain_error: null,
    authorization,
  };
  try {
    outcome.record = appendRecord(
      {
        agent_id: agentId,
        purpose_id: purposeId,
        policy_version: policyVersion,
        tool: toolName,
        arg_hash: argHash,
        resource: authorization.resource,
        identity,
        session_id: sessionId,
        decision: "ALLOW",
        reason,
      },
      chainOpts,
    );
  } catch (e) {
    // An allow that cannot be recorded is not an allow. Fail closed.
    outcome.decision = "deny";
    outcome.code = "chain-write-failed";
    outcome.chain_error = (e as Error).message;
    outcome.reason = `audit chain could not be written: ${(e as Error).message}`;
  }
  return outcome;
}

export interface HookResponse {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

/** The JSON Claude Code expects on stdout for a deny; null means allow (print nothing). */
export function hookResponse(outcome: GateOutcome): HookResponse | null {
  if (outcome.decision === "allow") return null;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${outcome.purpose_id}: ${outcome.reason}`,
    },
  };
}
