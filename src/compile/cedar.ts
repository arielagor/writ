/**
 * Manifest to Cedar.
 *
 * One named `permit` per allowed tool, one `forbid` on purpose mismatch, one `forbid` after
 * expiry. Every policy carries @id, @purpose_id, @policy_version and (for permits) @tool, so
 * a decision's diagnostics name the exact rule and manifest version that produced it.
 *
 * Entity model:
 *   principal  Agent::"<agent_id>"
 *   action     Action::"<tool name>"
 *   resource   Resource::"<path or tool target>"  with attribute `path`
 *   context    purpose_id (string), now (datetime), args (record of strings), arg_regex_ok (bool)
 *
 * Cedar has no regular expressions. A regex constraint is evaluated by `authorize()` before
 * the engine runs and arrives as `context.arg_regex_ok`; the permit for that tool requires it.
 * See docs/decisions/2026-09-08-writ-foundation.md.
 */

import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import { manifestVersion, normalizePath, type AllowedTool, type PurposeManifest } from "../manifest.js";

export interface CedarPolicySet {
  agent_id: string;
  purpose_id: string;
  /** sha256 of the canonical manifest. */
  policy_version: string;
  /** UTC ISO 8601, as compiled into the policies. */
  expires_at: string;
  /** Tools whose permit depends on the pre-evaluated regex check. */
  regex_tools: string[];
  /** Policy id to policy text. This is what the authorizer loads. */
  policies: Record<string, string>;
  /** All policies concatenated, for humans and for engines that take a policy set string. */
  text: string;
}

/** Escape a string for a Cedar string literal. */
export function cedarString(s: string): string {
  return (
    '"' +
    s
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t") +
    '"'
  );
}

/** Escape a string for use inside a Cedar `like` pattern; a literal `*` becomes `\*`. */
export function cedarPatternLiteral(s: string): string {
  const inner = cedarString(s).slice(1, -1);
  return '"' + inner.replace(/\*/g, "\\*");
}

export function policyId(m: PurposeManifest, tool: string): string {
  return `${m.purpose_id}.${tool}`;
}

/** Normalize the manifest expiry to a UTC datetime literal Cedar accepts. */
export function expiryLiteral(m: PurposeManifest): string {
  return new Date(m.expires_at).toISOString();
}

function annotations(m: PurposeManifest, version: string, id: string, tool?: string): string {
  const lines = [`@id(${cedarString(id)})`, `@purpose_id(${cedarString(m.purpose_id)})`, `@policy_version(${cedarString(version)})`];
  if (tool !== undefined) lines.push(`@tool(${cedarString(tool)})`);
  return lines.join("\n");
}

function argAccess(key: string): string {
  return `context.args[${cedarString(key)}]`;
}

function argHas(key: string): string {
  return `context.args has ${cedarString(key)}`;
}

function setLiteral(values: string[]): string {
  return "[" + values.map(cedarString).join(", ") + "]";
}

/** Build the `when` clauses for one tool. Returns the clauses and whether a regex check is needed. */
export function toolClauses(m: PurposeManifest, tool: AllowedTool): { clauses: string[]; needsRegex: boolean } {
  const clauses: string[] = [
    `context.purpose_id == ${cedarString(m.purpose_id)}`,
    `context.now < datetime(${cedarString(expiryLiteral(m))})`,
  ];
  let needsRegex = false;
  const c = tool.constraints;
  if (!c) return { clauses, needsRegex };

  if (c.path_prefixes && c.path_prefixes.length > 0) {
    const alts = c.path_prefixes.map((p) => `resource.path like ${cedarPatternLiteral(normalizePath(p))}*"`);
    clauses.push(alts.length === 1 ? alts[0]! : `(${alts.join(" || ")})`);
  }

  for (const [key, rule] of Object.entries(c.arg_allow ?? {})) {
    if (Array.isArray(rule)) {
      clauses.push(`${argHas(key)} && ${setLiteral(rule)}.contains(${argAccess(key)})`);
    } else {
      needsRegex = true;
    }
  }

  for (const [key, rule] of Object.entries(c.arg_deny ?? {})) {
    if (Array.isArray(rule)) {
      clauses.push(`!(${argHas(key)} && ${setLiteral(rule)}.contains(${argAccess(key)}))`);
    } else {
      needsRegex = true;
    }
  }

  if (needsRegex) clauses.push("context.arg_regex_ok == true");
  return { clauses, needsRegex };
}

function permitFor(m: PurposeManifest, version: string, tool: AllowedTool): { id: string; text: string; needsRegex: boolean } {
  const id = policyId(m, tool.name);
  const { clauses, needsRegex } = toolClauses(m, tool);
  const text = [
    annotations(m, version, id, tool.name),
    "permit(",
    `  principal == Agent::${cedarString(m.agent_id)},`,
    `  action == Action::${cedarString(tool.name)},`,
    "  resource",
    ")",
    "when {",
    "  " + clauses.join(" &&\n  "),
    "};",
  ].join("\n");
  return { id, text, needsRegex };
}

function forbidMismatch(m: PurposeManifest, version: string): { id: string; text: string } {
  const id = `${m.purpose_id}.purpose-mismatch`;
  const text = [
    annotations(m, version, id),
    "forbid(",
    `  principal == Agent::${cedarString(m.agent_id)},`,
    "  action,",
    "  resource",
    ")",
    "unless {",
    `  context.purpose_id == ${cedarString(m.purpose_id)}`,
    "};",
  ].join("\n");
  return { id, text };
}

function forbidExpired(m: PurposeManifest, version: string): { id: string; text: string } {
  const id = `${m.purpose_id}.expired`;
  const text = [
    annotations(m, version, id),
    "forbid(",
    `  principal == Agent::${cedarString(m.agent_id)},`,
    "  action,",
    "  resource",
    ")",
    "when {",
    `  context.now >= datetime(${cedarString(expiryLiteral(m))})`,
    "};",
  ].join("\n");
  return { id, text };
}

/** Compile a validated manifest. Throws if Cedar rejects the result, so a bad emit never ships. */
export function compileCedar(m: PurposeManifest): CedarPolicySet {
  const version = manifestVersion(m);
  const policies: Record<string, string> = {};
  const regexTools: string[] = [];

  for (const tool of m.allowed_tools) {
    const p = permitFor(m, version, tool);
    policies[p.id] = p.text;
    if (p.needsRegex) regexTools.push(tool.name);
  }
  const mismatch = forbidMismatch(m, version);
  policies[mismatch.id] = mismatch.text;
  const expired = forbidExpired(m, version);
  policies[expired.id] = expired.text;

  const parsed = cedar.checkParsePolicySet({ staticPolicies: policies });
  if (parsed.type === "failure") {
    const msgs = parsed.errors.map((e) => e.message).join("; ");
    throw new Error(`compiled Cedar policy set failed to parse: ${msgs}`);
  }

  const header = [
    `// Writ policy set for agent ${m.agent_id}, purpose ${m.purpose_id}`,
    `// policy_version ${version}`,
    `// expires ${expiryLiteral(m)}`,
    "// Generated from the purpose manifest. Edit the manifest, not this file.",
    "",
  ].join("\n");
  const text = header + Object.values(policies).join("\n\n") + "\n";

  return {
    agent_id: m.agent_id,
    purpose_id: m.purpose_id,
    policy_version: version,
    expires_at: expiryLiteral(m),
    regex_tools: regexTools,
    policies,
    text,
  };
}
