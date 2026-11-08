# Copyright 2026 MB AFKzona Group
# SPDX-License-Identifier: Apache-2.0
"""Run the shared JSON test vectors (the TypeScript suite runs the same file)."""

from __future__ import annotations

import json
import unittest
from typing import List

from rationale import SCHEMA_VERSION, validate_statement, validate_statements

from .helpers import ROOT, VECTORS, case_input


def pairs(items: List[List[str]]) -> List[str]:
    return sorted(f"{a}|{b}" for a, b in items)


class VectorTests(unittest.TestCase):
    def test_schema_version_and_bundled_schema(self) -> None:
        self.assertEqual(VECTORS["schemaVersion"], SCHEMA_VERSION)
        bundled = (ROOT / "python" / "src" / "rationale" / "schema.json").read_text(encoding="utf-8")
        self.assertEqual(bundled, (ROOT / "schema" / "statement-schema.json").read_text(encoding="utf-8"))
        self.assertGreater(len(VECTORS["cases"]), 400)

    def test_cases(self) -> None:
        for c in VECTORS["cases"]:
            with self.subTest(c["id"]):
                opts = c.get("options", {})
                r = validate_statement(case_input(c), opts.get("personalData", "warn"))
                exp = c["expect"]
                self.assertEqual(r.ok, exp["ok"], [e.code + ":" + e.attribute for e in r.errors])
                self.assertEqual(pairs([[e.code, e.attribute] for e in r.errors]), pairs(exp.get("errors", [])))
                if "warnings" in exp:
                    self.assertEqual(pairs([[w.code, w.attribute] for w in r.warnings]), pairs(exp["warnings"]))
                if r.ok:
                    assert r.statement is not None
                    for k, v in exp.get("normalized", {}).items():
                        if v is None:
                            self.assertNotIn(k, r.statement)
                        else:
                            self.assertEqual(r.statement[k], v)
                    again = validate_statement(json.loads(json.dumps(r.statement)), "off")
                    self.assertTrue(again.ok)
                    self.assertEqual(again.statement, r.statement)
                else:
                    self.assertIsNone(r.statement)

    def test_batches(self) -> None:
        for b in VECTORS["batches"]:
            with self.subTest(b["id"]):
                results = validate_statements(b["inputs"])
                for r, e in zip(results, b["expect"]):
                    self.assertEqual(r.ok, e["ok"])
                    self.assertEqual(pairs([[x.code, x.attribute] for x in r.errors]), pairs(e.get("errors", [])))


if __name__ == "__main__":
    unittest.main()
