# PREREG (DRAFT, not frozen): NSF SBIR preliminary-data experiment

Status: draft written 2026-10-19. Hypotheses, tests and thresholds are in `nsf-sbir/stages/s4-prelim-data/README.md` sections 4, 5 and 10 and are adopted here unchanged. This file records the decisions made while building the harness. It is frozen (git tag `prereg-<date>`) only after the pilot, per spec step 6. Nothing below is a result.

## 1. Pinned model ids (one id per family for the whole experiment)

Why: mixed versions inside one family confound the error-correlation measurement. Observed 2026-10-18/19: the `deep` tier served both `claude-opus-4-8` (3 of 60 smoke calls) and `claude-opus-5-5` (57 of 60), because a tier is a family alias that Claude Code resolves per call.

| Family | Pinned id | How it is pinned | Status |
|---|---|---|---|
| claude | `claude-opus-5-5` | `config.yaml judge.claude_model`, passed as lean-claude `opts.model` (it accepts an explicit id; verified in `lean-claude.mjs`, `opts.model` overrides the tier). Still via lean-claude on the Max plan, no API key. | Probed 2026-10-19: 4 of 4 direct calls served `claude-opus-5-5`. |
| gemini | `gemini-4-argon` | `judge.gemini_model`. Fallback `gemini-3.1-pro-preview` exists in the live adapter only; a fallback row is off-pin and is excluded. | Smoke and batch probe both served `gemini-4-argon`. |
| openai | `gpt-5.5-2026-04-23` (snapshot of `gpt-5.5`) | `judge.openai_model` | Probed 2026-10-19: `gpt-5.5` resolves to this snapshot. |
| xai | `grok-4.5` | `judge.xai_model` | UNVERIFIED. No xAI call is permitted before the November run; confirm the served id in the November preflight and amend this file before the freeze if it differs. |

Enforcement (all tested):
- `run_judges.py` and `run_batch.py` count a cell as answered only if its `returned_model` equals the pin or starts with it, so off-pin cells are re-run.
- `assemble_arms.py` drops verdict rows whose served model is off-pin (counted in `rows_excluded_off_pin`; the affected items fall out as incomplete and are reported). With `--no-pins` it refuses a run in which any family was served by more than one model id (`MixedModelError`).
- Even with an explicit model, Claude Code can answer from another model (one of 3 pinned calls on 2026-10-19 returned `claude-opus-4-8`, most likely an overload fallback). The pin therefore cannot guarantee the served id; the filter above does.

Observation to decide before the freeze: the OpenAI account also lists `gpt-5.6-sol`, `gpt-6-sol` and `gpt-6.1-sol` (all answered a probe call). The spec names `gpt-5.5`, so it stays. `gpt-6.1-sol` batches at half the price of `gpt-5.5`; switching is a judgment call for Ariel, not made here.

## 2. Prices recorded (USD per 1M tokens, in / out)

| Family | Standard | Batch | Source |
|---|---|---|---|
| gpt-5.5 | 5.00 / 30.00 | 2.50 / 15.00 | VERIFIED 2026-10-19, developers.openai.com/api/docs/pricing (under 272K context) |
| gemini-4-argon | 2.00 / 10.00 (4.00 / 20.00 from 2026-12-01) | 50% of standard | memory `reference_gemini_model_catalog.md` |
| grok-4.5 | 3.00 / 15.00 | 50% assumed | ASSUMED, unverified (spec section 7); xAI results report cost in ticks and the runner uses those when present |
| claude-opus-5-5 | Max plan, $0 cash | n/a | tokens logged for quota |

## 3. xAI authority

Ariel approved Grok models as jurors for the November run, in chat, on 2026-10-19 (relayed to the harness builder by the session that owns this work). This file is the written record of that approval and is the authority for including the `xai` family in the November run.

It is an approval of the family, not a spend authorisation. xAI test spend remains hard-guarded: `run_batch.py` calls `~/.claude/scripts/lib/xai-test-guard.mjs` before any xAI network call, which refuses unless Ariel sets `XAI_TEST_SPEND_OK=<LA date>:<cap>` for that day. No xAI call has been made in building the harness; the adapter is tested only against mocked responses.

## 4. Other decisions recorded

- Claude is not batched; it runs through lean-claude (`run_judges.py --families claude`), paced, no API key.
- Cluster-bootstrap CIs, exact McNemar (Holm over the four same-family comparators, each against the jury that drops that family), the H2 ratio R with its SUPPORTED/FALSIFIED/INCONCLUSIVE rule, the FBR non-inferiority check and the phi within-minus-cross difference are written into `results.json` under `arms.*.{recall,fbr}_ci` and `inference` by `assemble_arms.py` (10,000 resamples, seed 20261101).
- FBR non-inferiority uses the two-sided 95% upper bound of the bootstrap difference against the +2 point margin, which is conservative relative to a one-sided alpha of 0.05.
- Gemini work must finish by 2026-11-30 (Argon doubles on 2026-12-01).
