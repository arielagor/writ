/**
 * Probe cases: for a manifest, derive calls that must be allowed and calls that must be denied.
 *
 * In-purpose cases come from the manifest's own allowed tools, with arguments chosen to satisfy
 * every constraint. Out-of-purpose cases are the ways a call can fall outside the purpose:
 * a tool the manifest does not name, a path outside an allowed prefix, an argument that hits a
 * deny rule or misses an allow rule, and the sensitive built-ins when they are not named.
 *
 * Choosing a sample value that satisfies a regular expression is done by trying a small pool
 * of candidates against the manifest's own rules. When no candidate fits, the case is reported
 * as skipped rather than invented. The decision itself is never made here; the runner sends
 * every case through the real hook process.
 */

import { SENSITIVE_TOOLS } from "../compile/claude-code.js";
import { normalizePath, type AllowedTool, type PurposeManifest, type ToolConstraints } from "../manifest.js";

export type Expectation = "ALLOW" | "DENY";

export interface ProbeCase {
  id: string;
  kind: "in" | "out";
  tool: string;
  args: Record<string, unknown>;
  expect: Expectation;
  why: string;
}

export interface GeneratedCases {
  cases: ProbeCase[];
  skipped: string[];
}

const ALLOW_POOL = ["1", "10", "50", "low", "medium", "people/probe", "projects/probe", "probe", "probe.mdx", "https://example.com/probe", "main"];
/** For keys that only carry a deny rule, prefer a readable sample over a bare number. */
const DENY_ONLY_POOL = ["people/probe", "projects/probe", "probe", "probe.mdx", "low", "10"];
const DENY_POOL = ["999999", "__not_allowed__", "high", "secrets/probe", "credentials/probe", ".env", ".env.local", "/etc/passwd", "rm -rf /", "sudo -i", "http://169.254.169.254/"];
const UNKNOWN_TOOLS = ["mcp__gbrain__put_page", "Read", "Glob"];

function ruleMatches(rule: string | string[], value: string): boolean {
  return Array.isArray(rule) ? rule.includes(value) : new RegExp(rule).test(value);
}

function satisfies(c: ToolConstraints | undefined, key: string, value: string): boolean {
  if (!c) return true;
  const allow = c.arg_allow?.[key];
  const deny = c.arg_deny?.[key];
  if (allow !== undefined && !ruleMatches(allow, value)) return false;
  if (deny !== undefined && ruleMatches(deny, value)) return false;
  return true;
}

function pick(pool: string[], predicate: (v: string) => boolean): string | undefined {
  return pool.find(predicate);
}

function typicalArgs(tool: string, filePath?: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (filePath !== undefined) args["file_path"] = filePath;
  if (tool === "Write") args["content"] = "probe";
  if (tool === "Edit") {
    args["old_string"] = "a";
    args["new_string"] = "b";
  }
  if (tool === "Bash") args["command"] = "echo probe";
  if (tool === "WebFetch") {
    args["url"] = "https://example.com/";
    args["prompt"] = "probe";
  }
  if (tool === "Agent") args["prompt"] = "probe";
  return args;
}

function prefixOf(c: ToolConstraints | undefined): string | undefined {
  const p = c?.path_prefixes?.[0];
  if (!p) return undefined;
  const n = normalizePath(p);
  return n.endsWith("/") ? n : `${n}/`;
}

/** Arguments that satisfy every constraint of one allowed tool, or the reason none could be built. */
function inPurposeArgs(tool: AllowedTool): { args: Record<string, unknown> } | { skip: string } {
  const c = tool.constraints;
  const prefix = prefixOf(c);
  const args = typicalArgs(tool.name, prefix ? `${prefix}probe.mdx` : undefined);
  const keys = new Set<string>([...Object.keys(c?.arg_allow ?? {}), ...Object.keys(c?.arg_deny ?? {})]);
  for (const key of keys) {
    const current = args[key];
    if (typeof current === "string" && satisfies(c, key, current)) continue;
    const allow = c?.arg_allow?.[key];
    const pool = Array.isArray(allow) ? allow : allow === undefined ? DENY_ONLY_POOL : ALLOW_POOL;
    const candidates = prefix && key === "file_path" ? ALLOW_POOL.map((v) => `${prefix}${v}`) : pool;
    const value = pick(candidates, (v) => satisfies(c, key, v));
    if (value === undefined) return { skip: `${tool.name}: no sample value satisfies the constraints on ${key}` };
    args[key] = value;
  }
  return { args };
}

export function generateCases(m: PurposeManifest): GeneratedCases {
  const cases: ProbeCase[] = [];
  const skipped: string[] = [];
  const allowed = new Set(m.allowed_tools.map((t) => t.name));
  let n = 0;
  const add = (kind: "in" | "out", tool: string, args: Record<string, unknown>, why: string): void => {
    n++;
    cases.push({ id: `${kind}-${n}`, kind, tool, args, expect: kind === "in" ? "ALLOW" : "DENY", why });
  };

  for (const tool of m.allowed_tools) {
    const c = tool.constraints;
    const built = inPurposeArgs(tool);
    if ("skip" in built) {
      skipped.push(built.skip);
      continue;
    }
    add("in", tool.name, built.args, c ? "allowed tool, every constraint satisfied" : "allowed tool, no constraints");

    const prefix = prefixOf(c);
    if (prefix) {
      add("out", tool.name, typicalArgs(tool.name, "/outside-the-purpose/probe.txt"), "path outside every allowed prefix");
    }
    for (const [key, rule] of Object.entries(c?.arg_deny ?? {})) {
      const candidates = prefix && key === "file_path" ? DENY_POOL.map((v) => `${prefix}${v}`) : DENY_POOL;
      const hit = pick(candidates, (v) => ruleMatches(rule, v));
      if (hit === undefined) {
        skipped.push(`${tool.name}: no sample value hits arg_deny.${key}`);
        continue;
      }
      add("out", tool.name, { ...built.args, [key]: hit }, `argument ${key} hits arg_deny`);
    }
    for (const [key, rule] of Object.entries(c?.arg_allow ?? {})) {
      const miss = pick(DENY_POOL, (v) => !ruleMatches(rule, v));
      if (miss === undefined) {
        skipped.push(`${tool.name}: no sample value misses arg_allow.${key}`);
        continue;
      }
      add("out", tool.name, { ...built.args, [key]: miss }, `argument ${key} misses arg_allow`);
    }
  }

  for (const tool of UNKNOWN_TOOLS) {
    if (allowed.has(tool)) continue;
    add("out", tool, typicalArgs(tool, tool === "Read" ? "/workspace/probe.txt" : undefined), "tool not named by the manifest");
    break;
  }
  for (const tool of ["Bash", "Write", "WebFetch", "Agent"]) {
    if (allowed.has(tool) || !SENSITIVE_TOOLS.includes(tool)) continue;
    add("out", tool, typicalArgs(tool, tool === "Write" ? "/tmp/probe.txt" : undefined), "sensitive built-in not named by the manifest");
  }

  return { cases, skipped };
}
