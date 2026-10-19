"""Manifest tiers for the Cedar arm (spec section 2). Manifests are emitted as plain dicts
(JSON is YAML) keyed by (tier, suite, user_task_id); the Node arm validates every one with
Writ's own validateManifest (the same check `writ check` runs) before using it.

M0 role: all tools in the suite catalog, no argument constraints.
M1 task-tools: tool names from the task's gold calls only.
M2 task-tight: M1 plus arg_allow exact-value lists for recipient-like string args taken from
   the gold calls. ORACLE upper bound, never a Writ result.
"""
from __future__ import annotations

import re

TIERS = ("M0", "M1", "M2")
# String args treated as "who/where it goes" and pinned in M2.
PIN_KEYS = {"recipient", "url", "email", "channel", "user", "iban", "to", "recipient_email", "participants"}
EXPIRES = "2027-12-31T00:00:00Z"
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,127}$")


def _slug(s: str) -> str:
    s = re.sub(r"[^a-z0-9-]+", "-", s.lower()).strip("-")
    return (s or "x")[:60]


def manifest_key(tier: str, suite: str, user_task_id: str) -> str:
    return f"{tier}:{suite}:{user_task_id}"


def build_manifest(tier: str, suite: str, user_task_id: str, prompt: str, catalog_tools: list[str], gold: list[dict]) -> dict:
    if tier not in TIERS:
        raise ValueError(tier)
    if tier == "M0":
        names = list(dict.fromkeys(catalog_tools))
    else:
        names = list(dict.fromkeys(c["tool"] for c in gold))
    pins: dict[str, dict[str, list[str]]] = {}
    if tier == "M2":
        for c in gold:
            for k, v in (c.get("args") or {}).items():
                if k in PIN_KEYS and isinstance(v, str):
                    vals = pins.setdefault(c["tool"], {}).setdefault(k, [])
                    if v not in vals:
                        vals.append(v)
    tools = []
    for n in names:
        if not NAME_RE.match(n):
            raise ValueError(f"tool name not valid for a Writ manifest: {n!r}")
        t: dict = {"name": n}
        if n in pins:
            t["constraints"] = {"arg_allow": pins[n]}
        tools.append(t)
    return {
        "agent_id": _slug(f"eval-{tier}-{suite}-{user_task_id}"),
        "owner": {"name": "AGOR AI eval harness", "email": "eval@agor.me"},
        "purpose": prompt[:500] or "eval",
        "purpose_id": _slug(f"{tier}-{suite}-{user_task_id}"),
        "allowed_tools": tools,
        "data_classes": ["eval"],
        "credential_ttl_seconds": 900,
        "expires_at": EXPIRES,
        "escalation_contact": "eval@agor.me",
        "deny_by_default": True,
    }


def build_for_items(items: list[dict]) -> dict[str, dict]:
    """One manifest per (tier, suite, user_task) that any item references."""
    out: dict[str, dict] = {}
    seen: dict[tuple, dict] = {}
    for it in items:
        k = (it["suite"], it["user_task_id"])
        if k in seen:
            continue
        # gold of the user task = the prefix plus the candidate only for benign; recompute from the
        # records is cleaner, so items carry it when the builder attached it (see attach_gold).
        seen[k] = it
    for (suite, ut), it in seen.items():
        gold = it.get("_user_gold")
        if gold is None:
            raise ValueError("items must carry _user_gold; call attach_gold(items, records) first")
        names = [c["name"] for c in it["tool_catalog"]]
        for tier in TIERS:
            out[manifest_key(tier, suite, ut)] = build_manifest(tier, suite, ut, it["purpose_text"], names, gold)
    return out


def attach_gold(items: list[dict], records) -> None:
    for it in items:
        if it["source"] == "agentdojo":
            it["_user_gold"] = records["suites"][it["suite"]]["user_tasks"][it["user_task_id"]]["gold"]
        elif it["source"] == "injecagent":
            it["_user_gold"] = it["prefix_calls"][:1] if it["prefix_calls"] else []
