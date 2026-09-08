/**
 * The one authorization call every enforcement point makes.
 *
 * Fail closed: a thrown exception, a `failure` answer from the engine, or any error in the
 * engine's diagnostics is a deny with reason `evaluation-error`. The engine never gets the
 * benefit of the doubt, because a gate that allows on error is not a gate.
 *
 * Regex constraints are evaluated here (Cedar has none) and passed as `context.arg_regex_ok`.
 */

import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import { normalizePath, type PurposeManifest } from "./manifest.js";
import type { CedarPolicySet } from "./compile/cedar.js";

export interface AuthorizeRequest {
  /** Tool name exactly as the runtime reports it. */
  tool: string;
  /** The tool's arguments. Only string-valued entries reach Cedar; others are JSON-stringified. */
  args?: Record<string, unknown>;
  /** The resource path. Defaults to file_path / path / notebook_path from args, else the tool name. */
  resourcePath?: string;
  /** The clock. Defaults to the real clock. */
  now?: Date;
}

export interface Decision {
  decision: "allow" | "deny";
  /** Policy ids that determined the decision, plus any regex failures noted by the pre-check. */
  reasons: string[];
  /** Engine errors. Non-empty always means deny. */
  errors: string[];
  evaluated_at: string;
  agent_id: string;
  purpose_id: string;
  policy_version: string;
  tool: string;
  resource: string;
  arg_regex_ok: boolean;
}

export const EVALUATION_ERROR = "evaluation-error";

export function stringifyArgs(args: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!args) return out;
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return out;
}

export function resourceOf(req: AuthorizeRequest): string {
  if (req.resourcePath) return normalizePath(req.resourcePath);
  const args = req.args ?? {};
  for (const key of ["file_path", "path", "notebook_path"]) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return normalizePath(v);
  }
  return req.tool;
}

/** Evaluate the manifest's regex constraints for this tool against the request arguments. */
export function regexCheck(m: PurposeManifest, tool: string, args: Record<string, string>): { ok: boolean; failures: string[] } {
  const spec = m.allowed_tools.find((t) => t.name === tool);
  const failures: string[] = [];
  const c = spec?.constraints;
  if (!c) return { ok: true, failures };

  for (const [key, rule] of Object.entries(c.arg_allow ?? {})) {
    if (typeof rule !== "string") continue;
    const value = args[key];
    if (value === undefined) {
      failures.push(`arg_allow.${key}: argument missing`);
    } else if (!new RegExp(rule).test(value)) {
      failures.push(`arg_allow.${key}: ${JSON.stringify(value)} does not match /${rule}/`);
    }
  }
  for (const [key, rule] of Object.entries(c.arg_deny ?? {})) {
    if (typeof rule !== "string") continue;
    const value = args[key];
    if (value !== undefined && new RegExp(rule).test(value)) {
      failures.push(`arg_deny.${key}: ${JSON.stringify(value)} matches /${rule}/`);
    }
  }
  return { ok: failures.length === 0, failures };
}

/** Build the engine call. Exported so tests can inspect or perturb it. */
export function buildCall(
  m: PurposeManifest,
  compiled: CedarPolicySet,
  req: AuthorizeRequest,
): { call: cedar.AuthorizationCall; resource: string; regex: { ok: boolean; failures: string[] } } {
  const now = req.now ?? new Date();
  const args = stringifyArgs(req.args);
  const resource = resourceOf(req);
  const regex = regexCheck(m, req.tool, args);
  const call: cedar.AuthorizationCall = {
    principal: { type: "Agent", id: m.agent_id },
    action: { type: "Action", id: req.tool },
    resource: { type: "Resource", id: resource },
    context: {
      purpose_id: m.purpose_id,
      now: { __extn: { fn: "datetime", arg: now.toISOString() } },
      args,
      arg_regex_ok: regex.ok,
    },
    policies: { staticPolicies: compiled.policies },
    entities: [{ uid: { type: "Resource", id: resource }, attrs: { path: resource }, parents: [] }],
  };
  return { call, resource, regex };
}

/** Run the engine on a call. Fail closed. */
export function decide(call: cedar.AuthorizationCall): { decision: "allow" | "deny"; reasons: string[]; errors: string[] } {
  let answer: cedar.AuthorizationAnswer;
  try {
    answer = cedar.isAuthorized(call);
  } catch (e) {
    return { decision: "deny", reasons: [EVALUATION_ERROR], errors: [String((e as Error).message ?? e)] };
  }
  if (answer.type === "failure") {
    return { decision: "deny", reasons: [EVALUATION_ERROR], errors: answer.errors.map((e) => e.message) };
  }
  const { decision, diagnostics } = answer.response;
  const errors = diagnostics.errors.map((e) => (typeof e === "string" ? e : JSON.stringify(e)));
  if (errors.length > 0) {
    return { decision: "deny", reasons: [EVALUATION_ERROR, ...diagnostics.reason], errors };
  }
  return { decision, reasons: [...diagnostics.reason], errors: [] };
}

export function authorize(m: PurposeManifest, compiled: CedarPolicySet, req: AuthorizeRequest): Decision {
  const evaluatedAt = (req.now ?? new Date()).toISOString();
  const { call, resource, regex } = buildCall(m, compiled, req);
  const result = decide(call);
  const reasons = [...result.reasons];
  if (result.decision === "deny") reasons.push(...regex.failures.map((f) => `regex: ${f}`));
  return {
    decision: result.decision,
    reasons,
    errors: result.errors,
    evaluated_at: evaluatedAt,
    agent_id: m.agent_id,
    purpose_id: m.purpose_id,
    policy_version: compiled.policy_version,
    tool: req.tool,
    resource,
    arg_regex_ok: regex.ok,
  };
}
