import { test } from "node:test";
import assert from "node:assert/strict";
import { authorize, buildCall, decide, EVALUATION_ERROR } from "../src/authorize.js";
import { compileCedar } from "../src/compile/cedar.js";
import { loadManifest } from "../src/manifest.js";
import { examplePath, NOW } from "./helpers.js";

const blog = loadManifest(examplePath("blog-publisher"), { now: NOW });
const blogPolicies = compileCedar(blog);
const reader = loadManifest(examplePath("gbrain-reader"), { now: NOW });
const readerPolicies = compileCedar(reader);

const POSTS = "/workspace/blog/posts/";

test("allow: Write under the allowed prefix, in purpose, before expiry", () => {
  const d = authorize(blog, blogPolicies, { tool: "Write", args: { file_path: `${POSTS}2026-09-09-post.mdx` }, now: NOW });
  assert.equal(d.decision, "allow");
  assert.deepEqual(d.reasons, ["agorme-blog-publish.Write"]);
  assert.deepEqual(d.errors, []);
  assert.equal(d.policy_version, blogPolicies.policy_version);
});

test("deny: Write outside the allowed prefix", () => {
  const d = authorize(blog, blogPolicies, { tool: "Write", args: { file_path: "/workspace/settings.json" }, now: NOW });
  assert.equal(d.decision, "deny");
  assert.deepEqual(d.reasons, []);
});

test("deny: a backslash path is normalized before matching, so the prefix still applies", () => {
  const inside = authorize(blog, blogPolicies, { tool: "Write", args: { file_path: `\\workspace\\blog\\posts\\x.mdx` }, now: NOW });
  assert.equal(inside.decision, "allow");
  const outside = authorize(blog, blogPolicies, { tool: "Write", args: { file_path: `\\workspace\\hooks\\x.mjs` }, now: NOW });
  assert.equal(outside.decision, "deny");
});

test("deny: a tool the manifest does not name (Bash) has no permit at all", () => {
  const d = authorize(blog, blogPolicies, { tool: "Bash", args: { command: "echo hi" }, now: NOW });
  assert.equal(d.decision, "deny");
  assert.deepEqual(d.reasons, []);
});

test("deny: after expiry, and the expiry forbid is the named reason", () => {
  const d = authorize(blog, blogPolicies, { tool: "Write", args: { file_path: `${POSTS}late.mdx` }, now: new Date("2027-04-01T00:00:00Z") });
  assert.equal(d.decision, "deny");
  assert.ok(d.reasons.includes("agorme-blog-publish.expired"));
});

test("deny: regex arg_deny blocks an env file even under the allowed prefix", () => {
  const d = authorize(blog, blogPolicies, { tool: "Edit", args: { file_path: `${POSTS}.env.local` }, now: NOW });
  assert.equal(d.decision, "deny");
  assert.equal(d.arg_regex_ok, false);
  assert.ok(d.reasons.some((r) => r.startsWith("regex: arg_deny.file_path")));
});

test("allow: Edit of a normal post passes the same regex constraint", () => {
  const d = authorize(blog, blogPolicies, { tool: "Edit", args: { file_path: `${POSTS}2026-09-09-post.mdx`, old_string: "a", new_string: "b" }, now: NOW });
  assert.equal(d.decision, "allow");
  assert.equal(d.arg_regex_ok, true);
});

test("exact-value arg_allow: detail low is allowed, high is denied, absent is denied", () => {
  const low = authorize(blog, blogPolicies, { tool: "mcp__gbrain__query", args: { query: "x", detail: "low" }, now: NOW });
  const high = authorize(blog, blogPolicies, { tool: "mcp__gbrain__query", args: { query: "x", detail: "high" }, now: NOW });
  const absent = authorize(blog, blogPolicies, { tool: "mcp__gbrain__query", args: { query: "x" }, now: NOW });
  assert.equal(low.decision, "allow");
  assert.equal(high.decision, "deny");
  assert.equal(absent.decision, "deny");
});

test("regex arg_allow: limit 10 is allowed, 500 is denied, a non-string is stringified first", () => {
  const ten = authorize(reader, readerPolicies, { tool: "mcp__gbrain__query", args: { query: "x", limit: 10 }, now: NOW });
  const big = authorize(reader, readerPolicies, { tool: "mcp__gbrain__query", args: { query: "x", limit: 500 }, now: NOW });
  assert.equal(ten.decision, "allow");
  assert.equal(big.decision, "deny");
  assert.ok(big.reasons.some((r) => r.includes("arg_allow.limit")));
});

test("regex arg_deny: a secrets slug is denied, a people slug is allowed", () => {
  const secret = authorize(reader, readerPolicies, { tool: "mcp__gbrain__get_page", args: { slug: "secrets/aws" }, now: NOW });
  const person = authorize(reader, readerPolicies, { tool: "mcp__gbrain__get_page", args: { slug: "people/ariel-agor" }, now: NOW });
  assert.equal(secret.decision, "deny");
  assert.equal(person.decision, "allow");
});

test("allow: a tool without constraints only needs purpose and expiry", () => {
  const d = authorize(reader, readerPolicies, { tool: "mcp__gbrain__search", args: { query: "anything" }, now: NOW });
  assert.equal(d.decision, "allow");
  assert.equal(d.resource, "mcp__gbrain__search");
});

test("deny: a purpose mismatch in context trips the named forbid", () => {
  const { call } = buildCall(reader, readerPolicies, { tool: "mcp__gbrain__search", args: { query: "x" }, now: NOW });
  call.context = { ...call.context, purpose_id: "some-other-purpose" };
  const r = decide(call);
  assert.equal(r.decision, "deny");
  assert.ok(r.reasons.includes("gbrain-read-only.purpose-mismatch"));
});

test("fail closed: an unparseable policy set is a deny with evaluation-error, not an exception", () => {
  const { call } = buildCall(reader, readerPolicies, { tool: "mcp__gbrain__search", args: { query: "x" }, now: NOW });
  call.policies = { staticPolicies: { broken: "permit(principal, action, resource) when { ;" } };
  const r = decide(call);
  assert.equal(r.decision, "deny");
  assert.ok(r.reasons.includes(EVALUATION_ERROR));
  assert.ok(r.errors.length >= 1);
});

test("fail closed: an engine error during evaluation is a deny even if the request would otherwise pass", () => {
  const { call, resource } = buildCall(blog, blogPolicies, { tool: "Write", args: { file_path: `${POSTS}ok.mdx` }, now: NOW });
  call.entities = [{ uid: { type: "Resource", id: resource }, attrs: {}, parents: [] }];
  const r = decide(call);
  assert.equal(r.decision, "deny");
  assert.ok(r.reasons.includes(EVALUATION_ERROR));
  assert.ok(r.errors.length >= 1);
});

test("fail closed: a missing clock value in context is a deny", () => {
  const { call } = buildCall(reader, readerPolicies, { tool: "mcp__gbrain__search", args: { query: "x" }, now: NOW });
  const ctx = { ...call.context };
  delete ctx["now"];
  call.context = ctx;
  const r = decide(call);
  assert.equal(r.decision, "deny");
});

test("the decision record names agent, purpose, version, tool and resource", () => {
  const d = authorize(blog, blogPolicies, { tool: "Write", args: { file_path: `${POSTS}a.mdx` }, now: NOW });
  assert.equal(d.agent_id, "blog-publisher");
  assert.equal(d.purpose_id, "agorme-blog-publish");
  assert.equal(d.tool, "Write");
  assert.equal(d.resource, `${POSTS}a.mdx`);
  assert.equal(d.evaluated_at, NOW.toISOString());
});
