# Writ

Purpose manifests for AI agents, compiled to Cedar policy and Claude Code permissions, with
(later) a per-call enforcement hook, a credential broker, a hash-chained audit log, a probe
harness, and an auditor evidence export. Prototype. Not launched.

## Stack

- TypeScript (strict, NodeNext, ES2022), Node 22+. No framework.
- `yaml` for manifests, `ajv` (JSON Schema 2020-12) for validation,
  `@cedar-policy/cedar-wasm` (nodejs build) as the policy engine.
- Tests: `node --test` through `tsx`. No test framework.

## Commands

```
npm run typecheck        # tsc --noEmit (check the real exit status)
npm test                 # node --import tsx --test "test/**/*.test.ts"
npm run writ -- compile examples/blog-publisher.yaml --target all --out out/blog-publisher
npm run probe -- examples/blog-publisher.yaml   # every case through the real hook; exit 0 only on PROBE OK
npm run verify -- --chain data/chain.jsonl      # 0 verified, 2 broken (first bad seq named), 1 unreadable
npm run hook:selftest                           # one allow + one deny through hooks/writ-gate.mjs
npm run build            # dist/; the hook prefers dist/ when present. Rebuild after touching src/.
npm run golden:update    # regenerate test/golden from the example manifests (review the diff)
```

## Layout

- `schema/manifest.schema.json`: the purpose manifest contract.
- `src/paths.ts`: repository-root resolution that works from `src/` and from `dist/`.
- `src/manifest.ts`: load, validate, default, and version a manifest.
- `src/compile/cedar.ts`: manifest to a named Cedar policy set.
- `src/compile/claude-code.ts`: manifest to a Claude Code `settings.json` fragment.
- `src/authorize.ts`: the one authorization call every enforcement point uses. Fails closed.
- `src/chain/`: the audit chain (`index.ts` append and verify, `keys.ts` ed25519, `lock.ts` the
  O_EXCL advisory lock). `appendRecord` is the only writer; the broker imports it too.
- `src/gate/decide.ts`: the hook's decision logic, one pure function. `hooks/writ-gate.mjs` is
  the plain-JS entry Claude Code runs; it loads dist/ or src/ (never both).
- `src/probe/`: case generation (`cases.ts`) and the runner that spawns the real hook (`run.ts`).
- `bin/writ.ts`: the CLI (`check`, `compile`, `authorize`, `verify`, `probe`).
- `examples/`: neutral-path fixtures. Dogfood manifests with real paths go in `local/` (gitignored).
- `.github/workflows/ci.yml`: typecheck, tests, build, then self-test and both probes against dist/.
- `docs/decisions/`: one dated record per decision. Read the latest before changing the model.

## Runtime notes

- `WRIT_MANIFEST` and `WRIT_CHAIN` are the hook's fallbacks for `--manifest` and `--chain`.
- `WRIT_HOOK_PREFER=src` forces the hook to load TypeScript sources through tsx. The test
  suite sets it so a stale local `dist/` cannot poison a run; CI proves `dist/` separately.
- The chain and its keys live under `data/` (gitignored). Never commit a chain or a key.
- The chain records paths and hashes of arguments, never argument values. Keep it that way.

## Hard rules

- Author files with the Write tool. Never through a shell heredoc or a quoted `printf`.
- Fail closed. An evaluation error is a deny, never an allow.
- Deny by default. A tool the manifest does not name is denied, in Cedar and in the hook.
- No em-dashes anywhere. Never the phrase "load-bearing".
- No secrets in any file. The broker holds credentials; the repo never does.
- Never claim novelty over MCP Enterprise-Managed Authorization, ID-JAG / Okta XAA / Auth0
  Token Vault, or the MCP gateways. Writ composes with them.
- `git commit` runs typecheck and tests through a hook. Fix failures; do not bypass.
- Prototype status stays in the README until an outside user runs it.
