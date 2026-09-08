import { test } from "node:test";
import assert from "node:assert/strict";
import { generateCases } from "../src/probe/cases.js";
import { formatProbeTable, runProbe } from "../src/probe/run.js";
import { loadManifest } from "../src/manifest.js";
import { examplePath, NOW } from "./helpers.js";

// Tests exercise the TypeScript sources. CI exercises the built dist/ in separate steps.
process.env["WRIT_HOOK_PREFER"] = "src";

test("generateCases: both examples yield in-purpose and out-of-purpose cases with nothing skipped", () => {
  for (const name of ["blog-publisher", "gbrain-reader"]) {
    const m = loadManifest(examplePath(name), { now: NOW });
    const { cases, skipped } = generateCases(m);
    assert.deepEqual(skipped, [], `${name}: ${skipped.join("; ")}`);
    const ins = cases.filter((c) => c.kind === "in");
    const outs = cases.filter((c) => c.kind === "out");
    assert.equal(ins.length, m.allowed_tools.length, `${name}: one in-purpose case per allowed tool`);
    assert.ok(outs.length >= 4, `${name}: expected several out-of-purpose cases, got ${outs.length}`);
    for (const c of cases) assert.equal(c.expect, c.kind === "in" ? "ALLOW" : "DENY");
  }
});

test("generateCases: the blog manifest's out-of-purpose set covers prefix escape, arg_deny, arg_allow, unknown tool, and sensitive built-ins", () => {
  const m = loadManifest(examplePath("blog-publisher"), { now: NOW });
  const whys = generateCases(m).cases.filter((c) => c.kind === "out").map((c) => c.why);
  for (const needle of ["path outside", "hits arg_deny", "misses arg_allow", "tool not named", "sensitive built-in"]) {
    assert.ok(whys.some((w) => w.includes(needle)), `missing an out case for: ${needle}`);
  }
});

for (const name of ["blog-publisher", "gbrain-reader"]) {
  test(`probe ${name}: every case goes through the real hook process; allows allow, denies deny, chain verifies`, () => {
    const r = runProbe(examplePath(name));
    const table = formatProbeTable(r);
    assert.equal(r.ok, true, table);
    assert.ok(r.summary.allow_expected > 0 && r.summary.deny_expected > 0);
    assert.equal(r.summary.allow_ok, r.summary.allow_expected);
    assert.equal(r.summary.deny_ok, r.summary.deny_expected);
    assert.equal(r.verify.ok, true);
    assert.equal(r.verify.records, r.cases.length);
    for (const c of r.cases) assert.equal(c.got, c.expect, `${c.id} ${c.tool}: ${c.reason}`);
    assert.match(table, /PROBE OK/);
  });
}
