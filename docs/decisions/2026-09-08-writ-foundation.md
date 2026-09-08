# 2026-09-08: Writ foundation, manifest to Cedar

## Decision

The purpose manifest is the source of truth. It compiles to Cedar policy for engines that speak
Cedar and to a Claude Code `settings.json` fragment for the author's own fleet. A single
authorizer function wraps the Cedar engine and is the only path any enforcement point takes.

## Why a manifest

An enterprise cannot hand-write per-agent policy in four vendors' dialects and keep them in
agreement. A manifest is the one artifact a security owner, an auditor, and the agent's human
owner can all read, and every other artifact is derived from it. The `deny_by_default: true`
field is a required literal, not a default, so a manifest that omits it fails validation. The
point is that the file itself states the posture.

## Why Cedar rather than a home-grown evaluator

- Cedar is deny by default: no matching `permit` means deny, and any matching `forbid` wins.
- Cedar has a real authorizer we can call from Node through `@cedar-policy/cedar-wasm`, so the
  tests prove decisions with the engine rather than with our own reimplementation of it.
- Annotations (`@purpose_id`, `@policy_version`) travel with each policy and come back in
  diagnostics, which the audit chain needs.
- The `datetime` extension expresses expiry inside the policy (`context.now < datetime(...)`),
  so an expired delegation denies in the engine, not in a wrapper.
- Cedar is what Amazon Verified Permissions and several gateways evaluate, so the compiled
  output is portable.

## Why fail closed

The author's existing machine-wide governance gate fails open on an internal error and prints a
`GATE-ERROR` line. That was a deliberate choice for a gate whose purpose was to stop a small
never-class without ever blocking normal work. Writ is the opposite kind of gate: it is the
delegation itself, so an evaluation error means the delegation cannot be established, and the
call is denied. `authorize()` returns `deny` with reason `evaluation-error` for a thrown
exception, a `failure` answer from the engine, or any error entry in the diagnostics.

## Entity model

- principal `Agent::"<agent_id>"`
- action `Action::"<tool_name>"` (the Claude Code or MCP tool name, verbatim)
- resource `Resource::"<path-or-tool-target>"` with attribute `path`
- context: `purpose_id` (string), `now` (datetime), `args` (record of string-valued arguments),
  `arg_regex_ok` (boolean, see limitation below)

Policy ids are `<purpose_id>.<tool_name>` for permits and `<purpose_id>.purpose-mismatch` for
the forbid. The policy version is the sha256 of the canonical JSON of the validated manifest
(keys sorted, defaults applied), so reformatting the YAML does not change the version and
changing any rule does.

## Limitation accepted: regular expressions

Cedar has `like` glob patterns and equality, not regular expressions. The manifest allows a
regex string as an argument constraint because real tool arguments (a git command, a URL) need
one. The compiler cannot express that in Cedar, so:

- exact-value constraints (`arg_allow: {key: ["a", "b"]}`) compile to Cedar set membership;
- path prefixes compile to `resource.path like "<prefix>*"`;
- regex constraints are evaluated by `authorize()` in TypeScript before the engine is called,
  and their combined result is passed as `context.arg_regex_ok`, which every permit for a tool
  carrying a regex constraint requires to be `true`.

The policy therefore names that it depends on a pre-evaluated check, and the check lives in the
one authorizer every enforcement point shares. This is a documented seam, not a hidden one. A
future emitter for a gateway that does support regex can compile the constraint natively.

## Deferred

- A Cedar schema and `validate()` at compile time (the policies are parsed, not schema-validated).
- Cedar templates and template links (one static policy per tool is enough for now).
- Emitters for agentgateway and Pomerium.
- The PreToolUse hook, the MCP proxy and credential broker, the signed audit chain, the probe
  harness, and the evidence export. Each is its own component and its own decision record.
