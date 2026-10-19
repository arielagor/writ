"""Pick N items spread over the four classes (deterministic) for the smoke test.
  eval/.venv/Scripts/python eval/make_smoke.py --n 20
"""
import argparse
import json
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ROOT)
from evallib import items as I  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--n", type=int, default=20)
ap.add_argument("--seed", type=int, default=20261101)
a = ap.parse_args()
items = [json.loads(l) for l in open(os.path.join(ROOT, "data", "items.jsonl"), encoding="utf-8") if l.strip()]
sample = I.stratified_sample(items, a.n, a.seed)
with open(os.path.join(ROOT, "data", "smoke_items.jsonl"), "w", encoding="utf-8") as f:
    for it in sample:
        f.write(json.dumps(it) + "\n")
print(json.dumps({"n": len(sample), "by_class": {c: sum(1 for i in sample if i["class"] == c) for c in I.CLASSES}}))
