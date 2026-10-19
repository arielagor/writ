import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from analyze.assemble_arms import MixedModelError, apply_pins, assemble, holm  # noqa: E402

FAMS = ["claude", "gemini", "openai", "xai"]
PINS = {f: f + "-v1" for f in FAMS}


def synth(n_mal=60, n_ben=40, correlated=True, seed=3):
    rnd = random.Random(seed)
    items, raw = [], []
    for k in range(n_mal + n_ben):
        mal = k < n_mal
        iid = f"i{k}"
        items.append({"item_id": iid, "label": "malicious" if mal else "benign", "class": "M-inj" if mal else "B-gold", "cluster": f"c{k // 3}"})
        for f in FAMS:
            hard = rnd.random() < 0.3  # family-specific blind spot, shared by all 3 samples of the family
            for s in range(3):
                if mal:
                    v = "allow" if (hard and rnd.random() < 0.95) else "block"
                    if not correlated:
                        v = "allow" if rnd.random() < 0.3 else "block"
                else:
                    v = "block" if rnd.random() < 0.05 else "allow"
                raw.append({"item_id": iid, "family": f, "sample": s, "verdict": v, "returned_model": PINS[f], "tokens_in": 10, "tokens_out": 5, "cost_usd": 0.0})
    cedar = [{"item_id": i["item_id"], "tier": t, "decision": "allow"} for i in items for t in ("M0", "M1", "M2")]
    return items, raw, cedar


class InferenceTests(unittest.TestCase):
    def test_results_carry_ci_mcnemar_h2_and_phi(self):
        items, raw, cedar = synth()
        r = assemble(items, raw, cedar, pins=PINS, resamples=200)
        inf = r["inference"]
        self.assertIn(inf["H2_ratio_R"]["verdict"], ("SUPPORTED", "FALSIFIED", "INCONCLUSIVE"))
        lo, hi = inf["H2_ratio_R"]["ci"]
        self.assertLessEqual(lo, hi)
        self.assertEqual(set(inf["mcnemar_jm"]), set(FAMS))
        for f, t in inf["mcnemar_jm"].items():
            self.assertTrue(0 <= t["p"] <= t["p_holm"] <= 1)
        self.assertIn("noninferior", inf["fbr_noninferiority"]["claude"])
        self.assertIn("est", inf["phi_diff_within_minus_cross"])
        a = r["arms"]["single_claude"]
        self.assertLessEqual(a["recall_ci"]["ci"][0], a["recall"])
        self.assertGreaterEqual(a["recall_ci"]["ci"][1], a["recall"])
        self.assertIn("fbr_ci", r["arms"]["panel_same_gemini"])
        self.assertIn("recall_ci", r["arms"]["cedar_M0"])
        self.assertTrue(any(k.startswith("hybrid_cedarM1_") for k in r["arms"]))
        self.assertEqual(len([k for k in r["arms"] if k.startswith("jury_cross_") and "excluded_family" in r["arms"].get(k, {})]), 4)

    def test_mcnemar_counts_match_hand_count(self):
        items, raw, cedar = synth()
        r = assemble(items, raw, cedar, pins=PINS, resamples=20)
        t = r["inference"]["mcnemar_jm"]["claude"]
        votes = {(x["item_id"], x["family"], x["sample"]): x["verdict"] for x in raw}
        mal = [i["item_id"] for i in items if i["label"] == "malicious"]
        same = {i: all(votes[(i, "claude", s)] == "allow" for s in range(3)) for i in mal}
        cross = {i: all(votes[(i, f, 0)] == "allow" for f in ("gemini", "openai", "xai")) for i in mal}
        self.assertEqual(t["b_same_only_miss"], sum(1 for i in mal if same[i] and not cross[i]))
        self.assertEqual(t["c_cross_only_miss"], sum(1 for i in mal if not same[i] and cross[i]))

    def test_correlated_panels_give_ratio_below_one(self):
        items, raw, cedar = synth(n_mal=120, correlated=True)
        r = assemble(items, raw, cedar, pins=PINS, resamples=100)
        self.assertLess(r["inference"]["H2_ratio_R"]["est"], 0.5)
        self.assertGreater(r["inference"]["phi_diff_within_minus_cross"]["est"], 0.3)

    def test_deterministic(self):
        items, raw, cedar = synth()
        a = assemble(items, raw, cedar, pins=PINS, resamples=50)["inference"]
        b = assemble(items, raw, cedar, pins=PINS, resamples=50)["inference"]
        self.assertEqual(a, b)

    def test_three_families_skip_h2_with_reason(self):
        items, raw, cedar = synth()
        raw = [x for x in raw if x["family"] != "xai"]
        r = assemble(items, raw, cedar, pins=PINS, resamples=20)
        self.assertEqual(len(r["families_used"]), 3)  # 3 families still form one jury
        r2 = assemble(items, [x for x in raw if x["family"] != "openai"], cedar, pins=PINS, resamples=20)
        self.assertIsNone(r2["inference"]["H2"])

    def test_no_resamples_means_no_inference_block(self):
        items, raw, cedar = synth()
        self.assertNotIn("inference", assemble(items, raw, cedar, pins=PINS))

    def test_holm(self):
        h = holm({"a": 0.01, "b": 0.04, "c": 0.03})
        self.assertAlmostEqual(h["a"], 0.03)
        self.assertAlmostEqual(h["c"], 0.06)
        self.assertAlmostEqual(h["b"], 0.06)


class PinTests(unittest.TestCase):
    def test_mixed_models_refused_without_pins(self):
        raw = [{"family": "claude", "item_id": "a", "sample": 0, "verdict": "allow", "returned_model": "claude-opus-5-5"},
               {"family": "claude", "item_id": "b", "sample": 0, "verdict": "allow", "returned_model": "claude-opus-4-8"}]
        with self.assertRaises(MixedModelError):
            apply_pins(raw, None)
        self.assertEqual(len(apply_pins(raw[:1], None)[0]), 1)

    def test_pins_exclude_off_pin_rows_and_count_them(self):
        raw = [{"family": "claude", "item_id": "a", "sample": 0, "verdict": "allow", "returned_model": "claude-opus-5-5"},
               {"family": "claude", "item_id": "b", "sample": 0, "verdict": "allow", "returned_model": "claude-opus-4-8"},
               {"family": "openai", "item_id": "a", "sample": 0, "verdict": "block", "returned_model": "gpt-5.5-2026-04-23"}]
        kept, ex = apply_pins(raw, {"claude": "claude-opus-5-5", "openai": "gpt-5.5"})
        self.assertEqual((len(kept), ex), (2, {"claude": 1}))

    def test_assemble_drops_items_whose_cell_was_off_pin(self):
        items, raw, cedar = synth(n_mal=5, n_ben=5)
        raw[0]["returned_model"] = "claude-v0"
        r = assemble(items, raw, cedar, pins=PINS)
        self.assertEqual(r["n_items_dropped_incomplete"], 1)
        self.assertEqual(r["rows_excluded_off_pin"], {"claude": 1})
        with self.assertRaises(MixedModelError):
            assemble(items, raw, cedar)


if __name__ == "__main__":
    unittest.main()
