# Writ

**Status: prototype, not launched.** Built in the open, on the author's own agent fleet first.

63% of organizations running AI agents in production cannot enforce purpose limitations on them
(2026 governance survey, via Sennovate). They know what the agent is supposed to do. They cannot
technically stop it from doing anything else, because the agent runs as the human who launched it
and inherits every right that human holds. Vendors ship the enforcement point: the harness, the
gateway, the identity provider. Nobody ships the customer's delegation model, the thing that says
which principal each agent acts as, which calls fall inside its purpose, and how to prove it to an
auditor. Writ is that layer.

An agent declares a purpose in a small manifest. Writ compiles it into least-privilege policy for
whatever already enforces calls in your estate, and (in later components) brokers a short-lived
credential per call so the agent never holds a standing key, writes a hash-chained audit record
naming agent, purpose, tool, credential and policy, keeps probing with out-of-purpose calls so the
limit is proven rather than assumed, and exports the evidence an EU AI Act auditor asks for.

## Sixty seconds

```
npm ci
npm run build
node dist/bin/writ.js probe examples/blog-publisher.yaml
```

That last command derives in-purpose and out-of-purpose calls from the manifest, sends every one of
them through the real enforcement hook as a separate process, and exits non-zero unless the allows
were allowed, the denies were actually denied, and the audit chain verifies. The table it prints is
further down.

**Evidence, not assertion:** [`samples/`](samples/README.md) holds the real, redacted audit log from
the gates that run on the author's own machine. 678 decisions between 2026-06-11 and 2026-09-08, 174
of them denials. The reason that file is in this repository is in the next paragraph.

## Why this exists

The author built a 39-agent framework with a kill switch, circuit breakers and confidence gates, then
read its audit log: 401 decisions, every one attributed to `"agent":"unknown"`, and not a single block
in the framework's entire life. The gate resolved agent identity to unknown, and allowed on unknown.
It was governance in every diagram and enforcement in none.

So the rule here is that a guardrail is not proven by its tests. It is proven by a real blocked event
in a log. That is why the probe harness runs in CI, why the chain is signed, and why the log ships.

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
- **Enforcement hook** (`hooks/writ-gate.mjs`, `src/gate/decide.ts`): the Claude Code
  `PreToolUse` gate. Every tool call is evaluated against the session's declared purpose and
  every decision, including every failure to decide, lands in the audit chain before the answer
  goes back. A missing manifest, bad input, a thrown authorizer, or an unwritable chain is a deny
  with its own reason. Arguments are hashed, never written.
- **Audit chain** (`src/chain/`): append-only JSONL, each record hash-linked to the previous and
  ed25519-signed. `writ verify` recomputes every hash, checks every link and signature, and
  names the first sequence number that no longer holds. Three processes appending at once are
  part of the test suite.
- **Probe harness** (`src/probe/`, `writ probe`): derives in-purpose and out-of-purpose calls
  from a manifest, sends each one through the real hook process, and fails unless the allows are
  ALLOW records, the denies are DENY records, and the chain verifies. CI runs it on both example
  manifests against the built `dist/`, so a build only goes green when real denials were logged.

## Usage

```
npm install
npm test                                      # 82 tests: manifest, compiler, authorizer, chain, hook, probe
npm run writ -- check examples/gbrain-reader.yaml
npm run writ -- compile examples/blog-publisher.yaml --target all --out out/blog-publisher
npm run probe -- examples/blog-publisher.yaml # every case through the hook; prints a table; exit 0 only on PROBE OK
npm run verify -- --chain data/chain.jsonl    # walk a chain; exit 0 verified, 2 broken, 1 unreadable
npm run hook:selftest                         # one allow and one deny through the gate, chain verified
```

Install the gate on a Claude Code project:

```
npm run build
npm run writ -- compile local/my-agent.yaml --target claude-code --out out/my-agent
```

`out/my-agent/claude-code.settings.json` holds a `permissions` block (allow rules for exactly the
manifest's tools, deny rules for the sensitive built-ins it does not name) and a `PreToolUse`
registration for `node hooks/writ-gate.mjs --manifest "local/my-agent.yaml"`. Merge it into the
project's `.claude/settings.json`, keep the manifest path relative to where Claude Code runs, and
point `WRIT_CHAIN` at the chain file you want the records in (default `data/chain.jsonl` in this
repository). From then on every call the agent makes is either allowed by a named policy or denied
with a reason, and either way it is in the chain.

Hook contract, for anyone wiring it elsewhere: stdin is the Claude Code `PreToolUse` JSON
(`session_id`, `tool_name`, `tool_input`, `agent_type`); on deny stdout is exactly
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<purpose id>: <reason>"}}`;
on allow stdout is empty; exit code is 0 either way.

What a probe run looks like. This is the actual table from
`node dist/bin/writ.js probe examples/blog-publisher.yaml`, with only the header line naming the
absolute hook path removed:

```
#       expect got       seq  tool                   call                                           why
 in-1   ALLOW  ALLOW     1    Write                  file_path=/workspace/blog/posts/probe.mdx      allowed tool, every constraint satisfied
 out-2  DENY   DENY      2    Write                  file_path=/outside-the-purpose/probe.txt       path outside every allowed prefix
 in-3   ALLOW  ALLOW     3    Edit                   file_path=/workspace/blog/posts/probe.mdx      allowed tool, every constraint satisfied
 out-4  DENY   DENY      4    Edit                   file_path=/outside-the-purpose/probe.txt       path outside every allowed prefix
 out-5  DENY   DENY      5    Edit                   file_path=/workspace/blog/posts/.env           argument file_path hits arg_deny
 in-6   ALLOW  ALLOW     6    mcp__gbrain__query     detail=low                                     allowed tool, every constraint satisfied
 out-7  DENY   DENY      7    mcp__gbrain__query     detail=999999                                  argument detail misses arg_allow
 out-8  DENY   DENY      8    mcp__gbrain__put_page                                                 tool not named by the manifest
 out-9  DENY   DENY      9    Bash                   command=echo probe                             sensitive built-in not named by the manifest
 out-10 DENY   DENY      10   WebFetch               url=https://example.com/                       sensitive built-in not named by the manifest
 out-11 DENY   DENY      11   Agent                                                                 sensitive built-in not named by the manifest
allow 3/3, deny 8/8, chain verified (11 records)
PROBE OK
```

And the same run for `examples/gbrain-reader.yaml`:

```
#       expect got       seq  tool                   call                     why
 in-1   ALLOW  ALLOW     1    mcp__gbrain__query     limit=1                  allowed tool, every constraint satisfied
 out-2  DENY   DENY      2    mcp__gbrain__query     limit=999999             argument limit misses arg_allow
 in-3   ALLOW  ALLOW     3    mcp__gbrain__search                             allowed tool, no constraints
 in-4   ALLOW  ALLOW     4    mcp__gbrain__get_page  slug=people/probe        allowed tool, every constraint satisfied
 out-5  DENY   DENY      5    mcp__gbrain__get_page  slug=secrets/probe       argument slug hits arg_deny
 out-6  DENY   DENY      6    mcp__gbrain__put_page                           tool not named by the manifest
 out-7  DENY   DENY      7    Bash                   command=echo probe       sensitive built-in not named by the manifest
 out-8  DENY   DENY      8    Write                  file_path=/tmp/probe.txt sensitive built-in not named by the manifest
 out-9  DENY   DENY      9    WebFetch               url=https://example.com/ sensitive built-in not named by the manifest
 out-10 DENY   DENY      10   Agent                                           sensitive built-in not named by the manifest
allow 3/3, deny 7/7, chain verified (10 records)
PROBE OK
```

## What comes next (not built yet)

1. An MCP proxy that holds the upstream keys and mints a short-lived, downscoped credential per
   call, filling the chain's `credential_id`.
2. An evidence export that reads the chain and answers "which policy allowed that call".
3. Emitters for MCP gateways (agentgateway, Pomerium) from the same manifest.

## What this is not

Writ is not an identity provider, not an MCP gateway, and not a new authorization protocol.
It composes with the pieces that already exist and are already shipping:

- **MCP Enterprise-Managed Authorization** and the OAuth **Identity Assertion Authorization
  Grant (ID-JAG)**, as deployed by **Okta Cross App Access** and **Auth0 Token Vault**, answer
  "may this agent reach this resource". Writ consumes that answer; it does not replace it.
- **Arcade, Pomerium, agentgateway, MintMCP** and the other MCP gateways enforce at the wire.
  Writ emits the policy they enforce and records what they decided.
- **Cedar** is the policy language. Writ writes Cedar; it does not invent a language.

Writ answers a narrower question those layers leave to the customer: what is this agent's
purpose, which calls fall inside it, and can you prove it held.

## Background

The problem statement is the author's post
[The Agent Runs As You](https://agor.me/blog/the-agent-runs-as-you) (September 8, 2026), with
earlier pieces [Who Else Has Keys](https://agor.me/blog/who-else-has-keys) and
[The Permission Slip Economy](https://agor.me/blog/the-permission-slip-economy).

## License

MIT.
