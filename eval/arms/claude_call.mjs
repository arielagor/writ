// One Claude judge call through the lean-claude seam (tier, never a model id; no ANTHROPIC_API_KEY).
// stdin: {"prompt","system","tier","effort","job","promptId","timeoutMs"}   stdout: one JSON line.
// If the seam falls back to its API-overflow lane (via:"api"), we report it so the caller can stop.
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LEAN = path.join(os.homedir(), ".claude", "scripts", "lib", "lean-claude.mjs");
const { runClaude } = await import(pathToFileURL(LEAN).href);

let raw = "";
for await (const c of process.stdin) raw += c;
const a = JSON.parse(raw);
try {
  const r = await runClaude(a.prompt, {
    job: a.job || "eval:judge", promptId: a.promptId, tier: a.tier || "deep", model: a.model || undefined, effort: a.effort || "medium",
    systemPrompt: a.system, json: true, retries: 1, timeoutMs: a.timeoutMs || 240000,
  });
  process.stdout.write(JSON.stringify({
    ok: true, text: r.text, model: r.model, via: r.via || "cli", cost_usd: r.cost_usd ?? null,
    usage: { input_tokens: r.usage?.input_tokens ?? null, output_tokens: r.usage?.output_tokens ?? null,
      cache_creation: r.usage?.cache_creation_input_tokens ?? null, cache_read: r.usage?.cache_read_input_tokens ?? null },
    duration_ms: r.duration_ms,
  }) + "\n");
} catch (e) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 400), code: e.code || null }) + "\n");
  process.exit(0);
}
