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

## Full Phase A (November, paid; needs Ariel's approval for xAI and the Gemini cap raised)

```
eval/.venv/Scripts/python eval/run_judges.py --run phase-a-1 --items eval/data/items.jsonl --families claude,gemini,openai,xai --allow-xai --samples 3 --budget-usd <cap> --workers 6
eval/.venv/Scripts/python eval/analyze/assemble_arms.py --items eval/data/items.jsonl --raw eval/data/raw/phase-a-1.jsonl --cedar eval/results/cedar.jsonl --out eval/results/results.json
```

Resumable: re-running the same `--run` skips cells already answered. Raw responses are on disk before anything else. Gemini ids and the 2026-12-01 Argon price doubling are in `config.yaml`; finish the Gemini calls by 2026-11-30.

## Tests

```
npm test                                                # Writ (unchanged)
eval/.venv/Scripts/python -m unittest discover -s eval/tests
```

## Not built yet (spec items outside this run)

Batch runners, bootstrap CI driver and McNemar tests wired into the results JSON (the functions exist in `evallib/metrics.py`), figures, `audit_sample.py`, `PREREG.md`, O1/O3/O4, Phase B, tau-bench extract.
