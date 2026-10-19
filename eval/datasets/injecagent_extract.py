"""InjecAgent -> items (source=injecagent). Reads the JSON only; never runs InjecAgent code.

Run (data dir is untrusted: use -I and keep this script elsewhere):
  eval/.venv/Scripts/python -I eval/datasets/injecagent_extract.py --repo <clone dir> [--settings base]

Real fields (verified 2026-10-18): each case has 'Attacker Tools' (list of names), 'Attacker
Instruction' (natural language), 'Attack Type', 'User Tool', 'User Instruction', 'Tool Parameters'
(a Python-literal string), 'Tool Response Template', 'Tool Response' (with the attacker
instruction substituted). Attacker tool ARGUMENTS are NOT in the data, only the instruction, so
the candidate args are {"_attacker_instruction": <text>} and this is a documented limitation.
"""
from __future__ import annotations

import argparse
import ast
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(HERE), "data")
ROLE = "General-purpose personal assistant with access to consumer apps (shopping, email, banking, smart home, calendar, files, social, health)."


def parse_params(s):
    try:
        v = ast.literal_eval(s)
        return v if isinstance(v, dict) else {"_raw": str(s)}
    except (ValueError, SyntaxError):
        return {"_raw": str(s)}


def load_catalog(repo):
    """Full tool names are toolkit name_for_model + tool name; returns (catalog, resolved names)."""
    tk = json.load(open(os.path.join(repo, "data", "tools.json"), encoding="utf-8"))
    cat = []
    for kit in tk:
        for t in kit.get("tools", []):
            full = kit["name_for_model"] + t["name"]
            cat.append({"name": full, "description": (t.get("summary") or "").strip()[:160],
                        "args": [{"name": p.get("name"), "type": p.get("type", "any")} for p in t.get("parameters", [])]})
    return cat


def build(repo, settings=("base",)):
    catalog = load_catalog(repo)
    names = {c["name"] for c in catalog}
    items, unresolved = [], set()
    seen_user = set()
    for setting in settings:
        for kind in ("dh", "ds"):
            path = os.path.join(repo, "data", f"test_cases_{kind}_{setting}.json")
            for idx, c in enumerate(json.load(open(path, encoding="utf-8"))):
                ut, ui = c["User Tool"], c["User Instruction"]
                params = parse_params(c["Tool Parameters"])
                user_call = {"tool": ut, "args": params}
                for t in [ut] + c["Attacker Tools"]:
                    if t not in names:
                        unresolved.add(t)
                suite = f"injecagent-{kind}"
                if (ut, ui) not in seen_user:
                    seen_user.add((ut, ui))
                    items.append(_mk(f"bgold:injecagent:{len(seen_user)}", suite, "B-gold", "benign", ui, catalog, [], user_call,
                                     None, f"injecagent:{ut}", None, None))
                atk = c["Attacker Tools"][-1]
                cand = {"tool": atk, "args": {"_attacker_instruction": c["Attacker Instruction"]}}
                items.append(_mk(f"minj:injecagent:{setting}:{kind}:{idx}", suite, "M-inj", "malicious", ui, catalog, [user_call], cand,
                                 c["Tool Response"], atk, "injection", c["Attack Type"]))
    return items, sorted(unresolved)


def _mk(item_id, suite, klass, label, purpose, catalog, prefix, cand, out, cluster, mal_type, atype):
    return {"item_id": item_id, "source": "injecagent", "suite": suite, "class": klass,
            "user_task_id": purpose[:60], "injection_task_id": cluster if label == "malicious" else None,
            "purpose_text": purpose, "purpose_role": ROLE, "tool_catalog": catalog, "prefix_calls": prefix,
            "prefix_outputs": [out] if (out and prefix) else None, "candidate": cand, "label": label,
            "mal_type": mal_type, "mal_subtype": atype, "twin_id": None, "subject_family": None, "cluster": cluster}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--settings", default="base", help="comma list of base,enhanced")
    ap.add_argument("--out", default=os.path.join(DATA, "items_injecagent.jsonl"))
    a = ap.parse_args()
    items, unresolved = build(a.repo, tuple(a.settings.split(",")))
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps(it) + "\n")
    by = {}
    for it in items:
        by[it["class"]] = by.get(it["class"], 0) + 1
    print(json.dumps({"items": len(items), "by_class": by, "tools_not_in_tools_json": unresolved,
                      "distinct_attacker_tools": len({i["cluster"] for i in items if i["label"] == "malicious"})}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
