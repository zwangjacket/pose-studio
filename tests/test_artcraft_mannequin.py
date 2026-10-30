"""Check posing math and lossless retention of the source GLB geometry."""

import importlib.util
import json
import math
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
import artcraft_mannequin as mannequin


class MannequinTests(unittest.TestCase):
    def test_rotation_aims_the_bone_in_requested_direction(self):
        q = mannequin.from_vectors([1, 0, 0], [0, -1, 0])
        for actual, wanted in zip(mannequin.rotate(q, [1, 0, 0]), [0, -1, 0]):
            self.assertAlmostEqual(actual, wanted)

    def test_opposite_vectors_have_a_valid_half_turn(self):
        q = mannequin.from_vectors([0, 1, 0], [0, -1, 0])
        self.assertAlmostEqual(sum(x*x for x in q), 1)
        self.assertAlmostEqual(mannequin.rotate(q, [0, 1, 0])[1], -1)

    def test_glb_roundtrip_preserves_binary_chunk(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "example.glb"
            mannequin.write_glb(path, {"asset": {"version": "2.0"}}, [(mannequin.BIN_CHUNK, b"abcd")])
            doc, chunks = mannequin.read_glb(path)
            self.assertEqual(chunks, [(mannequin.BIN_CHUNK, b"abcd")])
            self.assertEqual(doc["asset"]["version"], "2.0")
            with self.assertRaises(FileExistsError):
                mannequin.write_glb(path, doc, chunks)

    def test_real_export_preserves_skin_weights_and_inverse_bind_matrices(self):
        source = Path(__file__).parents[1] / "models/artcraft-male-doll.glb"
        if not source.exists():
            self.skipTest("Source ArtCraft asset not present")
        before, original_chunks = mannequin.read_glb(source)
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / "posed.glb"
            report = mannequin.build_mannequin(source, output, "wave", "ivory")
            after, chunks = mannequin.read_glb(output)
        self.assertEqual(chunks, original_chunks)
        self.assertEqual(after["skins"], before["skins"])
        self.assertEqual(after["meshes"], before["meshes"])
        self.assertNotIn("animations", after)
        self.assertEqual(report["joint_count"], 52)
        changed = [node for i, node in enumerate(after["nodes"]) if node != before["nodes"][i]]
        self.assertEqual({n["name"] for n in changed}, {
            "mixamorig:LeftArm", "mixamorig:RightArm", "mixamorig:RightForeArm"})


    def test_write_glb_never_overwrites_an_existing_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "example.glb"
            mannequin.write_glb(path, {"asset": {"version": "2.0"}}, [])
            with self.assertRaises(FileExistsError):
                mannequin.write_glb(path, {"asset": {"version": "2.0"}}, [])

    def test_read_glb_rejects_non_glb_data(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "bad.glb"
            path.write_bytes(b"not a glb file at all, just text")
            with self.assertRaises(ValueError):
                mannequin.read_glb(path)

    def test_t_pose_leaves_the_rig_untouched(self):
        doc = {"nodes": [{"name": "mixamorig:LeftArm", "rotation": [0, 0, 0, 1]}]}
        before = json.dumps(doc)
        mannequin.apply_pose(doc, "t-pose")
        self.assertEqual(json.dumps(doc), before)


if __name__ == "__main__":
    unittest.main()
