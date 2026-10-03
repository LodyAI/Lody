"""Deterministic coverage, transport and variable-outline checks; no network."""

import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
import zipfile

from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.ttLib import TTFont

spec = importlib.util.spec_from_file_location("recipe", Path(__file__).with_name("prepare-interface-fonts.py"))
recipe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recipe)


class InterfaceFonts(unittest.TestCase):
    def test_partition_covers_non_latin_once_and_prioritizes_ui(self):
        points = {ord(c): c for c in "项目设置天地龘ABCé"}
        groups = recipe.partition(points, {ord(c) for c in "项目设置"})
        self.assertEqual(groups[0], ("ui", sorted(ord(c) for c in "项目设置")))
        self.assertEqual(groups[1], ("common", sorted(ord(c) for c in "天地")))
        flat = [p for _, values in groups for p in values]
        self.assertEqual(len(flat), len(set(flat)))
        self.assertEqual(set(flat), {p for p in points if p >= 0x250})
        self.assertEqual(recipe.unicode_ranges({0x4E00, 0x4E01, 0x4E03}), "U+4E00-4E01,U+4E03")

    def test_generated_assets_preserve_source_design_and_notices(self):
        archive_path = Path(os.environ.get("VIVO_FONT_ARCHIVE", recipe.ROOT / ".cache/interface-fonts/vivo-Sans.zip"))
        archive_bytes = archive_path.read_bytes()
        self.assertEqual(recipe.digest(archive_bytes), recipe.VIVO_ARCHIVE_SHA)
        archive = zipfile.ZipFile(io.BytesIO(archive_bytes))
        source = TTFont(io.BytesIO(archive.read("vivo Sans/OS/Chinese/Simplified Chinese/vivo Sans SC/vivoSansSCVF.ttf")))
        manifest = json.loads((recipe.OUT / "manifest.json").read_text())
        self.assertEqual(manifest["axes"], [["wght", 100.0, 400.0, 850.0], ["opsz", 10.0, 16.0, 22.0]])
        source_cmap = source.getBestCmap()
        locations = [{"wght": 100, "opsz": 10}, {"wght": 400, "opsz": 16}, {"wght": 850, "opsz": 22}]
        source_sets = [source.getGlyphSet(location=location) for location in locations]
        covered = set()
        for record in manifest["subsets"]:
            data = (recipe.OUT / record["file"]).read_bytes()
            self.assertEqual(len(data), record["bytes"])
            self.assertEqual(recipe.digest(data), manifest["files"][record["file"]])
            generated = TTFont(io.BytesIO(data))
            cmap = generated.getBestCmap()
            self.assertFalse(covered & set(record["codepoints"]))
            covered.update(record["codepoints"])
            self.assertTrue(set(record["codepoints"]).issubset(cmap))
            self.assertEqual([[a.axisTag, a.minValue, a.defaultValue, a.maxValue] for a in generated["fvar"].axes], manifest["axes"])
            self.assertEqual({n.toUnicode() for n in source["name"].names if n.nameID == 0}, {n.toUnicode() for n in generated["name"].names if n.nameID == 0})
            # Decompose components so changed glyph IDs cannot disguise a curve change.
            samples = set(record["codepoints"][::max(1, len(record["codepoints"]) // 8)])
            samples.update({ord(c) for c in "项目设置天地龘"} & set(cmap))
            for location, original_set in zip(locations, source_sets):
                generated_set = generated.getGlyphSet(location=location)
                for point in samples:
                    before = DecomposingRecordingPen(original_set)
                    after = DecomposingRecordingPen(generated_set)
                    original_set[source_cmap[point]].draw(before)
                    generated_set[cmap[point]].draw(after)
                    self.assertEqual(before.value, after.value, f"Outline changed: {record['file']} U+{point:X} {location}")
                    self.assertEqual(original_set[source_cmap[point]].width, generated_set[cmap[point]].width)
        self.assertEqual(covered, {p for p in source_cmap if p >= 0x250})
        self.assertEqual(recipe.digest((recipe.OUT / "vivo-LICENSE.txt").read_bytes()), recipe.VIVO_LICENSE_SHA)
        self.assertEqual((recipe.OUT / "vivo-LICENSE.txt").read_bytes(), (recipe.OUT.parent / "vivo-LICENSE.txt").read_bytes())


if __name__ == "__main__":
    unittest.main()
