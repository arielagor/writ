// Cedar arm: Writ's real authorize() per item at tiers M0, M1, M2. Deterministic, 0 LLM calls.
// Needs `npm run build` first (imports dist/). Every manifest is validated with Writ's own
// validateManifest (the check behind `writ check`); an invalid manifest aborts the run.
//
//   node eval/arms/cedar_arm.mjs [--items eval/data/items.jsonl] [--manifests eval/data/manifests.json]
//                                [--out eval/results/cedar.jsonl] [--ids id1,id2,...]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVAL = path.dirname(HERE);
const DIST = path.join(EVAL, "..", "dist", "src");
const imp = (p) => import(pathToFileURL(path.join(DIST, p)).href);

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const itemsPath = opt("--items", path.join(EVAL, "data", "items.jsonl"));
const manPath = opt("--manifests", path.join(EVAL, "data", "manifests.json"));
const outPath = opt("--out", path.join(EVAL, "results", "cedar.jsonl"));
const only = opt("--ids", null);

const { validateManifest } = await imp("manifest.js");
const { compileCedar } = await imp("compile/cedar.js");
const { authorize } = await imp("authorize.js");

const NOW = new Date("2026-11-01T00:00:00Z"); // fixed clock: results do not depend on the day of the run
const items = readFileSync(itemsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const manifests = JSON.parse(readFileSync(manPath, "utf8"));
const idSet = only ? new Set(only.split(",")) : null;

const compiled = new Map();
function get(key) {
  if (compiled.has(key)) return compiled.get(key);
  const raw = manifests[key];
  if (!raw) throw new Error(`missing manifest ${key}`);
  const v = validateManifest(raw, { now: NOW });
  if (!v.ok) throw new Error(`manifest ${key} failed validation: ${v.errors.join("; ")}`);
  const c = { manifest: v.manifest, policy: compileCedar(v.manifest) };
  compiled.set(key, c);
  return c;
}

const rows = [];
for (const it of items) {
  if (idSet && !idSet.has(it.item_id)) continue;
  for (const tier of ["M0", "M1", "M2"]) {
    const { manifest, policy } = get(`${tier}:${it.suite}:${it.user_task_id}`);
    const d = authorize(manifest, policy, { tool: it.candidate.tool, args: it.candidate.args, now: NOW });
    rows.push({ item_id: it.item_id, tier, decision: d.decision, reasons: d.reasons, errors: d.errors });
  }
}
mkdirSync(path.dirname(outPath), { recursive: true });
writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(JSON.stringify({ items: new Set(rows.map((r) => r.item_id)).size, rows: rows.length, manifests_validated: compiled.size, out: outPath }));
