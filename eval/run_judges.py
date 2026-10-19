"""Run juror calls over items, resumable, with a hard USD cap. Raw responses go to disk BEFORE
anything else (data/raw/<run>.jsonl, one line per (item, family, sample)).

  eval/.venv/Scripts/python eval/run_judges.py --run smoke-1 --items eval/data/smoke_items.jsonl \
      --families claude,gemini --samples 3 --budget-usd 3 [--view gate] [--workers 4]

xAI is refused unless --allow-xai (needs Ariel's explicit approval). A requested family that
fails to produce a verdict for a cell is recorded as failed, and the run exits non-zero.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date

import yaml

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
from evallib import jurors as J  # noqa: E402


def load_jsonl(p):
    return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", required=True)
    ap.add_argument("--items", default=os.path.join(ROOT, "data", "items.jsonl"))
    ap.add_argument("--families", default="claude,gemini,openai")
    ap.add_argument("--samples", type=int, default=3)
    ap.add_argument("--view", default="gate", choices=["gate", "transcript"])
    ap.add_argument("--purpose", default="task", choices=["task", "role"])
    ap.add_argument("--budget-usd", type=float, required=True, help="hard cap on cash API spend for this invocation")
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--allow-xai", action="store_true")
    a = ap.parse_args()

    cfg_all = yaml.safe_load(open(os.path.join(ROOT, "config.yaml"), encoding="utf-8"))
    cfg, prices = cfg_all["judge"], cfg_all["prices"]
    fams = a.families.split(",")
    if "xai" in fams and not a.allow_xai:
        print("REFUSED: family xai needs --allow-xai (Ariel's explicit approval).", file=sys.stderr)
        return 3
    for f in fams:
        if f not in J.ADAPTERS:
            print("unknown family", f, file=sys.stderr)
            return 2
    items = load_jsonl(a.items)[: a.limit or None]
    _, phash = J.load_prompt()
    raw_dir = os.path.join(ROOT, "data", "raw")
    os.makedirs(raw_dir, exist_ok=True)
    raw_path = os.path.join(raw_dir, f"{a.run}.jsonl")
    done = set()
    spent = 0.0
    if os.path.exists(raw_path):
        for r in load_jsonl(raw_path):
            if r.get("verdict"):
                done.add((r["item_id"], r["family"], r["sample"]))
            spent += r.get("cost_usd") or 0.0
    cells = [(it, f, s) for it in items for f in fams for s in range(a.samples) if (it["item_id"], f, s) not in done]
    print(f"{len(items)} items, {len(cells)} cells to run, {len(done)} already done, prior spend ${spent:.4f}, cap ${a.budget_usd}")
    lock = threading.Lock()
    state = {"spent": spent, "stop": False, "failed": 0}

    def work(cell):
        it, f, s = cell
        if state["stop"]:
            return None
        r = J.judge(it, f, cfg, a.view, a.purpose)
        r["cost_usd"] = 0.0 if f == "claude" else J.cost_usd(prices, f, r.get("tokens_in"), r.get("tokens_out"), date.today())
        rec = {"run": a.run, "item_id": it["item_id"], "family": f, "sample": s, "view": a.view, "purpose": a.purpose,
               "prompt_sha256": phash, **{k: v for k, v in r.items() if k != "family"}}
        with lock:
            with open(raw_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec) + "\n")
            state["spent"] += rec["cost_usd"]
            if not rec.get("verdict"):
                state["failed"] += 1
            if rec.get("via") == "api":
                state["stop"] = True
                print("STOP: lean-claude fell to its API-overflow lane; not continuing.", file=sys.stderr)
            if state["spent"] >= a.budget_usd:
                state["stop"] = True
                print(f"STOP: budget cap ${a.budget_usd} reached (${state['spent']:.4f}).", file=sys.stderr)
        return rec

    n = 0
    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        for fut in as_completed([ex.submit(work, c) for c in cells]):
            if fut.result():
                n += 1
                if n % 10 == 0:
                    print(f"  {n}/{len(cells)} spent ${state['spent']:.4f}", flush=True)
    print(json.dumps({"cells_run": n, "failed_cells": state["failed"], "spend_usd": round(state["spent"], 6), "raw": raw_path}))
    return 1 if state["failed"] or state["stop"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
