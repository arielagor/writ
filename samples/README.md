# samples: a real gate log, redacted

`gate-log-redacted.jsonl` is the audit log from four PreToolUse gates that have run on my own
development machine since June 2026. It is the evidence behind the claim that these gates actually
block things, rather than merely being configured to.

It is here because I built a governance layer once that logged 401 decisions, attributed every one of
them to `"agent":"unknown"`, and never blocked anything, because the gate allowed on unknown identity.
It looked like governance in every diagram and enforced nothing. The rule I took from that: a gate is
not proven by its tests, it is proven by a real blocked event in a log. So the log ships.

## What is in it

Every record from `~/.claude/governance/gate-log/*.jsonl`, **2026-06-11 to 2026-09-08**, redacted.
Nothing was selected or omitted; this is the whole log with fields removed, so the counts below are
the counts. It is a snapshot, and the live log keeps growing.

| Outcome | Count |
|---|---|
| ALLOWED | 351 |
| **DENIED** | **174** |
| BYPASSED | 55 |
| OTHER | 46 |
| ASKED | 40 |
| GATE-ERROR | 12 |
| **Total decisions** | **678** |

Denials by gate: heredoc-authoring-gate 109, pivot-tripwire 26, commit-gate 21, governance-gate 18.

The four enforcing gates, and what each one refuses:

- **governance-gate**: a hardcoded never-class (its own hook files, the governance directory, signing
  keys, service-account JSON, env files) plus a global kill-switch file. Deny on match. Its records
  predate the `gate` field, so they appear here as `(unlabelled)` and are identifiable by their
  `never-class-*` rule names.
- **commit-gate**: denies `git commit` when the repository's typecheck or tests fail. The `BYPASSED`
  rows are the deliberate, logged `GATE_ADMIN=1` escape hatch, which is the point: a bypass you can
  count is a bypass you can audit.
- **heredoc-authoring-gate**: denies shell heredocs and quoted literals that author source or prose
  files, because that path silently mangles backslashes and long text.
- **pivot-tripwire**: denies work that reaches for a new credential or paid service before the
  zero-dependency path has been re-checked.

The remaining `gate` values (`resume-context`, `assistant-trigger`, `goal-tracker`, `goal-stop`) are
observers that record but never deny, which is why they contribute records and no denials.

Two record shapes appear because the gates were written at different times: an older one writes
`{"event": "BLOCK"|"ASK"|"PASS"}` and a newer one writes `{"decision": "deny"|"allow"|"bypass"}`.
The redactor normalizes both into `outcome` so the file is countable by someone who did not write
either gate. Summing per-gate numbers without normalizing undercounts, because it silently drops
whichever schema you did not think of. That mistake is in this repo's history and is the reason
`outcome` exists.

## What was removed, and how you can check

`scripts/redact-gate-log.mjs` produced this file. It keeps the timestamp, the outcome, the rule name,
the tool, the agent identity and the gate, because those are the evidence. It removes everything else.

- Absolute paths become shape-preserving placeholders: `<signing-key depth=6>`, `<env-file depth=5>`,
  `<governance-control depth=6>`, `<source.ts depth=4>`. The class is what the rule reacted to; the
  filename is not evidence of anything.
- Commands become `<command verb=rm len=56>`. The verb and the length survive, the command line does not.
- Errors become `redacted-error`.
- The script holds a deny list of secret patterns and every environment variable name on the machine,
  greps its own output for all of them, and **writes nothing at all if any survive**. It fails closed,
  which is the same property the gates have.

Reproduce it on your own log:

```bash
node scripts/redact-gate-log.mjs ~/.claude/governance/gate-log samples/gate-log-redacted.jsonl
```

## What this is not

It is not a benchmark, and it is not enterprise scale. It is one operator's machine over three months.
What it demonstrates is narrow and, I think, the only thing worth demonstrating at this stage: the
difference between a gate that is declared and a gate that has said no.
