import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as parseYaml } from "yaml";
import {
  canonicalJson,
  loadManifest,
  ManifestError,
  manifestVersion,
  parseManifest,
  validateManifest,
} from "../src/manifest.js";
import { examplePath, NOW, readExampleText } from "./helpers.js";

function base(): Record<string, unknown> {
  return parseYaml(readExampleText("gbrain-reader")) as Record<string, unknown>;
}

function errorsOf(input: unknown, now: Date = NOW): string[] {
  const r = validateManifest(input, { now });
  return r.ok ? [] : r.errors;
}

test("blog-publisher example loads with three tools and the deny literal", () => {
  const m = loadManifest(examplePath("blog-publisher"), { now: NOW });
  assert.equal(m.agent_id, "blog-publisher");
  assert.deepEqual(
    m.allowed_tools.map((t) => t.name),
    ["Write", "Edit", "mcp__gbrain__query"],
  );
  assert.equal(m.deny_by_default, true);
  assert.equal(m.credential_ttl_seconds, 900);
});

test("gbrain-reader example loads", () => {
  const m = loadManifest(examplePath("gbrain-reader"), { now: NOW });
  assert.equal(m.purpose_id, "gbrain-read-only");
  assert.deepEqual(m.data_classes, ["personal-notes", "contacts"]);
});

test("defaults are applied: credential_ttl_seconds 3600 and empty data_classes", () => {
  const input = base();
  delete input["credential_ttl_seconds"];
  delete input["data_classes"];
  const r = validateManifest(input, { now: NOW });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.manifest.credential_ttl_seconds, 3600);
    assert.deepEqual(r.manifest.data_classes, []);
  }
});

test("validation does not mutate the caller's object", () => {
  const input = base();
  delete input["credential_ttl_seconds"];
  validateManifest(input, { now: NOW });
  assert.equal(input["credential_ttl_seconds"], undefined);
});

test("missing purpose is rejected", () => {
  const input = base();
  delete input["purpose"];
  const errors = errorsOf(input);
  assert.ok(errors.some((e) => /purpose/.test(e)), errors.join("\n"));
});

test("deny_by_default must be literally true", () => {
  const input = base();
  input["deny_by_default"] = false;
  const errors = errorsOf(input);
  assert.ok(errors.some((e) => e.startsWith("/deny_by_default")), errors.join("\n"));
});

test("an invalid regular expression is rejected with its location", () => {
  const input = base();
  const tools = input["allowed_tools"] as Array<Record<string, unknown>>;
  tools[0] = { name: "mcp__gbrain__query", constraints: { arg_allow: { limit: "([" } } };
  const errors = errorsOf(input);
  assert.ok(errors.some((e) => e.includes("invalid regular expression") && e.includes("/allowed_tools/0/constraints/arg_allow/limit")), errors.join("\n"));
});

test("an expired manifest is rejected", () => {
  const errors = errorsOf(base(), new Date("2027-01-01T00:00:00Z"));
  assert.ok(errors.some((e) => e.includes("expired")), errors.join("\n"));
});

test("a manifest expiring in the future passes the same check", () => {
  assert.deepEqual(errorsOf(base(), new Date("2026-12-31T23:59:58Z")), []);
});

test("duplicate tool names are rejected", () => {
  const input = base();
  const tools = input["allowed_tools"] as Array<Record<string, unknown>>;
  tools.push({ name: "mcp__gbrain__search" });
  const errors = errorsOf(input);
  assert.ok(errors.some((e) => e.includes("duplicate tool")), errors.join("\n"));
});

test("unknown top-level keys are rejected", () => {
  const input = base();
  input["allow_everything"] = true;
  const errors = errorsOf(input);
  assert.ok(errors.some((e) => e.includes("additional properties") && e.includes("allow_everything")), errors.join("\n"));
});

test("a malformed owner email is rejected", () => {
  const input = base();
  (input["owner"] as Record<string, unknown>)["email"] = "not-an-email";
  const errors = errorsOf(input);
  assert.ok(errors.some((e) => e.startsWith("/owner/email")), errors.join("\n"));
});

test("backslashes in path_prefixes are rejected", () => {
  const input = base();
  const tools = input["allowed_tools"] as Array<Record<string, unknown>>;
  tools[1] = { name: "mcp__gbrain__search", constraints: { path_prefixes: ["C:\\Users\\x\\"] } };
  const errors = errorsOf(input);
  assert.ok(errors.some((e) => e.includes("forward slashes")), errors.join("\n"));
});

test("a bad tool name pattern is rejected", () => {
  const input = base();
  const tools = input["allowed_tools"] as Array<Record<string, unknown>>;
  tools[1] = { name: "rm -rf" };
  const errors = errorsOf(input);
  assert.ok(errors.some((e) => e.startsWith("/allowed_tools/1/name")), errors.join("\n"));
});

test("non-object input is rejected without throwing", () => {
  assert.equal(validateManifest("yes", { now: NOW }).ok, false);
  assert.equal(validateManifest(null, { now: NOW }).ok, false);
  assert.equal(validateManifest([1], { now: NOW }).ok, false);
});

test("parseManifest throws ManifestError carrying every error", () => {
  const text = readExampleText("gbrain-reader").replace("purpose_id: gbrain-read-only", "purpose_id: Bad Slug");
  assert.throws(
    () => parseManifest(text, { now: NOW }),
    (e: unknown) => e instanceof ManifestError && e.errors.length >= 1 && e.errors[0]!.startsWith("/purpose_id"),
  );
});

test("parseManifest reports YAML syntax errors as a manifest error", () => {
  assert.throws(() => parseManifest("agent_id: [unclosed", { now: NOW }), ManifestError);
});

test("the policy version ignores YAML formatting and key order", () => {
  const a = parseManifest(readExampleText("gbrain-reader"), { now: NOW });
  const reordered = parseYaml(readExampleText("gbrain-reader")) as Record<string, unknown>;
  const shuffled: Record<string, unknown> = {};
  for (const key of Object.keys(reordered).reverse()) shuffled[key] = reordered[key];
  const b = validateManifest(shuffled, { now: NOW });
  assert.equal(b.ok, true);
  if (b.ok) assert.equal(manifestVersion(b.manifest), manifestVersion(a));
  assert.match(manifestVersion(a), /^[0-9a-f]{64}$/);
});

test("the policy version changes when a rule changes", () => {
  const a = parseManifest(readExampleText("gbrain-reader"), { now: NOW });
  const changed = base();
  const tools = changed["allowed_tools"] as Array<Record<string, unknown>>;
  tools.push({ name: "Bash" });
  const b = validateManifest(changed, { now: NOW });
  assert.equal(b.ok, true);
  if (b.ok) assert.notEqual(manifestVersion(b.manifest), manifestVersion(a));
});

test("canonicalJson sorts keys at every depth", () => {
  assert.equal(canonicalJson({ b: { z: 1, a: [{ y: 2, x: 1 }] }, a: 0 }), '{"a":0,"b":{"a":[{"x":1,"y":2}],"z":1}}');
});
