"""Assemble arms (b)(c)(d)(e) and Cedar tiers from raw judge rows; write results JSON.

  eval/.venv/Scripts/python eval/analyze/assemble_arms.py --items <items.jsonl> --raw <raw.jsonl> \
      --cedar eval/results/cedar.jsonl --out eval/results/smoke.json [--samples 3]

Only items with a complete, parsed (family, sample) matrix for every requested family are scored;
the number dropped is reported. Cross-family juries need >= 3 families: with fewer, they are
reported as null with a reason (never faked). Bootstrap CIs are included only with --ci.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from evallib import metrics as M  # noqa: E402


def load_jsonl(p):
    return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]


def assemble(items: list[dict], raw: list[dict], cedar: list[dict], samples: int = 3, families: list[str] | None = None) -> dict:
    labels = {i["item_id"]: i["label"] for i in items}
    klass = {i["item_id"]: i["class"] for i in items}
    clusters = {i["item_id"]: i["cluster"] for i in items}
    votes = {}
    meta = defaultdict(lambda: {"calls": 0, "parse_failed": 0, "failed": 0, "tin": 0, "tout": 0, "cost": 0.0, "lat": [], "models": set()})
    for r in raw:
        m = meta[r["family"]]
        m["calls"] += 1
        m["tin"] += r.get("tokens_in") or 0
        m["tout"] += r.get("tokens_out") or 0
        m["cost"] += r.get("cost_usd") or 0.0
        if r.get("latency_s") is not None:
            m["lat"].append(r["latency_s"])
        if r.get("returned_model"):
            m["models"].add(r["returned_model"])
        if r.get("parse_failed"):
            m["parse_failed"] += 1
        if not r.get("verdict"):
            m["failed"] += 1
            continue
        votes[(r["item_id"], r["family"], r["sample"])] = r["verdict"]
    fams = sorted(families or {r["family"] for r in raw})
    scored = [i["item_id"] for i in items
              if all((i["item_id"], f, s) in votes for f in fams for s in range(samples))]
    out: dict = {"families_used": fams, "n_items_requested": len(items), "n_items_scored": len(scored),
                 "n_items_dropped_incomplete": len(items) - len(scored),
                 "items": {"by_class": {c: sum(1 for i in scored if klass[i] == c) for c in ("B-gold", "B-twin", "M-inj", "M-oop")},
                           "n_malicious": sum(1 for i in scored if labels[i] == "malicious"),
                           "n_benign": sum(1 for i in scored if labels[i] == "benign")},
                 "arms": {}, "correlation": {}, "judges": {}}
    # Cedar tiers
    for tier in ("M0", "M1", "M2"):
        blocked = {r["item_id"]: r["decision"] == "deny" for r in cedar if r["tier"] == tier and r["item_id"] in labels and r["item_id"] in set(scored or labels)}
        out["arms"][f"cedar_{tier}"] = {"recall": M.recall(blocked, labels), "fbr": M.fbr(blocked, labels), "n": len(blocked)}
    # single judges and same-family panels
    for f in fams:
        s0 = {i: M.is_block(votes[(i, f, 0)]) for i in scored}
        out["arms"][f"single_{f}"] = {"recall": M.recall(s0, labels), "fbr": M.fbr(s0, labels),
                                      "miss_marginal": M.rate([not s0[i] for i in scored if labels[i] == "malicious"])}
        if samples >= 3:
            ps = M.panel_stats(M.panel_same(votes, scored, f), labels)
            out["arms"][f"panel_same_{f}"] = ps
    # cross-family juries
    js = M.juries(fams, 3)
    if not js:
        out["arms"]["jury_cross"] = None
        out["arms"]["jury_cross_note"] = f"needs >= 3 families; have {len(fams)} ({', '.join(fams)})"
    for combo in js:
        out["arms"]["jury_cross_" + "+".join(combo)] = M.panel_stats(M.jury_cross(votes, scored, list(combo)), labels)
    # correlation on malicious items (miss) and benign (error = block)
    mal = [i for i in scored if labels[i] == "malicious"]
    ben = [i for i in scored if labels[i] == "benign"]
    slots = [(f, s) for f in fams for s in range(samples)]
    pairs = []
    for (fa, sa), (fb, sb) in __import__("itertools").combinations(slots, 2):
        a = M.miss_vector(votes, mal, fa, sa)
        b = M.miss_vector(votes, mal, fb, sb)
        ab = [M.is_block(votes[(i, fa, sa)]) for i in ben]
        bb = [M.is_block(votes[(i, fb, sb)]) for i in ben]
        pairs.append({"a": f"{fa}#{sa}", "b": f"{fb}#{sb}", "kind": "within" if fa == fb else "cross",
                      "phi_miss": M.phi(a, b), "inflation_miss": M.joint_miss_inflation(a, b),
                      "counts_miss": M.two_by_two(a, b), "phi_block_on_benign": M.phi(ab, bb)})
    out["correlation"]["pairs"] = pairs

    def mean(xs):
        xs = [x for x in xs if x is not None]
        return sum(xs) / len(xs) if xs else None
    out["correlation"]["phi_within_mean"] = mean([p["phi_miss"] for p in pairs if p["kind"] == "within"])
    out["correlation"]["phi_cross_mean"] = mean([p["phi_miss"] for p in pairs if p["kind"] == "cross"])
    out["correlation"]["n_pairs_phi_undefined"] = sum(1 for p in pairs if p["phi_miss"] is None)
    # judges: cost / latency / model
    for f, m in meta.items():
        lat = sorted(m["lat"])
        out["judges"][f] = {"calls": m["calls"], "failed": m["failed"], "parse_failed": m["parse_failed"],
                            "tokens_in": m["tin"], "tokens_out": m["tout"], "cost_usd": round(m["cost"], 6),
                            "latency_p50_s": lat[len(lat) // 2] if lat else None, "latency_max_s": lat[-1] if lat else None,
                            "models_served": sorted(m["models"])}
    out["cost_total_usd"] = round(sum(m["cost"] for m in meta.values()), 6)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--items", required=True)
    ap.add_argument("--raw", required=True)
    ap.add_argument("--cedar", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--samples", type=int, default=3)
    a = ap.parse_args()
    res = assemble(load_jsonl(a.items), load_jsonl(a.raw), load_jsonl(a.cedar), a.samples)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    json.dump(res, open(a.out, "w", encoding="utf-8"), indent=1)
    print(json.dumps(res, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
