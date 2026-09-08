# Remit

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
npm run remit -- compile examples/blog-publisher.yaml --target all --out out/blog-publisher
npm run golden:update    # regenerate test/golden from the example manifests (review the diff)
```

## Layout

- `schema/manifest.schema.json`: the purpose manifest contract.
- `src/manifest.ts`: load, validate, default, and version a manifest.
- `src/compile/cedar.ts`: manifest to a named Cedar policy set.
- `src/compile/claude-code.ts`: manifest to a Claude Code `settings.json` fragment.
- `src/authorize.ts`: the one authorization call every enforcement point uses. Fails closed.
- `bin/remit.ts`: the CLI.
- `docs/decisions/`: one dated record per decision. Read the latest before changing the model.

## Hard rules

- Author files with the Write tool. Never through a shell heredoc or a quoted `printf`.
- Fail closed. An evaluation error is a deny, never an allow.
- Deny by default. A tool the manifest does not name is denied, in Cedar and in the hook.
- No em-dashes anywhere. Never the phrase "load-bearing".
- No secrets in any file. The broker holds credentials; the repo never does.
- Never claim novelty over MCP Enterprise-Managed Authorization, ID-JAG / Okta XAA / Auth0
  Token Vault, or the MCP gateways. Remit composes with them.
- `git commit` runs typecheck and tests through a hook. Fix failures; do not bypass.
- Prototype status stays in the README until an outside user runs it.
