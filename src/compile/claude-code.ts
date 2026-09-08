/**
 * Manifest to a Claude Code `settings.json` fragment.
 *
 * Claude Code's `permissions.allow` and `permissions.deny` are advisory in the sense that
 * they cannot express "deny everything else". The fragment therefore does three things:
 *   1. allow rules for exactly the manifest's tools (and path scopes where given);
 *   2. deny rules for the sensitive built-in tools the manifest does not name;
 *   3. a PreToolUse hook on every tool (`.*`) that sends each call through the Writ gate,
 *      which is where deny-by-default actually binds.
 *
 * The hook script itself ships in a later component; the registration is emitted now so the
 * fragment is complete the day the hook lands.
 */

import { normalizePath, type PurposeManifest } from "../manifest.js";

export interface HookCommand {
  type: "command";
  command: string;
  timeout?: number;
}

export interface HookMatcher {
  matcher: string;
  hooks: HookCommand[];
}

export interface ClaudeCodeSettingsFragment {
  permissions: {
    allow: string[];
    deny: string[];
  };
  hooks: {
    PreToolUse: HookMatcher[];
  };
}

export interface ClaudeCodeOptions {
  /** Path the hook will read the manifest from. Emitted verbatim; keep it relative for portability. */
  manifestPath: string;
  /** Override the gate command. Defaults to the bundled hook script. */
  hookCommand?: string;
  /** Seconds before Claude Code gives up on the hook. A timed-out hook is treated as a failure. */
  hookTimeoutSeconds?: number;
}

/** Built-in tools that can change state or reach the network. Denied unless the manifest names them. */
export const SENSITIVE_TOOLS: readonly string[] = [
  "Bash",
  "PowerShell",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Agent",
];

export function defaultHookCommand(manifestPath: string): string {
  return `node hooks/writ-gate.mjs --manifest "${normalizePath(manifestPath)}"`;
}

function allowRules(m: PurposeManifest): string[] {
  const rules: string[] = [];
  for (const tool of m.allowed_tools) {
    const c = tool.constraints;
    if (c?.path_prefixes && c.path_prefixes.length > 0) {
      for (const prefix of c.path_prefixes) {
        rules.push(`${tool.name}(${normalizePath(prefix)}**)`);
      }
      continue;
    }
    const command = c?.arg_allow?.["command"];
    if (tool.name === "Bash" && Array.isArray(command)) {
      for (const v of command) rules.push(`Bash(${v})`);
      continue;
    }
    rules.push(tool.name);
  }
  return rules;
}

function denyRules(m: PurposeManifest): string[] {
  const allowed = new Set(m.allowed_tools.map((t) => t.name));
  return SENSITIVE_TOOLS.filter((t) => !allowed.has(t));
}

export function compileClaudeCode(m: PurposeManifest, opts: ClaudeCodeOptions): ClaudeCodeSettingsFragment {
  const command = opts.hookCommand ?? defaultHookCommand(opts.manifestPath);
  const hook: HookCommand = { type: "command", command, timeout: opts.hookTimeoutSeconds ?? 10 };
  return {
    permissions: {
      allow: allowRules(m),
      deny: denyRules(m),
    },
    hooks: {
      PreToolUse: [{ matcher: ".*", hooks: [hook] }],
    },
  };
}
