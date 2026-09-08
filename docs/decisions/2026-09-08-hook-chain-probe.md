# 2026-09-08: the enforcement hook, the audit chain, and the probe harness

## Decision

Three components land together because each is only meaningful with the other two:

- `hooks/remit-gate.mjs` is the Claude Code `PreToolUse` enforcement point. It reads the hook
  JSON on stdin, resolves the session's purpose manifest, calls the one authorizer, writes a chain
  record for every decision, and answers with the Claude Code deny contract or with silence.
- `src/chain/` is the append-only, hash-linked, ed25519-signed JSONL audit chain, with a verifier
  that names the first sequence number that no longer holds.
- `src/probe/` derives in-purpose and out-of-purpose calls from a manifest, sends every one through
  the real hook process, and fails unless the allows are ALLOW records, the denies are DENY records,
  and the chain verifies afterwards. CI runs it on both example manifests, against the built `dist/`.

## Fail-closed choices in the hook

The author's earlier machine-wide gate fails open on an internal error and prints a `GATE-ERROR`
line, because its job was to stop a small never-class without ever blocking normal work. Remit's
gate is the delegation itself. If the delegation cannot be established or cannot be recorded, the
call is denied. Each failure has its own code so an operator reading the chain can tell them apart:

| Condition | Code | Chain record |
|---|---|---|
| stdin is not JSON or not an object | `input-unparseable` | ERROR, agent and purpose from the manifest if it loads, else `unresolved` |
| no `--manifest` and no `REMIT_MANIFEST` | `manifest-missing` | ERROR, `unresolved` |
| manifest file unreadable | `manifest-unreadable` | ERROR, `unresolved` |
| manifest fails validation (including expiry) | `manifest-invalid` | ERROR, `unresolved` |
| hook input has no `tool_name` | `input-missing-tool` | ERROR |
| the authorizer throws | `authorizer-error` | ERROR |
| the authorizer denies | `deny` | DENY |
| the chain cannot be written | `chain-write-failed` | none possible; the response still denies |
| anything else escapes | `gate-error` (from the script's top-level catch) | none |

An allow whose record cannot be written is turned into a deny. A gate that lets a call through
unrecorded has stopped being an audit.

## What the chain records, and what it never records

`seq, ts, agent_id, purpose_id, policy_version, tool, resource, arg_hash, credential_id, identity,
session_id, decision, reason, prev_hash, hash, sig`.

- `arg_hash` is the sha256 of the canonical JSON of `tool_input`. The arguments themselves are
  never written: not a command line, not a file body, not a URL, not a token. An auditor can
  confirm "this exact call" by hashing the call they hold.
- `resource` is the normalized path the call targets (from `file_path`, `path`, or
  `notebook_path`) or the tool name when the call has no path. A path is what the policy is about;
  it is not the arguments. Shell commands therefore record `resource: "Bash"` and nothing of the
  command.
- `reason` is redacted before it is written: policy ids and constraint keys survive
  (`agorme-blog-publish.expired`, `regex: arg_deny.file_path`), argument values do not.
- `identity` comes from the harness fields `agent_type` or `agent_name`, or `CLAUDE_AGENT_TYPE`,
  never from `tool_input`, which the model writes. This is attribution, not authorization; the
  manifest's `agent_id` is the principal.
- `credential_id` is null from the hook. The MCP broker (a separate component) fills it.

## Hash, link, sign

`hash = sha256(canonicalJson(record without hash and sig))`, `prev_hash` is the previous record's
hash (sixty-four zeros for the first), and `sig` is an ed25519 signature over the hash bytes. The
key pair is generated on first use under `keys/` beside the chain (under `data/`, gitignored),
private key written with mode 0600 where the platform honors it. The verifier recomputes every
hash, checks every link and signature, and refuses to skip a malformed line. `appendRecord`
refuses to extend a chain whose tail is damaged, so a truncated write is discovered at the next
append, not at the next audit.

Signing is process-local trust: it proves the chain was written by whoever held the key, which on
one machine is the same operator who could delete the file. It stops silent edits, not a hostile
root. Cross-host attestation (a transparency log, or countersigning by the broker) is deferred.

## Concurrency

Two writers at once would fork the chain, because an append needs the previous hash. The lock is
a sidecar file created with `O_EXCL` (`wx`), which is atomic on NTFS, ext4, APFS and tmpfs; the
loser polls, and a lock older than thirty seconds is treated as a crashed writer and removed. The
write itself is a single `appendFileSync` of one line with `O_APPEND`. Three processes appending
at once are part of the test suite. This coordinates processes on one host only.

## Why the probe goes through the real hook process

The probe exists to prove the enforcement point, not the authorizer, which the unit tests already
cover. So every case is a fresh `node hooks/remit-gate.mjs` fed the same JSON Claude Code would
send, and the assertion is on what landed in the chain. A probe that passes has demonstrated four
things at once: the hook resolves the manifest, the authorizer denies what should be denied, the
chain received a record for every call, and the chain verifies. CI runs it against the built
`dist/` after `npm run build`, so the path a fresh clone takes is the path that is proven.

Sample values that must satisfy a regular expression are chosen by trying a small pool against
the manifest's own rules. When no candidate fits, the case is reported as skipped, never invented.
The two example manifests skip nothing; that is asserted.

## Loading dist or src, never both

The hook is plain JavaScript so Claude Code can run it without a build step. It loads the
TypeScript modules from `dist/` when a build exists and otherwise through `tsx`. The choice is
made once, on the entry module, and applied to every load: mixing the two would load two copies
of `manifest.ts` with two schema paths. A stale `dist/` from before a source change caused
exactly that during development, so the test suite sets `REMIT_HOOK_PREFER=src` and CI proves
`dist/` separately after building it.

## Deferred

- The MCP credential broker and the `credential_id` it fills (separate component, separate branch).
- Evidence export (`remit evidence`), which reads this chain.
- Cross-host attestation of the chain.
- Expiry probes: the hook uses the real clock, so an expired-manifest deny is covered in-process
  (`decideAndRecord` with an injected clock) rather than through the probe.
- Emitters for MCP gateways (agentgateway, Pomerium) from the same manifest.
