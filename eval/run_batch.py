"""Batch runner CLI for gemini, openai and xai. Resumable at every stage.

  python eval/run_batch.py submit   --run phase-a-1 --family gemini --items eval/data/items.jsonl --budget-usd 60
  python eval/run_batch.py poll     --run phase-a-1 --family gemini [--wait 30]
  python eval/run_batch.py download --run phase-a-1 --family gemini
  python eval/run_batch.py all      --run phase-a-1 --family gemini --items ... --budget-usd 60 [--poll-every 60]
  python eval/run_batch.py status   --run phase-a-1 --family gemini

Raw rows land in eval/data/raw/<run>.jsonl (same format as run_judges.py), job ids in
eval/data/batch-jobs/<run>.<family>.json. Claude is not batched: it stays on run_judges.py (lean-claude).
xai submit needs XAI_TEST_SPEND_OK set by Ariel (the guard runs before any network call).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import yaml

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
from evallib import batch as B  # noqa: E402


def load_items(p, limit=0):
    rows = [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]
    return rows[:limit] if limit else rows


def main(argv=None, http=B.default_http, guard=B.xai_guard) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["submit", "poll", "download", "all", "status"])
    ap.add_argument("--run", required=True)
    ap.add_argument("--family", required=True, choices=sorted(B.ADAPTERS))
    ap.add_argument("--items", default=os.path.join(ROOT, "data", "items.jsonl"))
    ap.add_argument("--samples", type=int, default=3)
    ap.add_argument("--view", default="gate", choices=["gate", "transcript"])
    ap.add_argument("--purpose", default="task", choices=["task", "role"])
    ap.add_argument("--budget-usd", type=float, default=0.0)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--chunk-size", type=int, default=0)
    ap.add_argument("--poll-every", type=int, default=60)
    ap.add_argument("--wait", type=int, default=0, help="poll: keep polling up to N minutes")
    ap.add_argument("--jobs-dir", default=B.JOBS_DIR)
    ap.add_argument("--raw-dir", default=os.path.join(ROOT, "data", "raw"))
    a = ap.parse_args(argv)

    cfg_all = yaml.safe_load(open(os.path.join(ROOT, "config.yaml"), encoding="utf-8"))
    raw_path = os.path.join(a.raw_dir, f"{a.run}.jsonl")
    os.makedirs(a.raw_dir, exist_ok=True)
    cls = B.ADAPTERS[a.family]
    ad = cls(cfg_all["judge"], http, guard) if a.family == "xai" else cls(cfg_all["judge"], http)

    if a.cmd == "status":
        print(json.dumps(B.status(a.run, a.family, a.jobs_dir), indent=1))
        return 0
    try:
        if a.cmd in ("submit", "all"):
            if a.budget_usd <= 0:
                print("REFUSED: --budget-usd must be positive.", file=sys.stderr)
                return 2
            B.submit_stage(ad, load_items(a.items, a.limit), a.run, raw_path, cfg_all, a.view, a.purpose, a.samples,
                           a.budget_usd, a.chunk_size or None, a.jobs_dir)
        if a.cmd in ("poll", "all"):
            deadline = time.time() + a.wait * 60
            while True:
                st = B.poll_stage(ad, a.run, a.jobs_dir)
                open_jobs = [j for j in st["jobs"] if j["state"] == "pending" and not j["downloaded"]]
                print(f"{len(open_jobs)} job(s) pending")
                if a.cmd == "all" or a.wait:
                    if not open_jobs or (a.cmd == "poll" and time.time() > deadline):
                        break
                    time.sleep(a.poll_every)
                else:
                    break
        if a.cmd in ("download", "all"):
            st, n, nf = B.download_stage(ad, a.run, raw_path, cfg_all, a.jobs_dir)
            print(json.dumps({"rows_written": n, "rows_without_verdict": nf,
                              "spend_usd": round(sum(j.get("actual_usd") or 0 for j in st["jobs"]), 6), "raw": raw_path}))
            bad = [j["job_id"] for j in st["jobs"] if j["state"] == B.TERMINAL_BAD]
            if bad:
                print("FAILED JOBS (rerun submit to resubmit their cells):", bad, file=sys.stderr)
                return 1
    except (B.CapExceeded, B.GuardRefused) as e:
        print("REFUSED:", e, file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
