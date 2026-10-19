"""Build eval/data/items.jsonl (AgentDojo classes) and eval/data/manifests.json from the records.

Run:  eval/.venv/Scripts/python eval/datasets/build_items.py [--config lean|full]
Config sizes come from eval/config.yaml. Deterministic for a given seed.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import yaml  # noqa: E402

from evallib import items as I  # noqa: E402
from evallib import manifests as M  # noqa: E402

DATA = os.path.join(ROOT, "data")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="full", choices=["lean", "full"])
    a = ap.parse_args()
    cfg = yaml.safe_load(open(os.path.join(ROOT, "config.yaml"), encoding="utf-8"))
    sizes = cfg["sizes"][a.config]
    records = json.load(open(os.path.join(DATA, "agentdojo_records.json"), encoding="utf-8"))
    items, stats = I.build_all(records, sizes, cfg["seed"])
    M.attach_gold(items, records)
    manifests = M.build_for_items(items)
    # _user_gold stays on disk for manifest-tier provenance; juror views use a field whitelist (tested).
    with open(os.path.join(DATA, "items.jsonl"), "w", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps(it) + "\n")
    with open(os.path.join(DATA, "manifests.json"), "w", encoding="utf-8") as f:
        json.dump(manifests, f)
    stats["config"] = a.config
    stats["n_manifests"] = len(manifests)
    print(json.dumps(stats, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
