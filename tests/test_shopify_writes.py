import unittest

import app.utilities.shopify as shopify
from app.utilities.shopify import (
    adjust_quantity_to_variant,
    set_activate_quantity_on_location,
)

ITEM = "gid://shopify/InventoryItem/1"
LOCATION = "gid://shopify/Location/2"


class ActivationTests(unittest.TestCase):
    def setUp(self):
        self.original_query = shopify.shopify_query_graph

    def tearDown(self):
        shopify.shopify_query_graph = self.original_query

    def test_activation_uses_idempotent_directive(self):
        seen_queries = []

        def fake_query(**kwargs):
            seen_queries.append(kwargs["query"])
            if "$idempotencyKey" not in kwargs["query"]:
                return {
                    "errors": [{
                        "message": "The @idempotent directive is required for this mutation but was not provided."
                    }]
                }
            return {"inventoryActivate": {
                "inventoryLevel": {"id": "gid://shopify/InventoryLevel/3", "quantities": []}
            }}

        shopify.shopify_query_graph = fake_query
        result = set_activate_quantity_on_location(ITEM, LOCATION, store_id="refrigiwear")

        self.assertNotIn("error", result)
        self.assertEqual(result["inventoryLevel"]["id"], "gid://shopify/InventoryLevel/3")
        self.assertTrue(any("@idempotent" in q for q in seen_queries))

    def test_activation_error_is_returned_not_swallowed(self):
        shopify.shopify_query_graph = lambda **kwargs: {
            "errors": [{"message": "access denied"}]
        }
        result = set_activate_quantity_on_location(ITEM, LOCATION, store_id="refrigiwear")
        self.assertIn("error", result)
        self.assertIn("access denied", result["error"])


class VerificationTests(unittest.TestCase):
    def setUp(self):
        self.original_query = shopify.shopify_query_graph
        self.original_stock = shopify.get_available_quantities_at_location

    def tearDown(self):
        shopify.shopify_query_graph = self.original_query
        shopify.get_available_quantities_at_location = self.original_stock

    def _mutation_result(self):
        return {
            "inventoryAdjustQuantities": {
                "inventoryAdjustmentGroup": {
                    "changes": [{
                        "delta": 1,
                        "location": {"id": LOCATION, "name": "Napoli"},
                        "item": {"id": ITEM, "inventoryLevels": {"nodes": []}},
                    }]
                }
            }
        }

    def test_echoed_delta_without_stock_change_is_rejected(self):
        shopify.shopify_query_graph = lambda **kwargs: self._mutation_result()
        # Before and after both empty -> the delta was never applied.
        shopify.get_available_quantities_at_location = lambda *args, **kwargs: ({}, False)

        result = adjust_quantity_to_variant(
            [{"delta": 1, "inventoryItemId": ITEM, "locationId": LOCATION}],
            store_id="refrigiwear",
        )
        self.assertIn("error", result)
        self.assertIn("verification failed", result["error"].lower())

    def test_verified_final_quantity_is_returned(self):
        shopify.shopify_query_graph = lambda **kwargs: self._mutation_result()
        reads = []

        def fake_stock(item_ids, location_id, store_id=None):
            reads.append(location_id)
            if len(reads) == 1:  # before the mutation
                return ({ITEM: 0}, False)
            return ({ITEM: 1}, False)  # after the mutation

        shopify.get_available_quantities_at_location = fake_stock
        result = adjust_quantity_to_variant(
            [{"delta": 1, "inventoryItemId": ITEM, "locationId": LOCATION}],
            store_id="refrigiwear",
        )
        self.assertNotIn("error", result)
        self.assertEqual(result["final_quantities"][f"{ITEM}|{LOCATION}"], 1)


if __name__ == "__main__":
    unittest.main()
