import os
import tempfile
import unittest

from app.routes.api.v1.main import _resource_preview


class ResourcePreviewTests(unittest.TestCase):
    def test_preview_reads_csv_and_converts_missing_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "file.csv")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("sku,qta,note\nABC,3,\nDEF,,\nGHI,2.5,hello\n")

            preview = _resource_preview(path, 20)

        self.assertEqual(preview["filename"], "file.csv")
        self.assertEqual(preview["columns"], ["sku", "qta", "note"])
        self.assertEqual(preview["rows"][0], ["ABC", 3, ""])
        self.assertEqual(preview["rows"][1], ["DEF", "", ""])
        self.assertEqual(preview["rows"][2], ["GHI", 2.5, "hello"])
        self.assertEqual(preview["row_count"], 3)
        self.assertFalse(preview["truncated"])

    def test_preview_limits_rows_and_reports_truncation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "file.csv")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("sku\n" + "\n".join(f"A{i}" for i in range(5)))

            preview = _resource_preview(path, 2)

        self.assertEqual(preview["row_count"], 2)
        self.assertEqual(preview["rows"], [["A0"], ["A1"]])
        self.assertTrue(preview["truncated"])

    def test_preview_rejects_unknown_extension(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "file.txt")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("hello")
            with self.assertRaisesRegex(ValueError, "Unsupported file type"):
                _resource_preview(path, 20)


if __name__ == "__main__":
    unittest.main()
