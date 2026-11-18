import tempfile
import unittest
from pathlib import Path

import app.utilities.shopify as shopify
from app.utilities.backups import (
    create_backup,
    list_backups,
    load_backup,
    prune_backups,
    validate_backup_id,
)
from app.utilities.shopify import set_quantities_to_values

ITEM = "gid://shopify/InventoryItem/1"
LOCATION = "gid://shopify/Location/2"


class BackupFileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def _backup(self, **overrides):
        kwargs = {
            "source_file": "test.xlsx",
            "sync_mode": "adjust",
            "location": {"id": LOCATION, "name": "Napoli"},
            "items": [
                {
                    "reference": "SKU-1",
                    "inventory_item_id": ITEM,
                    "location_id": LOCATION,
                    "before_quantity": 7,
                    "was_stocked": True,
                }
            ],
        }
        kwargs.update(overrides)
        return create_backup("refrigiwear", base_log_dir=self.root, **kwargs)

    def test_create_list_and_load_round_trip(self):
        backup_id = self._backup()

        backups = list_backups("refrigiwear", base_log_dir=self.root)
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0]["id"], backup_id)
        self.assertEqual(backups[0]["item_count"], 1)
        self.assertEqual(backups[0]["location"]["name"], "Napoli")

        loaded = load_backup("refrigiwear", backup_id, base_log_dir=self.root)
        self.assertEqual(loaded["items"][0]["before_quantity"], 7)
        self.assertEqual(loaded["source_file"], "test.xlsx")
        self.assertTrue((self.root / "refrigiwear" / "backups" / f"{backup_id}.json").is_file())

    def test_prune_keeps_only_newest(self):
        ids = [self._backup(source_file=f"file-{i}.xlsx") for i in range(4)]
        removed = prune_backups("refrigiwear", base_log_dir=self.root, keep=2)

        self.assertEqual(removed, 2)
        names = {p.stem for p in (self.root / "refrigiwear" / "backups").glob("*.json")}
        self.assertEqual(names, set(ids[-2:]))

    def test_invalid_ids_and_store_names_are_rejected(self):
        with self.assertRaises(ValueError):
            validate_backup_id("../etc/passwd")
        with self.assertRaises(ValueError):
            load_backup("../../etc", "20260101_000000_000000_abcdef", base_log_dir=self.root)

    def test_missing_backup_returns_none(self):
        self.assertIsNone(
            load_backup("refrigiwear", "20260101_000000_000000_abcdef", base_log_dir=self.root)
        )


class RestoreQuantityTests(unittest.TestCase):
    def setUp(self):
        self.original_stock = shopify.get_available_quantities_at_location
        self.original_query = shopify.shopify_query_graph
        self.original_activate = shopify.set_activate_quantity_on_location
        self.original_adjust = shopify.adjust_quantity_to_variant

    def tearDown(self):
        shopify.get_available_quantities_at_location = self.original_stock
        shopify.shopify_query_graph = self.original_query
        shopify.set_activate_quantity_on_location = self.original_activate
        shopify.adjust_quantity_to_variant = self.original_adjust

    @staticmethod
    def _mutation():
        return {
            "inventoryAdjustQuantities": {
                "inventoryAdjustmentGroup": {
                    "changes": [{
                        "delta": 2,
                        "location": {"id": LOCATION, "name": "Napoli"},
                        "item": {"id": ITEM, "inventoryLevels": {"nodes": []}},
                    }]
                }
            }
        }

    def test_restore_applies_the_difference_to_reach_target(self):
        reads = []

        def fake_stock(ids, location_id, store_id=None):
            reads.append(1)
            return ({ITEM: 3 if len(reads) == 1 else 5}, False)

        shopify.get_available_quantities_at_location = fake_stock
        shopify.shopify_query_graph = lambda **kwargs: self._mutation()

        result = set_quantities_to_values(
            [{"inventoryItemId": ITEM, "locationId": LOCATION, "quantity": 5}],
            store_id="refrigiwear",
        )

        self.assertNotIn("error", result)
        self.assertEqual(result["final_quantities"][f"{ITEM}|{LOCATION}"], 5)

    def test_restore_mutation_includes_change_from_quantity(self):
        """API 2026-04 rejects idempotent changes without this field."""
        reads = []
        captured = {}

        def fake_stock(ids, location_id, store_id=None):
            reads.append(1)
            return ({ITEM: 15 if len(reads) == 1 else 10}, False)

        def fake_query(**kwargs):
            captured["variables"] = kwargs.get("variables")
            return self._mutation()

        shopify.get_available_quantities_at_location = fake_stock
        shopify.shopify_query_graph = fake_query

        result = set_quantities_to_values(
            [{"inventoryItemId": ITEM, "locationId": LOCATION, "quantity": 10}],
            store_id="refrigiwear",
        )

        self.assertNotIn("error", result)
        changes = captured["variables"]["input"]["changes"]
        self.assertEqual(len(changes), 1)
        self.assertIn("changeFromQuantity", changes[0])
        self.assertEqual(changes[0]["changeFromQuantity"], 15)
        self.assertEqual(changes[0]["delta"], -5)

    def test_restore_activates_unstocked_item_and_sets_quantity(self):
        reads = []

        def fake_stock(ids, location_id, store_id=None):
            reads.append(1)
            # First read: no level; after activation + delta the level holds 4.
            return ({ITEM: None if len(reads) == 1 else 4}, False)

        shopify.get_available_quantities_at_location = fake_stock
        shopify.shopify_query_graph = lambda **kwargs: self._mutation()
        activations = []
        shopify.set_activate_quantity_on_location = lambda **kwargs: activations.append(kwargs) or {
            "inventoryLevel": {"id": "level"}
        }

        result = set_quantities_to_values(
            [{"inventoryItemId": ITEM, "locationId": LOCATION, "quantity": 4}],
            store_id="refrigiwear",
        )

        self.assertEqual(len(activations), 1)
        self.assertNotIn("error", result)

    def test_restore_uses_quantity_exposed_by_activation(self):
        reads = []

        def fake_stock(ids, location_id, store_id=None):
            reads.append(1)
            return ({ITEM: None if len(reads) == 1 else 4}, False)

        shopify.get_available_quantities_at_location = fake_stock
        shopify.set_activate_quantity_on_location = lambda **kwargs: {
            "inventoryLevel": {
                "quantities": [{"name": "available", "quantity": 2}]
            }
        }
        captured = {}

        def fake_adjust(inventories, store_id=None, before_stock=None):
            captured["delta"] = inventories[0]["delta"]
            captured["change_from"] = inventories[0].get("changeFromQuantity")
            return {"final_quantities": {f"{ITEM}|{LOCATION}": 4}}

        shopify.adjust_quantity_to_variant = fake_adjust

        result = set_quantities_to_values(
            [{"inventoryItemId": ITEM, "locationId": LOCATION, "quantity": 4}],
            store_id="refrigiwear",
        )

        self.assertEqual(captured["delta"], 2)
        self.assertEqual(captured["change_from"], 2)
        self.assertNotIn("error", result)

    def test_restore_stops_if_current_stock_cannot_be_read(self):
        shopify.get_available_quantities_at_location = lambda *a, **k: ({ITEM: None}, True)

        result = set_quantities_to_values(
            [{"inventoryItemId": ITEM, "locationId": LOCATION, "quantity": 4}],
            store_id="refrigiwear",
        )

        self.assertIn("error", result)
        self.assertIn("could not read", result["error"].lower())


if __name__ == "__main__":
    unittest.main()
