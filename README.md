# Remit

**Status: prototype, not launched.** Built in the open, on the author's own agent fleet first.

63% of organizations running AI agents in production cannot enforce purpose limitations on them
(2026 governance survey, via Sennovate). They know what the agent is supposed to do. They cannot
technically stop it from doing anything else, because the agent runs as the human who launched it
and inherits every right that human holds. Vendors ship the enforcement point: the harness, the
gateway, the identity provider. Nobody ships the customer's delegation model, the thing that says
which principal each agent acts as, which calls fall inside its purpose, and how to prove it to an
auditor. Remit is that layer.

An agent declares a purpose in a small manifest. Remit compiles it into least-privilege policy for
whatever already enforces calls in your estate, and (in later components) brokers a short-lived
credential per call so the agent never holds a standing key, writes a hash-chained audit record
naming agent, purpose, tool, credential and policy, keeps probing with out-of-purpose calls so the
limit is proven rather than assumed, and exports the evidence an EU AI Act auditor asks for.

## What exists today

- **Purpose manifest** (`schema/manifest.schema.json`, `examples/`): agent, owner, purpose,
  allowed tools with argument and path constraints, data classes, credential TTL, expiry,
  escalation contact. Deny by default is a literal in the file, not a setting.
- **Cedar compiler** (`src/compile/cedar.ts`): one named `permit` per allowed tool plus a
  `forbid` on purpose mismatch, every policy annotated with `@purpose_id` and `@policy_version`
  (sha256 of the canonical manifest). Parsed by Cedar before it is written.
- **Claude Code compiler** (`src/compile/claude-code.ts`): a `settings.json` fragment with the
  allow list, a deny list for sensitive tools the manifest does not name, and a `PreToolUse`
  hook registration that sends every tool call through the gate.
- **Authorizer** (`src/authorize.ts`): the single call every enforcement point makes. An
  evaluation error is a deny.

```
npm install
npm test
npm run remit -- compile examples/blog-publisher.yaml --target all --out out/blog-publisher
```

## What comes next (not built yet)

1. A Claude Code `PreToolUse` hook that evaluates every tool call against the session's
   declared purpose and logs every decision.
2. An MCP proxy that holds the upstream keys and mints a short-lived, downscoped credential per
   call.
3. A hash-linked, signed audit chain with a verifier that fails on any altered record.
4. A probe harness in CI that fires in-purpose and out-of-purpose calls and fails the build
   unless the out-of-purpose calls produce real deny records.
5. An evidence export that answers "which policy allowed that call".

## What this is not

Remit is not an identity provider, not an MCP gateway, and not a new authorization protocol.
It composes with the pieces that already exist and are already shipping:

- **MCP Enterprise-Managed Authorization** and the OAuth **Identity Assertion Authorization
  Grant (ID-JAG)**, as deployed by **Okta Cross App Access** and **Auth0 Token Vault**, answer
  "may this agent reach this resource". Remit consumes that answer; it does not replace it.
- **Arcade, Pomerium, agentgateway, MintMCP** and the other MCP gateways enforce at the wire.
  Remit emits the policy they enforce and records what they decided.
- **Cedar** is the policy language. Remit writes Cedar; it does not invent a language.

Remit answers a narrower question those layers leave to the customer: what is this agent's
purpose, which calls fall inside it, and can you prove it held.

## Background

The problem statement is the author's post
[The Agent Runs As You](https://agor.me/blog/the-agent-runs-as-you) (September 8, 2026), with
earlier pieces [Who Else Has Keys](https://agor.me/blog/who-else-has-keys) and
[The Permission Slip Economy](https://agor.me/blog/the-permission-slip-economy).

## License

MIT.
