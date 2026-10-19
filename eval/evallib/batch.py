"""Batch runners for the paid families (gemini, openai, xai). One shared lifecycle, one adapter per vendor:

    plan -> submit (chunked, cap-checked) -> poll -> download -> map back to (item_id, sample) -> raw rows

State lives in data/batch-jobs/<run>.json (written after every step), so every stage is resumable:
cells already answered in data/raw/<run>.jsonl, or already inside a live job, are never resubmitted.
Request custom ids are opaque ("c000123"); the id -> (item_id, family, sample) map is stored in the job
file, so odd item ids never reach a vendor. Network access goes through an injectable `http` callable
(tests pass a fake; nothing here is exercised live except where the README says so).

USD cap: before each chunk is submitted, projected spend (actual cost of downloaded rows, the estimate of
jobs still in flight, plus this chunk's estimate) must stay under the cap, else the submit is refused.
The estimate is a conservative upper bound (estimated input tokens plus `est_out_tokens` per call at the
batch price), not a measurement. After download the real cost from logged usage is stored.

xAI: submit calls the hard test-spend guard (~/.claude/scripts/lib/xai-test-guard.mjs) first. That guard
needs XAI_TEST_SPEND_OK, which only Ariel sets; this module never sets it.
"""
from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from datetime import date

from . import jurors as J

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
JOBS_DIR = os.path.join(ROOT, "data", "batch-jobs")
XAI_GUARD = os.path.join(os.path.expanduser("~"), ".claude", "scripts", "lib", "xai-test-guard.mjs")

GEMINI_BASE = "https://generativelanguage.googleapis.com"
OPENAI_BASE = "https://api.openai.com"
XAI_BASE = "https://api.x.ai"

TERMINAL_BAD = "failed"


class CapExceeded(RuntimeError):
    pass


class GuardRefused(RuntimeError):
    pass


# ------------------------------------------------------------------ http
def default_http(method: str, url: str, headers: dict, body: bytes | None, timeout: int = 120) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def _json(http, method, url, headers, payload=None, timeout=120):
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    h = {"Content-Type": "application/json", **headers} if payload is not None else dict(headers)
    status, data = http(method, url, h, body, timeout)
    try:
        obj = json.loads(data.decode("utf-8")) if data else {}
    except json.JSONDecodeError:
        obj = {"_raw": data.decode("utf-8", "ignore")[:500]}
    if status >= 300:
        raise RuntimeError(f"HTTP {status} {method} {url.split('?')[0]}: {json.dumps(obj)[:400]}")
    return obj


# ------------------------------------------------------------------ cost
def batch_price(prices: dict, family: str, discount: float, on: date | None = None) -> tuple[float, float]:
    pin, pout = J.price_for(prices, family, on)
    return pin * discount, pout * discount


def batch_cost_usd(prices, family, discount, tin, tout, on=None) -> float:
    pin, pout = batch_price(prices, family, discount, on)
    return ((tin or 0) * pin + (tout or 0) * pout) / 1e6


def estimate_chunk_usd(prompts: list[str], prices, family, discount, bcfg, on=None) -> float:
    cpt = float(bcfg["est_chars_per_token"])
    tin = sum(len(p) + len(J.SYSTEM) for p in prompts) / cpt
    tout = float(bcfg["est_out_tokens"]) * len(prompts)
    return batch_cost_usd(prices, family, discount, tin, tout, on)


# ------------------------------------------------------------------ adapters
class Adapter:
    family = ""

    def __init__(self, cfg: dict, http=default_http):
        self.cfg, self.http = cfg, http

    def model(self) -> str:
        return self.cfg[f"{self.family}_model"]

    # submit(list of (cid, prompt)) -> job_id ; poll(job_id) -> 'pending'|'done'|'failed' ; download -> {cid: result}
    def submit(self, reqs, label): raise NotImplementedError
    def poll(self, job_id): raise NotImplementedError
    def download(self, job_id): raise NotImplementedError


def _result(text, model, tin, tout, error="", cost_ticks=None):
    return {"ok": bool(text), "text": text or "", "error": error if not text else "", "returned_model": model,
            "tokens_in": tin, "tokens_out": tout, "cost_ticks": cost_ticks}


class GeminiBatch(Adapter):
    family = "gemini"

    def _h(self):
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            raise RuntimeError("GEMINI_API_KEY unset")
        return {"x-goog-api-key": key}

    def request_body(self, prompt):
        gen = {"maxOutputTokens": self.cfg["max_output_tokens"], "thinkingConfig": {"thinkingLevel": self.cfg["effort"]}}
        return {"contents": [{"role": "user", "parts": [{"text": prompt}]}], "generationConfig": gen,
                "systemInstruction": {"parts": [{"text": J.SYSTEM}]}}

    def submit(self, reqs, label):
        body = {"batch": {"display_name": label, "input_config": {"requests": {"requests": [
            {"request": self.request_body(p), "metadata": {"key": cid}} for cid, p in reqs]}}}}
        o = _json(self.http, "POST", f"{GEMINI_BASE}/v1beta/models/{self.model()}:batchGenerateContent", self._h(), body)
        name = o.get("name") or (o.get("batch") or {}).get("name")
        if not name:
            raise RuntimeError(f"gemini batch: no job name in {json.dumps(o)[:300]}")
        return name

    def _get(self, job_id):
        return _json(self.http, "GET", f"{GEMINI_BASE}/v1beta/{job_id}", self._h())

    def poll(self, job_id):
        o = self._get(job_id)
        st = (o.get("metadata") or {}).get("state") or o.get("state") or ""
        if st.endswith("SUCCEEDED") or (o.get("done") and not o.get("error") and "FAIL" not in st):
            return "done"
        if any(x in st for x in ("FAILED", "CANCELLED", "EXPIRED")) or o.get("error"):
            return TERMINAL_BAD
        return "pending"

    def download(self, job_id):
        o = self._get(job_id)
        resp = o.get("response") or {}
        inl = resp.get("inlinedResponses") or (o.get("dest") or {}).get("inlinedResponses") or {}
        entries = inl.get("inlinedResponses") if isinstance(inl, dict) else inl
        out = {}
        for e in entries or []:
            cid = (e.get("metadata") or {}).get("key")
            if cid is None:
                continue
            if e.get("error") or not e.get("response"):
                out[cid] = _result("", None, None, None, error=json.dumps(e.get("error"))[:300] or "no response")
                continue
            d = e["response"]
            parts = [p.get("text", "") for c in d.get("candidates", []) for p in c.get("content", {}).get("parts", []) if not p.get("thought")]
            u = d.get("usageMetadata", {})
            out[cid] = _result("".join(parts).strip(), d.get("modelVersion"), u.get("promptTokenCount"),
                               (u.get("candidatesTokenCount") or 0) + (u.get("thoughtsTokenCount") or 0), error="empty")
        return out


def responses_body(model, prompt, cfg):
    return {"model": model, "input": [{"role": "system", "content": J.SYSTEM}, {"role": "user", "content": prompt}],
            "reasoning": {"effort": cfg["effort"]}, "max_output_tokens": cfg["max_output_tokens"]}


def responses_text(d: dict) -> str:
    t = d.get("output_text") if isinstance(d.get("output_text"), str) else ""
    if not t:
        t = "".join(c.get("text", "") for it in d.get("output", []) if it.get("type") == "message"
                    for c in it.get("content", []) if c.get("type") in ("output_text", "text"))
    return t.strip()


def _from_responses_body(d: dict):
    u = d.get("usage") or {}
    return _result(responses_text(d), d.get("model"), u.get("input_tokens"), u.get("output_tokens"), error="empty",
                   cost_ticks=u.get("cost_in_usd_ticks"))


class OpenAIBatch(Adapter):
    family = "openai"

    def _h(self):
        key = os.environ.get("OPENAI_API_KEY")
        if not key:
            raise RuntimeError("OPENAI_API_KEY unset")
        return {"Authorization": "Bearer " + key}

    def submit(self, reqs, label):
        lines = "\n".join(json.dumps({"custom_id": cid, "method": "POST", "url": "/v1/responses",
                                      "body": responses_body(self.model(), p, self.cfg)}) for cid, p in reqs)
        boundary = "----evalbatch" + uuid.uuid4().hex
        body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\nbatch\r\n"
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{label}.jsonl\"\r\n"
                f"Content-Type: application/jsonl\r\n\r\n{lines}\r\n--{boundary}--\r\n").encode("utf-8")
        status, data = self.http("POST", f"{OPENAI_BASE}/v1/files", {**self._h(), "Content-Type": f"multipart/form-data; boundary={boundary}"}, body, 300)
        f = json.loads(data.decode("utf-8"))
        if status >= 300 or "id" not in f:
            raise RuntimeError(f"openai file upload failed: HTTP {status} {json.dumps(f)[:300]}")
        b = _json(self.http, "POST", f"{OPENAI_BASE}/v1/batches", self._h(),
                  {"input_file_id": f["id"], "endpoint": "/v1/responses", "completion_window": "24h", "metadata": {"label": label[:64]}})
        return b["id"]

    def poll(self, job_id):
        b = _json(self.http, "GET", f"{OPENAI_BASE}/v1/batches/{job_id}", self._h())
        st = b.get("status")
        if st == "completed":
            return "done"
        if st in ("failed", "expired", "cancelled"):
            return TERMINAL_BAD
        return "pending"

    def _file(self, fid):
        status, data = self.http("GET", f"{OPENAI_BASE}/v1/files/{fid}/content", self._h(), None, 300)
        if status >= 300:
            raise RuntimeError(f"openai file {fid}: HTTP {status}")
        return [json.loads(l) for l in data.decode("utf-8").splitlines() if l.strip()]

    def download(self, job_id):
        b = _json(self.http, "GET", f"{OPENAI_BASE}/v1/batches/{job_id}", self._h())
        out = {}
        for fid in (b.get("output_file_id"), b.get("error_file_id")):
            if not fid:
                continue
            for row in self._file(fid):
                cid, resp = row.get("custom_id"), row.get("response") or {}
                if row.get("error") or resp.get("status_code") != 200:
                    out.setdefault(cid, _result("", None, None, None, error=json.dumps(row.get("error") or resp)[:300]))
                else:
                    out[cid] = _from_responses_body(resp.get("body") or {})
        return out


def xai_guard(estimate_usd: float, runner=subprocess.run) -> None:
    """Hard stop. Exit 0 = allowed and recorded in the daily ledger; anything else = refused."""
    p = runner(["node", XAI_GUARD, "--script", "eval-batch-xai", "--estimate", f"{max(estimate_usd, 0.0001):.4f}"],
               capture_output=True, text=True)
    if p.returncode != 0:
        raise GuardRefused((p.stderr or p.stdout or "xai-test-guard refused").strip()[:500])


class XaiBatch(Adapter):
    """UNVERIFIED against the live service (no xAI call is permitted before the November run). Endpoints and
    shapes follow memory feedback_use_xai_batch_api_where_possible.md; result parsing is deliberately tolerant."""
    family = "xai"

    def __init__(self, cfg, http=default_http, guard=xai_guard):
        super().__init__(cfg, http)
        self.guard = guard

    def _h(self):
        key = os.environ.get("XAI_API_KEY")
        if not key:
            raise RuntimeError("XAI_API_KEY unset")
        return {"Authorization": "Bearer " + key}

    def submit(self, reqs, label, estimate_usd: float = 0.0):
        self.guard(estimate_usd)  # BEFORE any network
        b = _json(self.http, "POST", f"{XAI_BASE}/v1/batches", self._h(), {"name": label})
        bid = b.get("batch_id") or b.get("id")
        if not bid:
            raise RuntimeError(f"xai batch: no id in {json.dumps(b)[:300]}")
        brs = [{"batch_request_id": cid, "batch_request": {"responses": responses_body(self.model(), p, self.cfg)}} for cid, p in reqs]
        _json(self.http, "POST", f"{XAI_BASE}/v1/batches/{bid}/requests", self._h(), {"batch_requests": brs}, 300)
        return bid

    def poll(self, job_id):
        b = _json(self.http, "GET", f"{XAI_BASE}/v1/batches/{job_id}", self._h())
        s = b.get("state") or {}
        if s.get("num_pending", 1) == 0 and (s.get("num_requests", 1) > 0):
            return "done"
        return "pending"

    def download(self, job_id):
        out, token = {}, None
        while True:
            url = f"{XAI_BASE}/v1/batches/{job_id}/results?limit=100" + (f"&pagination_token={token}" if token else "")
            o = _json(self.http, "GET", url, self._h())
            for e in o.get("results") or o.get("batch_results") or []:
                cid = e.get("batch_request_id")
                body = _find_response_body(e)
                if body is None:
                    out[cid] = _result("", None, None, None, error=json.dumps(e)[:300])
                else:
                    r = _from_responses_body(body)
                    if r["cost_ticks"] is None:
                        r["cost_ticks"] = _find_key(e, "cost_in_usd_ticks")
                    out[cid] = r
            token = o.get("pagination_token") or o.get("next_pagination_token")
            if not token:
                return out


def _find_response_body(e):
    if isinstance(e, dict):
        if "output" in e or "output_text" in e:
            return e
        for v in e.values():
            r = _find_response_body(v)
            if r is not None:
                return r
    return None


def _find_key(e, k):
    if isinstance(e, dict):
        if k in e:
            return e[k]
        for v in e.values():
            r = _find_key(v, k)
            if r is not None:
                return r
    return None


ADAPTERS = {"gemini": GeminiBatch, "openai": OpenAIBatch, "xai": XaiBatch}


# ------------------------------------------------------------------ job file
def job_path(run: str, family: str, jobs_dir: str = JOBS_DIR) -> str:
    return os.path.join(jobs_dir, f"{run}.{family}.json")


def load_state(run, family, jobs_dir=JOBS_DIR) -> dict:
    p = job_path(run, family, jobs_dir)
    if os.path.exists(p):
        with open(p, encoding="utf-8") as fh:
            return json.load(fh)
    return {"run": run, "family": family, "next_cid": 0, "jobs": []}


def save_state(st, jobs_dir=JOBS_DIR):
    os.makedirs(jobs_dir, exist_ok=True)
    p = job_path(st["run"], st["family"], jobs_dir)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(st, fh, indent=1)
    os.replace(tmp, p)


def read_raw(raw_path):
    if not os.path.exists(raw_path):
        return []
    with open(raw_path, encoding="utf-8") as fh:
        return [json.loads(l) for l in fh if l.strip()]


def pin_ok(returned: str | None, pin: str | None) -> bool:
    """A row counts only if the served model is the pinned id (vendors append date suffixes)."""
    return bool(returned) and (not pin or returned == pin or returned.startswith(pin))


def spent_usd(st, raw_rows, family) -> float:
    """Actual cost already logged in raw for this family plus the estimate of jobs not yet downloaded."""
    actual = sum(r.get("cost_usd") or 0.0 for r in raw_rows if r.get("family") == family)
    pending = sum(j.get("est_usd", 0.0) for j in st["jobs"] if not j.get("downloaded") and j["state"] != TERMINAL_BAD)
    return actual + pending


# ------------------------------------------------------------------ stages
def submit_stage(adapter: Adapter, items, run, raw_path, cfg_all, view="gate", purpose="task", samples=3, budget_usd=0.0,
                 chunk_size=None, jobs_dir=JOBS_DIR, limit_chunks=None, on=None):
    fam = adapter.family
    prices, bcfg = cfg_all["prices"], cfg_all["batch"]
    disc = float(bcfg["discount"][fam])
    chunk_size = chunk_size or int(bcfg["chunk_size"][fam])
    st = load_state(run, fam, jobs_dir)
    raw = read_raw(raw_path)
    pin = cfg_all["judge"].get("pins", {}).get(fam)
    done = {(r["item_id"], r["family"], r["sample"]) for r in raw if r.get("verdict") and pin_ok(r.get("returned_model"), pin)}
    inflight = {tuple(c) for j in st["jobs"] if j["state"] != TERMINAL_BAD for c in j["map"].values()}
    _, phash = J.load_prompt()
    cells = [(it, s) for it in items for s in range(samples)
             if (it["item_id"], fam, s) not in done and (it["item_id"], s) not in {(a, b) for a, b in inflight}]
    submitted = 0
    for k in range(0, len(cells), chunk_size):
        if limit_chunks is not None and submitted >= limit_chunks:
            break
        chunk = cells[k:k + chunk_size]
        prompts = [J.build_prompt(it, view, purpose) for it, _ in chunk]
        est = estimate_chunk_usd(prompts, prices, fam, disc, bcfg, on)
        projected = spent_usd(st, raw, fam) + est
        if projected > budget_usd:
            raise CapExceeded(f"{fam}: projected ${projected:.4f} (this chunk ${est:.4f}) exceeds cap ${budget_usd}; nothing submitted for this chunk")
        reqs = []
        cmap = {}
        for (it, s), p in zip(chunk, prompts):
            cid = f"c{st['next_cid']:07d}"
            st["next_cid"] += 1
            reqs.append((cid, p))
            cmap[cid] = [it["item_id"], s]
        label = f"{run}-{fam}-{len(st['jobs'])}"
        job_id = adapter.submit(reqs, label, est) if fam == "xai" else adapter.submit(reqs, label)
        st["jobs"].append({"job_id": job_id, "label": label, "state": "pending", "n": len(reqs), "map": cmap, "est_usd": est,
                           "view": view, "purpose": purpose, "prompt_sha256": phash, "submitted_at": time.time(), "downloaded": False})
        save_state(st, jobs_dir)  # job id on disk before anything else
        submitted += 1
    return st


def poll_stage(adapter, run, jobs_dir=JOBS_DIR):
    st = load_state(run, adapter.family, jobs_dir)
    for j in st["jobs"]:
        if j["state"] in ("done", TERMINAL_BAD) or j["downloaded"]:
            continue
        j["state"] = adapter.poll(j["job_id"])
        save_state(st, jobs_dir)
    return st


def download_stage(adapter, run, raw_path, cfg_all, jobs_dir=JOBS_DIR, on=None):
    """Writes raw rows (appended and flushed before the job is marked downloaded). Returns (state, n_rows, n_failed)."""
    fam = adapter.family
    prices, bcfg = cfg_all["prices"], cfg_all["batch"]
    disc = float(bcfg["discount"][fam])
    st = load_state(run, fam, jobs_dir)
    n_rows = n_failed = 0
    for j in st["jobs"]:
        if j["downloaded"] or j["state"] != "done":
            continue
        res = adapter.download(j["job_id"])
        total = 0.0
        with open(raw_path, "a", encoding="utf-8") as fh:
            for cid, (item_id, s) in j["map"].items():
                r = res.get(cid) or _result("", None, None, None, error="missing from batch output")
                v = J.parse_verdict(r["text"]) if r["ok"] else None
                if r.get("cost_ticks") is not None:
                    cost = r["cost_ticks"] / 1e10
                else:
                    cost = batch_cost_usd(prices, fam, disc, r["tokens_in"], r["tokens_out"], on)
                total += cost
                row = {"run": run, "item_id": item_id, "family": fam, "sample": s, "view": j["view"], "purpose": j["purpose"],
                       "prompt_sha256": j["prompt_sha256"], "ok": r["ok"], "error": r["error"], "text": r["text"],
                       "requested_model": adapter.model(), "returned_model": r["returned_model"], "tokens_in": r["tokens_in"],
                       "tokens_out": r["tokens_out"], "latency_s": None, "via": "batch", "batch_job": j["job_id"],
                       "parsed": v, "verdict": v["verdict"] if v else None, "parse_failed": bool(r["ok"]) and v is None,
                       "cost_usd": cost}
                fh.write(json.dumps(row) + "\n")
                n_rows += 1
                n_failed += 0 if v else 1
            fh.flush()
            os.fsync(fh.fileno())
        j["downloaded"], j["actual_usd"] = True, total
        save_state(st, jobs_dir)
    return st, n_rows, n_failed


def status(run, family, jobs_dir=JOBS_DIR) -> dict:
    st = load_state(run, family, jobs_dir)
    return {"family": family, "jobs": [{k: j[k] for k in ("job_id", "state", "n", "downloaded", "est_usd")} | {"actual_usd": j.get("actual_usd")} for j in st["jobs"]]}
