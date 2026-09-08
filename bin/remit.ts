#!/usr/bin/env -S node --import tsx
/**
 * remit CLI.
 *
 *   remit check <manifest>
 *   remit compile <manifest> [--target cedar|claude-code|all] [--out <dir>] [--hook-command <cmd>]
 *   remit authorize <manifest> --tool <name> [--arg key=value ...] [--path <p>] [--now <iso>]
 *
 * Exit codes: 0 ok / allow, 2 deny, 1 error or invalid manifest.
 */

import { authorize } from "../src/authorize.js";
import { compileManifest, isTarget, renderOutputs, writeOutputs, type Target } from "../src/compile/index.js";
import { loadManifest, ManifestError, manifestVersion } from "../src/manifest.js";

interface Parsed {
  command: string;
  positional: string[];
  flags: Record<string, string | string[] | true>;
}

function parseArgs(argv: string[]): Parsed {
  const [command = "", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | string[] | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    const next = rest[i + 1];
    const value = next !== undefined && !next.startsWith("--") ? next : undefined;
    if (value !== undefined) i++;
    if (name === "arg") {
      const list = Array.isArray(flags[name]) ? (flags[name] as string[]) : [];
      if (value !== undefined) list.push(value);
      flags[name] = list;
    } else {
      flags[name] = value ?? true;
    }
  }
  return { command, positional, flags };
}

function usage(): never {
  process.stderr.write(
    [
      "usage:",
      "  remit check <manifest>",
      "  remit compile <manifest> [--target cedar|claude-code|all] [--out <dir>] [--hook-command <cmd>]",
      "  remit authorize <manifest> --tool <name> [--arg key=value ...] [--path <p>] [--now <iso>]",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

function str(flag: string | string[] | true | undefined): string | undefined {
  return typeof flag === "string" ? flag : undefined;
}

function main(argv: string[]): number {
  const { command, positional, flags } = parseArgs(argv);
  const manifestPath = positional[0];
  if (!command || !manifestPath) usage();

  let manifest;
  try {
    manifest = loadManifest(manifestPath);
  } catch (e) {
    if (e instanceof ManifestError) {
      process.stderr.write(e.message + "\n");
      return 1;
    }
    throw e;
  }

  if (command === "check") {
    process.stdout.write(
      JSON.stringify({ ok: true, agent_id: manifest.agent_id, purpose_id: manifest.purpose_id, policy_version: manifestVersion(manifest), tools: manifest.allowed_tools.map((t) => t.name) }, null, 2) + "\n",
    );
    return 0;
  }

  if (command === "compile") {
    const targetFlag = str(flags["target"]) ?? "all";
    if (!isTarget(targetFlag)) {
      process.stderr.write(`unknown target ${JSON.stringify(targetFlag)}; use cedar, claude-code, or all\n`);
      return 1;
    }
    const target: Target = targetFlag;
    const out = str(flags["out"]) ?? `out/${manifest.agent_id}`;
    const hookCommand = str(flags["hook-command"]);
    const result = compileManifest(manifest, hookCommand !== undefined ? { manifestPath, hookCommand } : { manifestPath });
    const files = renderOutputs(result, target);
    const written = writeOutputs(out, files);
    process.stdout.write(
      JSON.stringify({ ok: true, policy_version: result.policy_version, policies: Object.keys(result.cedar.policies), regex_tools: result.cedar.regex_tools, written }, null, 2) + "\n",
    );
    return 0;
  }

  if (command === "authorize") {
    const tool = str(flags["tool"]);
    if (!tool) usage();
    const args: Record<string, unknown> = {};
    for (const kv of (flags["arg"] as string[] | undefined) ?? []) {
      const eq = kv.indexOf("=");
      if (eq <= 0) {
        process.stderr.write(`bad --arg ${JSON.stringify(kv)}; expected key=value\n`);
        return 1;
      }
      args[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    const nowFlag = str(flags["now"]);
    const now = nowFlag !== undefined ? new Date(nowFlag) : undefined;
    if (now !== undefined && Number.isNaN(now.getTime())) {
      process.stderr.write(`bad --now ${JSON.stringify(nowFlag)}\n`);
      return 1;
    }
    const compiled = compileManifest(manifest, { manifestPath }).cedar;
    const request: Parameters<typeof authorize>[2] = { tool, args };
    const path = str(flags["path"]);
    if (path !== undefined) request.resourcePath = path;
    if (now !== undefined) request.now = now;
    const decision = authorize(manifest, compiled, request);
    process.stdout.write(JSON.stringify(decision, null, 2) + "\n");
    return decision.decision === "allow" ? 0 : 2;
  }

  usage();
}

process.exit(main(process.argv.slice(2)));
