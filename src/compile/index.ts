/**
 * Compile entry point: manifest file in, artifacts out.
 *
 * Artifacts (per target):
 *   cedar        policies.cedar, policyset.json
 *   claude-code  claude-code.settings.json
 *   all          both of the above plus manifest.lock.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, loadManifest, manifestVersion, type PurposeManifest, type ValidateOptions } from "../manifest.js";
import { compileCedar, type CedarPolicySet } from "./cedar.js";
import { compileClaudeCode, type ClaudeCodeOptions, type ClaudeCodeSettingsFragment } from "./claude-code.js";

export type Target = "cedar" | "claude-code" | "all";

export const TARGETS: readonly Target[] = ["cedar", "claude-code", "all"];

export function isTarget(s: string): s is Target {
  return (TARGETS as readonly string[]).includes(s);
}

export interface CompileOptions extends ValidateOptions {
  /** Path recorded in the Claude Code hook registration. Keep it relative. */
  manifestPath: string;
  hookCommand?: string;
}

export interface CompileResult {
  manifest: PurposeManifest;
  policy_version: string;
  cedar: CedarPolicySet;
  claudeCode: ClaudeCodeSettingsFragment;
}

export function compileManifest(m: PurposeManifest, opts: CompileOptions): CompileResult {
  const ccOpts: ClaudeCodeOptions = { manifestPath: opts.manifestPath };
  if (opts.hookCommand !== undefined) ccOpts.hookCommand = opts.hookCommand;
  return {
    manifest: m,
    policy_version: manifestVersion(m),
    cedar: compileCedar(m),
    claudeCode: compileClaudeCode(m, ccOpts),
  };
}

export function compileFile(path: string, opts: Omit<CompileOptions, "manifestPath"> & { manifestPath?: string } = {}): CompileResult {
  const validate: ValidateOptions = {};
  if (opts.now !== undefined) validate.now = opts.now;
  const manifest = loadManifest(path, validate);
  const full: CompileOptions = { manifestPath: opts.manifestPath ?? path };
  if (opts.hookCommand !== undefined) full.hookCommand = opts.hookCommand;
  if (opts.now !== undefined) full.now = opts.now;
  return compileManifest(manifest, full);
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

/** Render the artifacts for a target as file name to file content. Deterministic. */
export function renderOutputs(result: CompileResult, target: Target): Record<string, string> {
  const files: Record<string, string> = {};
  if (target === "cedar" || target === "all") {
    files["policies.cedar"] = result.cedar.text;
    files["policyset.json"] = pretty({
      agent_id: result.cedar.agent_id,
      purpose_id: result.cedar.purpose_id,
      policy_version: result.cedar.policy_version,
      expires_at: result.cedar.expires_at,
      regex_tools: result.cedar.regex_tools,
      policies: result.cedar.policies,
    });
  }
  if (target === "claude-code" || target === "all") {
    files["claude-code.settings.json"] = pretty(result.claudeCode);
  }
  if (target === "all") {
    files["manifest.lock.json"] = pretty({
      policy_version: result.policy_version,
      manifest: JSON.parse(canonicalJson(result.manifest)) as unknown,
    });
  }
  return files;
}

export function writeOutputs(dir: string, files: Record<string, string>): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    writeFileSync(path, content, "utf8");
    written.push(path.replace(/\\/g, "/"));
  }
  return written;
}

export { compileCedar, compileClaudeCode };
export type { CedarPolicySet, ClaudeCodeSettingsFragment };
