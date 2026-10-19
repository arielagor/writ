import json
import os
import sys
import tempfile
import unittest
from types import SimpleNamespace

import yaml

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from evallib import batch as B  # noqa: E402
import run_batch  # noqa: E402

CFG = yaml.safe_load(open(os.path.join(ROOT, "config.yaml"), encoding="utf-8"))
VERDICT = json.dumps({"verdict": "block", "category": "injection", "confidence": 0.9, "reason": "x"})


def mk_items(n):
    return [{"item_id": f"it/{k}:odd id", "label": "malicious", "class": "M-inj", "cluster": f"c{k}",
             "purpose_text": "p", "purpose_role": "r", "tool_catalog": [{"name": "t", "args": [{"name": "a"}]}],
             "prefix_calls": [], "prefix_outputs": None, "candidate": {"tool": "t", "args": {"a": 1}}} for k in range(n)]


class FakeHttp:
    """Records calls; `routes` is a list of (method, substring, handler(url, headers, body) -> (status, obj|bytes))."""

    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, method, url, headers, body, timeout=120):
        self.calls.append((method, url, headers, body))
        for m, sub, h in self.routes:
            if m == method and sub in url:
                st, obj = h(url, headers, body)
                return st, obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        return 404, b"{}"


def cid_map(http_calls, parse):
    return parse(http_calls)


class Env(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.jobs = os.path.join(self.tmp.name, "jobs")
        self.raw = os.path.join(self.tmp.name, "raw.jsonl")
        os.environ["GEMINI_API_KEY"] = os.environ["OPENAI_API_KEY"] = os.environ["XAI_API_KEY"] = "test-key"

    def tearDown(self):
        self.tmp.cleanup()


class GeminiTests(Env):
    def make(self, state="BATCH_STATE_SUCCEEDED"):
        sent = {}

        def submit(url, h, body):
            sent["body"] = json.loads(body)
            sent["headers"] = h
            return 200, {"name": "batches/abc"}

        def get(url, h, body):
            keys = [r["metadata"]["key"] for r in sent["body"]["batch"]["input_config"]["requests"]["requests"]]
            ents = [{"metadata": {"key": k}, "response": {"candidates": [{"content": {"parts": [{"text": "hmm", "thought": True}, {"text": VERDICT}]}}],
                                                         "usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 100, "thoughtsTokenCount": 50},
                                                         "modelVersion": "gemini-4-argon"}} for k in reversed(keys)]  # order scrambled
            return 200, {"name": "batches/abc", "metadata": {"state": state}, "done": state.endswith("SUCCEEDED"),
                         "response": {"inlinedResponses": {"inlinedResponses": ents}}}
        return FakeHttp([("POST", ":batchGenerateContent", submit), ("GET", "/v1beta/batches/abc", get)]), sent

    def test_full_cycle_maps_results_to_item_ids_and_prices_at_half(self):
        http, sent = self.make()
        ad = B.GeminiBatch(CFG["judge"], http)
        items = mk_items(3)
        B.submit_stage(ad, items, "r", self.raw, CFG, samples=1, budget_usd=5, jobs_dir=self.jobs)
        self.assertEqual(sent["headers"]["x-goog-api-key"], "test-key")
        self.assertNotIn("key=", http.calls[0][1])  # key in header, not URL
        self.assertEqual(len(sent["body"]["batch"]["input_config"]["requests"]["requests"]), 3)
        self.assertNotIn("odd id", json.dumps(sent["body"]))  # opaque custom ids only
        self.assertEqual(B.poll_stage(ad, "r", self.jobs)["jobs"][0]["state"], "done")
        st, n, nf = B.download_stage(ad, "r", self.raw, CFG, self.jobs)
        rows = B.read_raw(self.raw)
        self.assertEqual((n, nf, len(rows)), (3, 0, 3))
        self.assertEqual({r["item_id"] for r in rows}, {i["item_id"] for i in items})
        r = rows[0]
        self.assertEqual((r["verdict"], r["returned_model"], r["tokens_in"], r["tokens_out"], r["via"]), ("block", "gemini-4-argon", 1000, 150, "batch"))
        # 50% of $2/$10 per M: (1000*1 + 150*5)/1e6
        self.assertAlmostEqual(r["cost_usd"], (1000 * 1.0 + 150 * 5.0) / 1e6, places=9)

    def test_pending_state(self):
        http, _ = self.make("BATCH_STATE_RUNNING")
        ad = B.GeminiBatch(CFG["judge"], http)
        B.submit_stage(ad, mk_items(1), "r", self.raw, CFG, samples=1, budget_usd=5, jobs_dir=self.jobs)
        self.assertEqual(B.poll_stage(ad, "r", self.jobs)["jobs"][0]["state"], "pending")
        _, n, _ = B.download_stage(ad, "r", self.raw, CFG, self.jobs)
        self.assertEqual(n, 0)

    def test_resume_does_not_resubmit_inflight_or_answered_cells(self):
        http, _ = self.make()
        ad = B.GeminiBatch(CFG["judge"], http)
        items = mk_items(2)
        B.submit_stage(ad, items, "r", self.raw, CFG, samples=1, budget_usd=5, jobs_dir=self.jobs)
        n_posts = sum(1 for c in http.calls if c[0] == "POST")
        B.submit_stage(ad, items, "r", self.raw, CFG, samples=1, budget_usd=5, jobs_dir=self.jobs)  # in flight
        self.assertEqual(sum(1 for c in http.calls if c[0] == "POST"), n_posts)
        B.poll_stage(ad, "r", self.jobs)
        B.download_stage(ad, "r", self.raw, CFG, self.jobs)
        B.submit_stage(ad, items, "r", self.raw, CFG, samples=1, budget_usd=5, jobs_dir=self.jobs)  # answered
        self.assertEqual(sum(1 for c in http.calls if c[0] == "POST"), n_posts)
        _, n, _ = B.download_stage(ad, "r", self.raw, CFG, self.jobs)  # already downloaded: no duplicate rows
        self.assertEqual((n, len(B.read_raw(self.raw))), (0, 2))

    def test_off_pin_rows_are_resubmitted(self):
        http, _ = self.make()
        ad = B.GeminiBatch(CFG["judge"], http)
        items = mk_items(1)
        json.dump({}, open(os.path.join(self.tmp.name, "x"), "w"))
        with open(self.raw, "w") as fh:
            fh.write(json.dumps({"item_id": items[0]["item_id"], "family": "gemini", "sample": 0, "verdict": "allow",
                                 "returned_model": "gemini-3.1-pro-preview", "cost_usd": 0.0}) + "\n")
        B.submit_stage(ad, items, "r", self.raw, CFG, samples=1, budget_usd=5, jobs_dir=self.jobs)
        self.assertEqual(len(B.load_state("r", "gemini", self.jobs)["jobs"]), 1)

    def test_failed_job_state(self):
        http, _ = self.make("BATCH_STATE_FAILED")
        ad = B.GeminiBatch(CFG["judge"], http)
        B.submit_stage(ad, mk_items(1), "r", self.raw, CFG, samples=1, budget_usd=5, jobs_dir=self.jobs)
        self.assertEqual(B.poll_stage(ad, "r", self.jobs)["jobs"][0]["state"], "failed")
        # a failed job's cells go back to the queue
        B.submit_stage(ad, mk_items(1), "r", self.raw, CFG, samples=1, budget_usd=5, jobs_dir=self.jobs)
        self.assertEqual(len(B.load_state("r", "gemini", self.jobs)["jobs"]), 2)


class CapTests(Env):
    def test_cap_refuses_before_any_network_call(self):
        http = FakeHttp([])
        ad = B.GeminiBatch(CFG["judge"], http)
        with self.assertRaises(B.CapExceeded):
            B.submit_stage(ad, mk_items(50), "r", self.raw, CFG, samples=3, budget_usd=0.0001, jobs_dir=self.jobs)
        self.assertEqual(http.calls, [])

    def test_cap_counts_inflight_estimates_and_prior_actual_spend(self):
        http = FakeHttp([("POST", ":batchGenerateContent", lambda u, h, b: (200, {"name": "batches/z"}))])
        ad = B.GeminiBatch(CFG["judge"], http)
        est = B.estimate_chunk_usd([B.J.build_prompt(i) for i in mk_items(1)], CFG["prices"], "gemini", 0.5, CFG["batch"])
        B.submit_stage(ad, mk_items(2), "r", self.raw, CFG, samples=1, budget_usd=est * 2.5, jobs_dir=self.jobs, chunk_size=1)
        # two 1-item chunks fit; a third would push past 2.5 estimates
        self.assertEqual(len(B.load_state("r", "gemini", self.jobs)["jobs"]), 2)
        with self.assertRaises(B.CapExceeded):
            B.submit_stage(ad, mk_items(3), "r", self.raw, CFG, samples=1, budget_usd=est * 2.5, jobs_dir=self.jobs, chunk_size=1)

    def test_cli_requires_a_budget(self):
        rc = run_batch.main(["submit", "--run", "r", "--family", "gemini", "--jobs-dir", self.jobs, "--raw-dir", self.tmp.name],
                            http=FakeHttp([]))
        self.assertEqual(rc, 2)


class OpenAITests(Env):
    def make(self):
        st = {}

        def upload(url, h, body):
            st["upload"] = body.decode()
            st["ct"] = h["Content-Type"]
            return 200, {"id": "file-1"}

        def mkbatch(url, h, body):
            st["batch"] = json.loads(body)
            return 200, {"id": "batch_1"}

        def getb(url, h, body):
            return 200, {"id": "batch_1", "status": st.get("status", "completed"), "output_file_id": "file-out", "error_file_id": "file-err"}

        def content(url, h, body):
            lines = [l for l in st["upload"].splitlines() if l.startswith("{")]
            ids = [json.loads(l)["custom_id"] for l in lines]
            if url.endswith("file-out/content"):
                out = [{"custom_id": ids[1], "response": {"status_code": 200, "body": {
                    "model": "gpt-5.5-2026-04-23", "usage": {"input_tokens": 400, "output_tokens": 60},
                    "output": [{"type": "message", "content": [{"type": "output_text", "text": VERDICT}]}]}}},
                    {"custom_id": ids[0], "response": {"status_code": 200, "body": {
                        "model": "gpt-5.5-2026-04-23", "usage": {"input_tokens": 400, "output_tokens": 60}, "output_text": "not json"}}}]
            else:
                out = [{"custom_id": ids[2], "error": {"code": "x", "message": "boom"}, "response": None}]
            return 200, "\n".join(json.dumps(o) for o in out).encode()
        return FakeHttp([("POST", "/v1/files", upload), ("POST", "/v1/batches", mkbatch), ("GET", "/v1/batches/batch_1", getb),
                         ("GET", "/content", content)]), st

    def test_cycle_with_success_unparseable_and_error_lines(self):
        http, st = self.make()
        ad = B.OpenAIBatch(CFG["judge"], http)
        items = mk_items(3)
        B.submit_stage(ad, items, "r", self.raw, CFG, samples=1, budget_usd=5, jobs_dir=self.jobs)
        self.assertIn("multipart/form-data", st["ct"])
        self.assertEqual(st["batch"]["endpoint"], "/v1/responses")
        self.assertEqual(st["batch"]["completion_window"], "24h")
        self.assertIn('"model": "gpt-5.5-2026-04-23"', st["upload"])
        B.poll_stage(ad, "r", self.jobs)
        _, n, nf = B.download_stage(ad, "r", self.raw, CFG, self.jobs)
        rows = {r["item_id"]: r for r in B.read_raw(self.raw)}
        self.assertEqual((n, nf), (3, 2))
        self.assertEqual(rows[items[1]["item_id"]]["verdict"], "block")
        self.assertTrue(rows[items[0]["item_id"]]["parse_failed"])
        self.assertFalse(rows[items[2]["item_id"]]["ok"])
        self.assertIn("boom", rows[items[2]["item_id"]]["error"])
        # gpt-5.5 batch $2.50 in / $15 out
        self.assertAlmostEqual(rows[items[1]["item_id"]]["cost_usd"], (400 * 2.5 + 60 * 15) / 1e6, places=9)

    def test_in_progress_is_pending(self):
        http, st = self.make()
        st["status"] = "in_progress"
        ad = B.OpenAIBatch(CFG["judge"], http)
        B.submit_stage(ad, mk_items(1), "r", self.raw, CFG, samples=1, budget_usd=5, jobs_dir=self.jobs)
        self.assertEqual(B.poll_stage(ad, "r", self.jobs)["jobs"][0]["state"], "pending")


class XaiTests(Env):
    def make(self):
        sent = {}

        def mk(url, h, body):
            sent["create"] = json.loads(body)
            return 200, {"batch_id": "xb1"}

        def add(url, h, body):
            sent["reqs"] = json.loads(body)["batch_requests"]
            return 200, {}

        def poll(url, h, body):
            return 200, {"state": {"num_requests": 2, "num_pending": sent.get("pending", 0)}}

        def results(url, h, body):
            if "pagination_token=p2" in url:
                e = [{"batch_request_id": sent["reqs"][1]["batch_request_id"], "batch_result": {"response": {"responses": {
                    "model": "grok-4.5", "usage": {"input_tokens": 100, "output_tokens": 20, "cost_in_usd_ticks": 5000000},
                    "output": [{"type": "message", "content": [{"type": "output_text", "text": VERDICT}]}]}}}}]
                return 200, {"results": e}
            e = [{"batch_request_id": sent["reqs"][0]["batch_request_id"], "batch_result": {"error": "bad"}}]
            return 200, {"results": e, "pagination_token": "p2"}
        return FakeHttp([("POST", "/v1/batches/xb1/requests", add), ("POST", "/v1/batches", mk), ("GET", "/results", results),
                         ("GET", "/v1/batches/xb1", poll)]), sent

    def test_guard_refusal_means_zero_network_calls(self):
        http = FakeHttp([])

        def refuse(est):
            raise B.GuardRefused("XAI_TEST_SPEND_OK is not set")
        ad = B.XaiBatch(CFG["judge"], http, refuse)
        with self.assertRaises(B.GuardRefused):
            B.submit_stage(ad, mk_items(2), "r", self.raw, CFG, samples=1, budget_usd=5, jobs_dir=self.jobs)
        self.assertEqual(http.calls, [])

    def test_guard_subprocess_contract(self):
        seen = {}

        def runner(cmd, **kw):
            seen["cmd"] = cmd
            return SimpleNamespace(returncode=3, stdout="", stderr="REFUSED: not set")
        with self.assertRaises(B.GuardRefused):
            B.xai_guard(1.5, runner)
        self.assertIn("xai-test-guard.mjs", seen["cmd"][1])
        self.assertIn("1.5000", seen["cmd"])
        B.xai_guard(1.5, lambda cmd, **kw: SimpleNamespace(returncode=0, stdout="", stderr=""))

    def test_never_sets_the_spend_env_var(self):
        os.environ.pop("XAI_TEST_SPEND_OK", None)
        http, _ = self.make()
        ad = B.XaiBatch(CFG["judge"], http, lambda est: None)
        B.submit_stage(ad, mk_items(2), "r", self.raw, CFG, samples=1, budget_usd=5, jobs_dir=self.jobs)
        self.assertNotIn("XAI_TEST_SPEND_OK", os.environ)

    def test_cycle_with_pagination_and_cost_ticks(self):
        http, sent = self.make()
        ad = B.XaiBatch(CFG["judge"], http, lambda est: None)
        items = mk_items(2)
        B.submit_stage(ad, items, "r", self.raw, CFG, samples=1, budget_usd=5, jobs_dir=self.jobs)
        self.assertEqual(sent["create"]["name"], "r-xai-0")
        self.assertEqual(set(sent["reqs"][0]["batch_request"]), {"responses"})
        self.assertEqual(sent["reqs"][0]["batch_request"]["responses"]["model"], "grok-4.5")
        self.assertEqual(B.poll_stage(ad, "r", self.jobs)["jobs"][0]["state"], "done")
        _, n, nf = B.download_stage(ad, "r", self.raw, CFG, self.jobs)
        rows = {r["item_id"]: r for r in B.read_raw(self.raw)}
        self.assertEqual((n, nf), (2, 1))
        good = rows[items[1]["item_id"]]
        self.assertEqual(good["verdict"], "block")
        self.assertAlmostEqual(good["cost_usd"], 5000000 / 1e10)  # ticks win over the assumed price
        self.assertFalse(rows[items[0]["item_id"]]["ok"])

    def test_pending_until_num_pending_zero(self):
        http, sent = self.make()
        sent["pending"] = 3
        ad = B.XaiBatch(CFG["judge"], http, lambda est: None)
        B.submit_stage(ad, mk_items(2), "r", self.raw, CFG, samples=1, budget_usd=5, jobs_dir=self.jobs)
        self.assertEqual(B.poll_stage(ad, "r", self.jobs)["jobs"][0]["state"], "pending")


class ClaudePinTests(unittest.TestCase):
    def test_pin_ok(self):
        self.assertTrue(B.pin_ok("gpt-5.5-2026-04-23", "gpt-5.5"))
        self.assertTrue(B.pin_ok("claude-opus-5-5", "claude-opus-5-5"))
        self.assertFalse(B.pin_ok("claude-opus-4-8", "claude-opus-5-5"))
        self.assertFalse(B.pin_ok(None, "x"))

    def test_config_pins_cover_all_families_and_claude_has_explicit_model(self):
        self.assertEqual(set(CFG["judge"]["pins"]), {"claude", "gemini", "openai", "xai"})
        self.assertEqual(CFG["judge"]["claude_model"], CFG["judge"]["pins"]["claude"])
        self.assertTrue(CFG["judge"]["openai_model"].startswith(CFG["judge"]["pins"]["openai"]))


if __name__ == "__main__":
    unittest.main()
