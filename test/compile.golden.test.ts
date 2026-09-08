import { test } from "node:test";
import assert from "node:assert/strict";
import * as cedar from "@cedar-policy/cedar-wasm/nodejs";
import { compileFile, renderOutputs } from "../src/compile/index.js";
import { examplePath, exampleRelPath, NOW, readGolden } from "./helpers.js";

const EXAMPLES = ["blog-publisher", "gbrain-reader"] as const;
const FILES = ["policies.cedar", "policyset.json", "claude-code.settings.json", "manifest.lock.json"] as const;

for (const name of EXAMPLES) {
  const result = compileFile(examplePath(name), { now: NOW, manifestPath: exampleRelPath(name) });
  const rendered = renderOutputs(result, "all");

  for (const file of FILES) {
    test(`golden: ${name}/${file} is byte-identical`, () => {
      assert.equal(rendered[file], readGolden(name, file));
    });
  }

  test(`compiled policy set for ${name} parses in Cedar`, () => {
    const answer = cedar.checkParsePolicySet({ staticPolicies: result.cedar.policies });
    assert.equal(answer.type, "success");
  });

  test(`every policy for ${name} carries the purpose and version annotations`, () => {
    for (const [id, text] of Object.entries(result.cedar.policies)) {
      assert.ok(text.includes(`@id("${id}")`), id);
      assert.ok(text.includes(`@purpose_id("${result.cedar.purpose_id}")`), id);
      assert.ok(text.includes(`@policy_version("${result.cedar.policy_version}")`), id);
    }
  });
}

test("blog-publisher compiles one permit per tool plus the two forbids", () => {
  const result = compileFile(examplePath("blog-publisher"), { now: NOW, manifestPath: exampleRelPath("blog-publisher") });
  assert.deepEqual(Object.keys(result.cedar.policies), [
    "agorme-blog-publish.Write",
    "agorme-blog-publish.Edit",
    "agorme-blog-publish.mcp__gbrain__query",
    "agorme-blog-publish.purpose-mismatch",
    "agorme-blog-publish.expired",
  ]);
  assert.deepEqual(result.cedar.regex_tools, ["Edit"]);
});

test("claude-code fragment allows only the manifest's tools and denies the sensitive rest", () => {
  const result = compileFile(examplePath("gbrain-reader"), { now: NOW, manifestPath: exampleRelPath("gbrain-reader") });
  assert.deepEqual(result.claudeCode.permissions.allow, ["mcp__gbrain__query", "mcp__gbrain__search", "mcp__gbrain__get_page"]);
  assert.ok(result.claudeCode.permissions.deny.includes("Bash"));
  assert.ok(result.claudeCode.permissions.deny.includes("Write"));
  assert.equal(result.claudeCode.hooks.PreToolUse[0]?.matcher, ".*");
  assert.ok(result.claudeCode.hooks.PreToolUse[0]?.hooks[0]?.command.includes("examples/gbrain-reader.yaml"));
});

test("a path-scoped tool becomes a path-scoped allow rule and is not in the deny list", () => {
  const result = compileFile(examplePath("blog-publisher"), { now: NOW, manifestPath: exampleRelPath("blog-publisher") });
  assert.ok(result.claudeCode.permissions.allow.some((r) => r.startsWith("Write(") && r.endsWith("**)")));
  assert.ok(!result.claudeCode.permissions.deny.includes("Write"));
  assert.ok(result.claudeCode.permissions.deny.includes("Bash"));
});

test("renderOutputs for a single target emits only that target's files", () => {
  const result = compileFile(examplePath("gbrain-reader"), { now: NOW, manifestPath: exampleRelPath("gbrain-reader") });
  assert.deepEqual(Object.keys(renderOutputs(result, "cedar")), ["policies.cedar", "policyset.json"]);
  assert.deepEqual(Object.keys(renderOutputs(result, "claude-code")), ["claude-code.settings.json"]);
});
