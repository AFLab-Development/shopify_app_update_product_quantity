import unittest

from app.routes.api.v1.main import _check_payload, _is_blank, _quantity_number
from app.utilities.shopify import get_available_quantities_at_location


class CheckPayloadTests(unittest.TestCase):
    def test_quantity_number_parses_common_cells(self):
        self.assertEqual(_quantity_number(3), 3)
        self.assertEqual(_quantity_number("3"), 3)
        self.assertEqual(_quantity_number(3.0), 3)
        self.assertEqual(_quantity_number(2.5), 2.5)
        self.assertEqual(_quantity_number("-4"), -4)

    def test_quantity_number_rejects_blank_and_invalid_cells(self):
        self.assertIsNone(_quantity_number(None))
        self.assertIsNone(_quantity_number(float("nan")))
        self.assertIsNone(_quantity_number(""))
        self.assertIsNone(_quantity_number("n/a"))
        self.assertIsNone(_quantity_number(True))

    def test_is_blank(self):
        self.assertTrue(_is_blank(None))
        self.assertTrue(_is_blank(float("nan")))
        self.assertFalse(_is_blank(0))
        self.assertFalse(_is_blank("Napoli"))

    def test_check_payload_keeps_legacy_keys_and_adds_report_sections(self):
        payload = _check_payload(
            "file.xlsx", ["id sede", "barcode", "qta", "canale di vendita"],
            True, True, False, "problem",
            missing_fields=["location_id"], total_skus=3,
        )
        self.assertEqual(payload["filename"], "file.xlsx")
        self.assertEqual(payload["total_skus"], 3)
        self.assertEqual(payload["missing_fields"], ["location_id"])
        self.assertFalse(payload["ready_to_sync"])
        for key in ("summary", "target", "warnings", "rows", "preview"):
            self.assertEqual(payload[key], {} if key in ("summary", "target") else [])
        self.assertEqual(payload["missing_rows"], [])
        self.assertEqual(payload["duplicate_rows"], [])

    def test_missing_fields_issue_is_actionable(self):
        payload = _check_payload(
            "file.xlsx", ["sku"], False, False, False,
            "File is missing required fields: location_id",
            missing_fields=["location_id"],
        )
        issue = payload["issues"][0]
        self.assertEqual(issue["code"], "missing_columns")
        self.assertEqual(issue["severity"], "blocking")
        self.assertEqual(issue["items"], ["location"])
        self.assertTrue(issue["fix"])

    def test_check_payload_exposes_structured_issues(self):
        payload = _check_payload(
            "file.xlsx",
            ["sku", "qta", "id sede", "canale di vendita"],
            True, True, False, "File has 2 missing SKUs and 1 duplicate SKU.",
            missing_rows=["AAA", "BBB"],
            duplicate_rows=["CCC"],
            warnings=[
                {
                    "level": "error",
                    "message": "The file targets 2 different locations: 1, 2. Sync will be refused.",
                },
                {"level": "info", "message": "Global location default: Napoli (1)."},
            ],
        )
        issues = payload["issues"]
        self.assertEqual(
            [issue["code"] for issue in issues],
            ["missing_skus", "duplicate_skus", "mixed_locations", "check_info"],
        )
        self.assertEqual(issues[0]["severity"], "blocking")
        self.assertEqual(issues[0]["items"], ["AAA", "BBB"])
        self.assertEqual(issues[0]["count"], 2)
        self.assertTrue(issues[0]["fix"])
        self.assertEqual(issues[2]["severity"], "blocking")
        self.assertEqual(issues[3]["severity"], "info")
        for issue in issues:
            for key in ("code", "severity", "title", "explanation", "fix", "count", "items"):
                self.assertIn(key, issue)

    def test_stock_lookup_distinguishes_unstocked_from_error(self):
        # No ids / no location: nothing attempted, no error.
        self.assertEqual(get_available_quantities_at_location([], "gid://x"), ({}, False))

        import app.utilities.shopify as shopify
        original = shopify.shopify_query_graph
        try:
            # Successful query, item has no level at the location.
            shopify.shopify_query_graph = lambda **kwargs: {
                "item0": {"inventoryLevel": None}
            }
            result = get_available_quantities_at_location(
                ["gid://shopify/InventoryItem/1"], "gid://shopify/Location/2"
            )
            self.assertEqual(result, ({"gid://shopify/InventoryItem/1": None}, False))

            # Failed query is reported separately so the caller never invents 0.
            shopify.shopify_query_graph = lambda **kwargs: {"errors": ["boom"]}
            result = get_available_quantities_at_location(
                ["gid://shopify/InventoryItem/1"], "gid://shopify/Location/2"
            )
            self.assertEqual(result, ({}, True))
        finally:
            shopify.shopify_query_graph = original


if __name__ == "__main__":
    unittest.main()
