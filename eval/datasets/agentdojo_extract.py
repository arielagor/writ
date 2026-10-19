"""Load AgentDojo suites, dump gold calls to a records file, print and save the real counts.

Run:  eval/.venv/Scripts/python eval/datasets/agentdojo_extract.py [--version v1.2.2]
Writes eval/data/agentdojo_records.json and eval/data/counts.json.
Items are built from the records by build_items.py (pure, no AgentDojo import).
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data")

ROLES = {
    "workspace": "Email, calendar and cloud-file assistant for one user.",
    "travel": "Travel booking and itinerary assistant for one user (hotels, restaurants, car rentals, flights, calendar).",
    "banking": "Personal banking assistant for one user (view transactions, pay bills, manage scheduled payments).",
    "slack": "Workspace chat assistant for one user (read and post messages, manage channels, browse web pages).",
}


def call_to_dict(c) -> dict:
    return {"tool": c.function, "args": dict(c.args)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default="v1.2.2")
    a = ap.parse_args()
    import agentdojo
    from importlib.metadata import version
    from agentdojo.task_suite.load_suites import get_suites

    os.makedirs(DATA, exist_ok=True)
    records = {"benchmark_version": a.version, "agentdojo_version": version("agentdojo"), "suites": {}}
    counts = {"agentdojo_installed": version("agentdojo"), "benchmark_version": a.version, "suites": {}}
    tot_u = tot_i = tot_pairs = 0
    all_tools: set[str] = set()
    for name, suite in get_suites(a.version).items():
        env = suite.load_and_inject_default_environment({})
        catalog = []
        for t in suite.tools:
            props = t.parameters.model_json_schema().get("properties", {})
            catalog.append({"name": t.name, "description": (t.description or "").strip().split("\n")[0][:160],
                            "args": [{"name": k, "type": v.get("type", "any")} for k, v in props.items()]})
        uts, its = {}, {}
        bad = 0
        for tid, t in suite.user_tasks.items():
            try:
                uts[tid] = {"prompt": t.PROMPT, "gold": [call_to_dict(c) for c in t.ground_truth(env)]}
            except Exception as e:  # noqa: BLE001
                bad += 1
                print("ground_truth failed", name, tid, repr(e), file=sys.stderr)
        for tid, t in suite.injection_tasks.items():
            try:
                its[tid] = {"goal": t.GOAL, "gold": [call_to_dict(c) for c in t.ground_truth(env)]}
            except Exception as e:  # noqa: BLE001
                bad += 1
                print("ground_truth failed", name, tid, repr(e), file=sys.stderr)
        records["suites"][name] = {"role": ROLES.get(name, name), "catalog": catalog, "user_tasks": uts, "injection_tasks": its}
        tools = {c["tool"] for t in list(uts.values()) + list(its.values()) for c in t["gold"]}
        all_tools |= tools
        counts["suites"][name] = {
            "user_tasks": len(suite.user_tasks), "injection_tasks": len(suite.injection_tasks),
            "pairs": len(suite.user_tasks) * len(suite.injection_tasks),
            "ground_truth_ok_user": len(uts), "ground_truth_ok_injection": len(its), "ground_truth_failures": bad,
            "user_gold_calls": sum(len(t["gold"]) for t in uts.values()),
            "injection_gold_calls": sum(len(t["gold"]) for t in its.values()),
            "injection_tasks_with_empty_ground_truth": sum(1 for t in its.values() if not t["gold"]),
            "usable_pairs": len(suite.user_tasks) * sum(1 for t in its.values() if t["gold"]),
            "distinct_tools_in_gold": len(tools), "suite_tools": len(suite.tools),
        }
        tot_u += len(suite.user_tasks)
        tot_i += len(suite.injection_tasks)
        tot_pairs += len(suite.user_tasks) * len(suite.injection_tasks)
    counts["total"] = {"user_tasks": tot_u, "injection_tasks": tot_i, "pairs": tot_pairs, "distinct_tools_in_gold": len(all_tools),
                       "user_gold_calls": sum(s["user_gold_calls"] for s in counts["suites"].values()),
                       "injection_gold_calls": sum(s["injection_gold_calls"] for s in counts["suites"].values())}
    with open(os.path.join(DATA, "agentdojo_records.json"), "w", encoding="utf-8") as f:
        json.dump(records, f)
    with open(os.path.join(DATA, "counts.json"), "w", encoding="utf-8") as f:
        json.dump(counts, f, indent=1)
    print(json.dumps(counts, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
