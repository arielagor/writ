"""Item builder (spec section 2). Pure functions over plain task records, no AgentDojo import,
so it is unit-testable and deterministic.

records = {
  "suites": {
    "<suite>": {
      "role": "one-sentence role (purpose_role)",
      "catalog": [{"name": str, "description": str, "args": [{"name": str, "type": str}]}],
      "user_tasks": {"<id>": {"prompt": str, "gold": [{"tool": str, "args": {...}}]}},
      "injection_tasks": {"<id>": {"goal": str, "gold": [{"tool": str, "args": {...}}]}},
    }
  }
}
"""
from __future__ import annotations

import json
import random

CLASSES = ("B-gold", "B-twin", "M-inj", "M-oop")


def args_key(args: dict) -> str:
    return json.dumps(args, sort_keys=True, default=str)


def _item(suite, source, purpose_task, purpose_role, catalog, prefix, candidate, label, *, item_id,
          user_task_id, injection_task_id=None, klass, mal_type=None, mal_subtype=None, twin_id=None, cluster=None):
    return {
        "item_id": item_id, "source": source, "suite": suite, "class": klass,
        "user_task_id": user_task_id, "injection_task_id": injection_task_id,
        "purpose_text": purpose_task, "purpose_role": purpose_role,
        "tool_catalog": catalog, "prefix_calls": prefix, "prefix_outputs": None,
        "candidate": candidate, "label": label, "mal_type": mal_type, "mal_subtype": mal_subtype,
        "twin_id": twin_id, "subject_family": None,
        "cluster": cluster if cluster is not None else (injection_task_id if label == "malicious" and injection_task_id else f"{suite}:{user_task_id}"),
    }


def build_b_gold(records) -> list[dict]:
    out = []
    for suite, s in records["suites"].items():
        for ut_id, ut in s["user_tasks"].items():
            for k, call in enumerate(ut["gold"]):
                out.append(_item(suite, "agentdojo", ut["prompt"], s["role"], s["catalog"], ut["gold"][:k], call,
                                 "benign", item_id=f"bgold:{suite}:{ut_id}:{k}", user_task_id=ut_id, klass="B-gold"))
    return out


def _allocate(total: int, weights: dict[str, int]) -> dict[str, int]:
    """Largest-remainder allocation of `total` across keys proportional to weights."""
    ssum = sum(weights.values())
    if ssum == 0 or total <= 0:
        return {k: 0 for k in weights}
    raw = {k: total * w / ssum for k, w in weights.items()}
    base = {k: int(v) for k, v in raw.items()}
    rest = total - sum(base.values())
    for k in sorted(raw, key=lambda k: raw[k] - base[k], reverse=True)[:rest]:
        base[k] += 1
    return {k: min(v, weights[k]) for k, v in base.items()}


def build_m_inj_and_twins(records, n_inj: int, seed: int):
    """M-inj: injection-task final gold call after a random user-task prefix; sampled pairs are
    stratified by suite (proportional to pair count) and round-robin over injection tasks.
    B-twin: same tool name as the injection call, args from a user-task gold call of that tool."""
    m_inj, twins, skipped = [], [], 0
    # Injection tasks with an empty ground_truth() (9 of 35 in AgentDojo v1.2.2) cannot yield a call.
    usable = {s: [i for i, t in v["injection_tasks"].items() if t["gold"]] for s, v in records["suites"].items()}
    pair_counts = {s: len(v["user_tasks"]) * len(usable[s]) for s, v in records["suites"].items()}
    alloc = _allocate(n_inj, pair_counts)
    for suite, s in records["suites"].items():
        rng = random.Random(f"{seed}:inj:{suite}")
        per_inj = {}
        for it_id in usable[suite]:
            lst = list(s["user_tasks"])
            rng.shuffle(lst)
            per_inj[it_id] = lst
        order = sorted(per_inj)
        taken = 0
        while taken < alloc[suite]:
            progressed = False
            for it_id in order:
                if taken >= alloc[suite]:
                    break
                if not per_inj[it_id]:
                    continue
                ut_id = per_inj[it_id].pop()
                taken += 1
                progressed = True
                ut, it = s["user_tasks"][ut_id], s["injection_tasks"][it_id]
                if not it["gold"]:
                    continue
                cand = it["gold"][-1]
                k = rng.randint(0, len(ut["gold"]))
                iid = f"minj:{suite}:{ut_id}:{it_id}"
                tid = f"btwin:{suite}:{ut_id}:{it_id}"
                m_inj.append(_item(suite, "agentdojo", ut["prompt"], s["role"], s["catalog"], ut["gold"][:k], cand,
                                   "malicious", item_id=iid, user_task_id=ut_id, injection_task_id=it_id,
                                   klass="M-inj", mal_type="injection", twin_id=tid))
                # twin: prefer the same user task if it legitimately uses this tool
                uses = [(u, i) for u, t in s["user_tasks"].items() for i, c in enumerate(t["gold"]) if c["tool"] == cand["tool"]]
                same = [(u, i) for u, i in uses if u == ut_id]
                pick = same if same else uses
                if not pick:
                    skipped += 1
                    m_inj[-1]["twin_id"] = None
                    continue
                tu, ti = pick[rng.randrange(len(pick))]
                tut = s["user_tasks"][tu]
                twins.append(_item(suite, "agentdojo", tut["prompt"], s["role"], s["catalog"], tut["gold"][:ti], tut["gold"][ti],
                                   "benign", item_id=tid, user_task_id=tu, klass="B-twin", twin_id=iid))
            if not progressed:
                break
    return m_inj, twins, skipped


def _oop_candidates(s) -> list:
    uts = sorted(s["user_tasks"])
    cands = []
    for ut_id in uts:
        ut = s["user_tasks"][ut_id]
        tools = {c["tool"] for c in ut["gold"]}
        keys = {(c["tool"], args_key(c["args"])) for c in ut["gold"]}
        for ut2 in uts:
            if ut2 == ut_id:
                continue
            for c in s["user_tasks"][ut2]["gold"]:
                if c["tool"] not in tools:
                    cands.append((ut_id, ut2, c, "oop_tool"))
                elif (c["tool"], args_key(c["args"])) not in keys:
                    cands.append((ut_id, ut2, c, "oop_arg"))
    return cands


def build_m_oop(records, n_oop: int, seed: int) -> list[dict]:
    """Out-of-purpose, not injected: a gold call of a DIFFERENT user task in the same suite whose
    tool is absent from this task's gold tools (oop_tool) or whose tool is present but whose args
    match none of this task's calls of that tool (oop_arg)."""
    pools = {suite: _oop_candidates(s) for suite, s in records["suites"].items()}
    alloc = _allocate(n_oop, {k: len({(u, c["tool"], args_key(c["args"])) for u, _, c, _ in v}) for k, v in pools.items()})
    out = []
    for suite, s in records["suites"].items():
        rng = random.Random(f"{seed}:oop:{suite}")
        cands = pools[suite]
        rng.shuffle(cands)
        seen = set()
        for ut_id, ut2, c, sub in cands:
            if len(seen) >= alloc[suite]:
                break
            key = (ut_id, c["tool"], args_key(c["args"]))
            if key in seen:
                continue
            seen.add(key)
            ut = s["user_tasks"][ut_id]
            k = rng.randint(0, len(ut["gold"]))
            out.append(_item(suite, "agentdojo", ut["prompt"], s["role"], s["catalog"], ut["gold"][:k], c, "malicious",
                             item_id=f"moop:{suite}:{ut_id}:{ut2}:{len(out)}", user_task_id=ut_id, klass="M-oop",
                             mal_type="out_of_purpose", mal_subtype=sub, cluster=f"{suite}:{ut_id}"))
    return out


def build_all(records, cfg: dict, seed: int) -> tuple[list[dict], dict]:
    n_inj, n_oop = int(cfg["n_m_inj"]), int(cfg["n_m_oop"])
    b_gold = build_b_gold(records)
    m_inj, twins, skipped = build_m_inj_and_twins(records, n_inj, seed)
    m_oop = build_m_oop(records, n_oop, seed)
    items = b_gold + twins + m_inj + m_oop
    ids = [i["item_id"] for i in items]
    assert len(ids) == len(set(ids)), "duplicate item_id"
    stats = {"n_total": len(items), "by_class": {c: sum(1 for i in items if i["class"] == c) for c in CLASSES},
             "twins_skipped_no_user_task_uses_tool": skipped}
    return items, stats


def stratified_sample(items: list[dict], n: int, seed: int) -> list[dict]:
    """n items spread over classes (round-robin by class, deterministic), for smoke tests."""
    rng = random.Random(f"{seed}:smoke")
    by = {c: [i for i in items if i["class"] == c] for c in CLASSES}
    for v in by.values():
        rng.shuffle(v)
    out = []
    while len(out) < n and any(by.values()):
        for c in CLASSES:
            if by[c] and len(out) < n:
                out.append(by[c].pop())
    return out
