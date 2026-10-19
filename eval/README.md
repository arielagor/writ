# eval/: preliminary-data harness (NSF SBIR Phase I, spec: nsf-sbir/stages/s4-prelim-data)

Phase A only: replayed gold calls, no live agents. Nothing here modifies `src/`, `hooks/` or `test/`.

## Setup (once)

```
cd remit
npm ci && npm run build
python -m venv eval/.venv
eval/.venv/Scripts/python -m pip install -r eval/requirements.txt
```

## Build data (deterministic, free)

```
eval/.venv/Scripts/python eval/datasets/agentdojo_extract.py          # records + data/counts.json
eval/.venv/Scripts/python eval/datasets/build_items.py --config full  # data/items.jsonl, data/manifests.json
node eval/arms/cedar_arm.mjs                                          # results/cedar.jsonl (M0/M1/M2, validated by Writ)
# InjecAgent: git clone https://github.com/uiuc-kang-lab/InjecAgent into a NEW empty dir, then
eval/.venv/Scripts/python -I eval/datasets/injecagent_extract.py --repo <that dir>
```

## Smoke test (about $0.15)

```
eval/.venv/Scripts/python eval/make_smoke.py --n 20
node eval/arms/cedar_arm.mjs --ids <ids of data/smoke_items.jsonl> --out eval/results/cedar_smoke.jsonl
eval/.venv/Scripts/python eval/run_judges.py --run smoke-1 --items eval/data/smoke_items.jsonl --families claude,gemini --samples 3 --budget-usd 3
eval/.venv/Scripts/python eval/analyze/assemble_arms.py --items eval/data/smoke_items.jsonl --raw eval/data/raw/smoke-1.jsonl --cedar eval/results/cedar_smoke.jsonl --out eval/results/smoke.json
```

## Full Phase A (November, batch pricing)

**Gemini must finish by 2026-11-30** (Argon doubles on 2026-12-01; the Gemini monthly spend cap must also be raised first, see the spec). Model ids are pinned in `config.yaml` and `PREREG.md` (claude-opus-5-5, gemini-4-argon, gpt-5.5-2026-04-23, grok-4.5). All commands run from the `remit` root. `P` below is `eval/.venv/Scripts/python`.

```
# 1. Submit the three batch families (job ids are written to eval/data/batch-jobs/ before anything else).
P eval/run_batch.py submit --run phase-a-1 --family gemini --budget-usd 25
P eval/run_batch.py submit --run phase-a-1 --family openai --budget-usd 60
#    xai: Ariel must first set XAI_TEST_SPEND_OK=<LA date>:<cap> for that day (hard guard; never set by a session)
P eval/run_batch.py submit --run phase-a-1 --family xai    --budget-usd 35

# 2. Claude stays on lean-claude (Max plan, no API key), paced; run in a separate window, resume freely.
P eval/run_judges.py --run phase-a-1 --items eval/data/items.jsonl --families claude --samples 3 --budget-usd 1 --workers 3

# 3. Poll to terminal state, then download (maps results back to item ids, appends to eval/data/raw/phase-a-1.jsonl).
P eval/run_batch.py poll     --run phase-a-1 --family gemini --wait 120     # repeat per family; or use `all`
P eval/run_batch.py download --run phase-a-1 --family gemini
P eval/run_batch.py status   --run phase-a-1 --family gemini

# 4. Assemble: arms, CIs, McNemar, H2, phi (10,000 resamples; takes minutes). Off-pin rows are excluded and counted.
P eval/analyze/assemble_arms.py --items eval/data/items.jsonl --raw eval/data/raw/phase-a-1.jsonl --cedar eval/results/cedar.jsonl --out eval/results/results.json
```

`run_batch.py all --run ... --family ... --budget-usd ...` does submit, poll and download in one blocking call. Every stage is resumable: cells already answered on the pinned model, or already inside a live job, are never resubmitted; a failed job's cells are resubmitted by the next `submit`; `download` never writes a job twice. A family that yields failed or off-pin cells leaves those items out of `results.json` (reported as `n_items_dropped_incomplete`), so rerun `submit` until none are missing.

USD cap: before each chunk is sent, (actual logged cost + estimate of jobs in flight + this chunk) must stay under `--budget-usd`, else the submit is refused before any network call. The estimate is a conservative bound (`config.yaml batch`: chars/3 for input, 600 output tokens per call, batch price), so the bound for the full set is larger than the expected cost: gemini $20.15, openai $58.45, xai $30.22 (computed on `data/items.jsonl`, 1,796 items x 3 samples = 5,388 calls per family). The `--budget-usd` values above are those bounds rounded up. Actual cost from logged usage is stored per row.

### Cost estimate at batch prices, full item count (1,796 items x 3 samples = 5,388 calls per family)

Token basis: gemini smoke, 60 calls, mean 662 in / 114 out (incl. thinking). OpenAI's own two-call batch probe averaged 490 in / 189 out, shown as a cross-check; the spec's assumed 1.2K in / 0.6K out is the upper case. No xAI token measurement exists.

| Family | Batch price in / out per M | Measured-token basis | OpenAI-probe tokens | Spec upper case |
|---|---|---|---|---|
| gemini-4-argon | 1.00 / 5.00 | $6.64 (doubles to $13.29 if run after 2026-12-01) | $7.73 | $22.63 |
| gpt-5.5 | 2.50 / 15.00 (verified) | $18.14 | $21.88 | $64.66 |
| grok-4.5 | 1.50 / 7.50 (ASSUMED) | $9.96 | $11.60 | $33.94 |
| claude-opus-5-5 | Max plan | $0 cash; about 9.0M tokens of quota (60 smoke calls: mean 1,543 in / 132 out) | | |

Total, measured basis: about $34.7; spec upper case about $121. The spec's roughly $169 batch figure was an upper-case estimate for 2,500 items; the measured basis is far lower because real outputs were about 114 tokens, not 600. The transcript-view subsample, the P3 paraphrase sensitivity and pilot reruns are not included.

### What was live-tested (2026-10-19, about $0.02 total)

Gemini and OpenAI batch jobs (2 requests each) were submitted, polled, downloaded and mapped back through `run_batch.py`; both returned the pinned models and verdicts. The xAI adapter has only been run against mocked responses (no xAI call is allowed before November), so its endpoint shapes are UNVERIFIED: run a 2-item job with `--limit 2 --samples 1` first and fix the parser if the result shape differs.

## Tests

```
npm test                                                # Writ (unchanged)
eval/.venv/Scripts/python -m unittest discover -s eval/tests
```

## Not built yet (spec items outside this run)

Figures, `audit_sample.py`, the frozen `PREREG.md` tag, O1/O3/O4, Phase B, tau-bench extract. `PREREG.md` exists as a draft.
