import unittest

import pandas as pd

from app.routes.api.v1.add_locations.main import _collect_location_ids, _normalize_location_id
from app.routes.api.v1.main import (
    LOCATION_COLUMNS,
    _apply_requested_column_value,
)


class LocationInputTests(unittest.TestCase):
    def test_explicit_location_overwrites_an_existing_column(self):
        df = pd.DataFrame({"sku": ["A", "B"], "id sede": ["101947474247", "107277222179"]})

        df, action, previous = _apply_requested_column_value(
            df, LOCATION_COLUMNS, "id sede", "115117195591"
        )

        self.assertEqual(action, "overwritten")
        self.assertEqual(previous, ["101947474247", "107277222179"])
        self.assertEqual(list(df["id sede"]), ["115117195591", "115117195591"])

    def test_explicit_location_adds_a_missing_column(self):
        df = pd.DataFrame({"sku": ["A"]})

        df, action, previous = _apply_requested_column_value(
            df, LOCATION_COLUMNS, "id sede", "115117195591"
        )

        self.assertEqual(action, "added")
        self.assertEqual(previous, [])
        self.assertEqual(list(df["id sede"]), ["115117195591"])

    def test_no_value_leaves_file_untouched(self):
        df = pd.DataFrame({"sku": ["A"], "id sede": ["101947474247"]})

        df, action, previous = _apply_requested_column_value(
            df, LOCATION_COLUMNS, "id sede", None
        )

        self.assertEqual(action, "unchanged")
        self.assertEqual(previous, [])
        self.assertEqual(list(df["id sede"]), ["101947474247"])

    def test_float_location_ids_are_normalized(self):
        # pandas promotes an int column to float when one row is empty
        self.assertEqual(_normalize_location_id(115117195591.0), "115117195591")
        self.assertEqual(_normalize_location_id("115117195591.0"), "115117195591")
        self.assertIsNone(_normalize_location_id(float("nan")))

    def test_collect_location_ids_detects_mixed_files(self):
        rows = [
            {"id sede": 115117195591},
            {"location_id": 107277222179.0},
            {"location": "101947474247"},
        ]
        self.assertEqual(
            sorted(set(_collect_location_ids(rows))),
            ["101947474247", "107277222179", "115117195591"],
        )


if __name__ == "__main__":
    unittest.main()
