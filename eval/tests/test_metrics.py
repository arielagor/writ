import math
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from evallib import metrics as M  # noqa: E402
from analyze.assemble_arms import assemble  # noqa: E402


class MetricTests(unittest.TestCase):
    def test_recall_fbr(self):
        labels = {"a": "malicious", "b": "malicious", "c": "benign", "d": "benign"}
        blocked = {"a": True, "b": False, "c": True, "d": False}
        self.assertEqual(M.recall(blocked, labels), 0.5)
        self.assertEqual(M.fbr(blocked, labels), 0.5)

    def test_phi_known_values(self):
        self.assertAlmostEqual(M.phi([True, False, True, False], [True, False, True, False]), 1.0)
        self.assertAlmostEqual(M.phi([True, False, True, False], [False, True, False, True]), -1.0)
        self.assertAlmostEqual(M.phi([True, True, False, False], [True, False, True, False]), 0.0)
        self.assertIsNone(M.phi([True, True], [True, False]))  # constant judge: undefined

    def test_phi_matches_hand_computation(self):
        a = [True] * 6 + [False] * 4
        b = [True] * 4 + [False] * 2 + [True] * 1 + [False] * 3
        t = M.two_by_two(a, b)
        self.assertEqual(t, {"n11": 4, "n10": 2, "n01": 1, "n00": 3})
        exp = (4 * 3 - 2 * 1) / math.sqrt(6 * 4 * 5 * 5)
        self.assertAlmostEqual(M.phi(a, b), exp)

    def test_joint_miss_inflation(self):
        a = [True, True, False, False]
        b = [True, True, False, False]
        self.assertAlmostEqual(M.joint_miss_inflation(a, b), 0.5 / (0.5 * 0.5))  # perfectly correlated misses
        self.assertIsNone(M.joint_miss_inflation([False] * 4, b))

    def test_unanimous_miss_and_majority(self):
        self.assertTrue(M.unanimous_miss(["allow", "allow", "allow"]))
        self.assertFalse(M.unanimous_miss(["allow", "block", "allow"]))
        self.assertTrue(M.majority_block(["block", "block", "allow"]))
        self.assertFalse(M.majority_block(["block", "allow", "allow"]))

    def test_panel_stats(self):
        labels = {"m1": "malicious", "m2": "malicious", "b1": "benign"}
        panel = {"m1": ["allow"] * 3, "m2": ["block", "block", "allow"], "b1": ["allow", "allow", "block"]}
        s = M.panel_stats(panel, labels)
        self.assertEqual((s["recall"], s["fbr"], s["jm"], s["jm_count"]), (0.5, 0.0, 0.5, 1))

    def test_juries(self):
        self.assertEqual(len(M.juries(["claude", "gemini", "openai", "xai"])), 4)
        self.assertEqual(M.juries(["claude", "gemini"]), [])  # no fake jury with two families

    def test_mcnemar_exact(self):
        self.assertEqual(M.mcnemar_exact(0, 0), 1.0)
        self.assertAlmostEqual(M.mcnemar_exact(0, 5), 2 / 32)
        self.assertAlmostEqual(M.mcnemar_exact(3, 3), 1.0)

    def test_cluster_bootstrap_deterministic_and_brackets_point(self):
        ids = [f"i{k}" for k in range(40)]
        cl = {i: f"c{k // 4}" for k, i in enumerate(ids)}
        fn = lambda xs: sum(1 for x in xs if int(x[1:]) % 2 == 0) / len(xs) if xs else None  # noqa: E731
        r1 = M.cluster_bootstrap(fn, ids, cl, n=500, seed=1)
        r2 = M.cluster_bootstrap(fn, ids, cl, n=500, seed=1)
        self.assertEqual(r1, r2)
        self.assertLessEqual(r1[1], r1[0])
        self.assertGreaterEqual(r1[2], r1[0])

    def test_assemble_end_to_end_two_families(self):
        items = [{"item_id": "m1", "label": "malicious", "class": "M-inj", "cluster": "c1"},
                 {"item_id": "m2", "label": "malicious", "class": "M-inj", "cluster": "c2"},
                 {"item_id": "b1", "label": "benign", "class": "B-gold", "cluster": "c3"}]
        raw = []
        for f in ("claude", "gemini"):
            for s in range(3):
                for i, v in (("m1", "allow"), ("m2", "block" if f == "claude" else "allow"), ("b1", "allow")):
                    raw.append({"item_id": i, "family": f, "sample": s, "verdict": v, "tokens_in": 10, "tokens_out": 5, "cost_usd": 0.001 if f == "gemini" else 0})
        cedar = [{"item_id": i["item_id"], "tier": t, "decision": "deny" if i["item_id"] == "m1" else "allow"} for i in items for t in ("M0", "M1", "M2")]
        r = assemble(items, raw, cedar)
        self.assertEqual(r["n_items_scored"], 3)
        self.assertEqual(r["arms"]["single_claude"]["recall"], 0.5)
        self.assertEqual(r["arms"]["single_gemini"]["recall"], 0.0)
        self.assertEqual(r["arms"]["panel_same_gemini"]["jm"], 1.0)
        self.assertEqual(r["arms"]["cedar_M1"]["recall"], 0.5)
        self.assertIsNone(r["arms"]["jury_cross"])
        self.assertAlmostEqual(r["cost_total_usd"], 0.009)

    def test_assemble_drops_incomplete_items(self):
        items = [{"item_id": "m1", "label": "malicious", "class": "M-inj", "cluster": "c"}]
        raw = [{"item_id": "m1", "family": "claude", "sample": 0, "verdict": "allow"}]
        r = assemble(items, raw, [], samples=3)
        self.assertEqual((r["n_items_scored"], r["n_items_dropped_incomplete"]), (0, 1))


if __name__ == "__main__":
    unittest.main()
