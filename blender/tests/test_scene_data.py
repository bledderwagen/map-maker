"""Tests for the parser and mesh array building. Plain Python, no Blender needed:

    python3 -m unittest discover blender/tests
"""

import json
import os
import sys
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "map_maker_importer"))

import scene_data  # noqa: E402

SAMPLE = os.path.join(HERE, "..", "..", "docs", "blender", "sample-map.geojson")


def attrs(layer):
    return {a.name: a for a in layer.attributes()}


def feature(geometry, **props):
    return {"type": "Feature", "geometry": geometry, "properties": props}


def square(x=0.0, y=0.0, s=10.0, clockwise=False):
    ring = [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]]
    return {"type": "Polygon", "coordinates": [ring[::-1] if clockwise else ring]}


class SampleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with open(SAMPLE) as f:
            cls.data = json.load(f)
        t = time.time()
        cls.scene = scene_data.parse_scene(cls.data)
        cls.parse_seconds = time.time() - t

    def test_fast(self):
        self.assertLess(self.parse_seconds, 3.0)

    def test_layers(self):
        self.assertEqual(list(self.scene.layers),
                         ["areas", "waterways", "paths", "roads", "railways", "buildings", "points", "labels"])
        self.assertEqual(self.scene.warnings, [])

    def test_every_feature_imported(self):
        total = sum(len(l.features) for l in self.scene.layers.values())
        self.assertEqual(total, self.data["map_maker"]["feature_count"])

    def test_buildings_are_faces(self):
        b = self.scene.layers["buildings"]
        self.assertEqual(b.face_count, len(b.features))
        self.assertEqual(b.edge_count, 0)
        # Closing points and repeated points (from rounding to centimetres) are dropped: one corner
        # per distinct consecutive point
        expected = 0
        for f in self.data["features"]:
            if f["properties"]["layer"] == "buildings":
                ring = f["geometry"]["coordinates"][0]
                expected += sum(1 for i in range(1, len(ring)) if ring[i] != ring[i - 1])
        self.assertEqual(len(b.loop_vertices), expected)
        self.assertEqual(b.vertex_count, expected)
        a = attrs(b)
        for name in ("class_id", "height", "eave_height", "levels", "roof", "feature_index"):
            self.assertEqual(a[name].domain, "FACE", name)
            self.assertEqual(len(a[name].values), b.face_count)
        self.assertEqual(a["height"].data_type, "FLOAT")
        self.assertEqual(a["levels"].data_type, "INT")
        self.assertEqual(b.enums()["roof"][:3], ["flat", "gabled", "dome"])
        roofs = set(a["roof"].values)
        self.assertEqual(roofs, {0, 1, 2})

    def test_faces_point_up(self):
        b = self.scene.layers["areas"]
        for i, start in enumerate(b.loop_starts):
            pts = [(b.co[3 * v], b.co[3 * v + 1]) for v in b.loop_vertices[start:start + b.loop_totals[i]]]
            self.assertGreater(scene_data._signed_area(pts), 0)

    def test_roads_are_point_chains(self):
        r = self.scene.layers["roads"]
        self.assertEqual(r.face_count, 0)
        n = len(r.features)
        self.assertEqual(r.edge_count, r.vertex_count - n)  # one chain per feature
        a = attrs(r)
        for name in ("class_id", "width", "lanes", "bridge", "level", "deck_height", "feature_index"):
            self.assertEqual(a[name].domain, "POINT", name)
            self.assertEqual(len(a[name].values), r.vertex_count)
        self.assertIn(1, a["bridge"].values)
        # Missing optional properties read as 0
        self.assertEqual(set(a["frontage"].values), {0, 1})

    def test_strings(self):
        r = self.scene.layers["roads"]
        s = r.strings()
        self.assertEqual(len(s["name"]), len(r.features))
        self.assertIn("I 45", s["ref"])
        idx = attrs(r)["feature_index"].values
        # feature_index of a vertex finds its feature's name
        v = r.vertex_feature.index(s["ref"].index("I 45"))
        self.assertEqual(s["ref"][idx[v]], "I 45")
        labels = self.scene.layers["labels"].strings()["name"]
        self.assertIn("Garden Estates", labels)

    def test_class_table(self):
        classes = self.scene.classes_in_layer("buildings")
        self.assertEqual(classes[1]["name"], "house")
        self.assertNotIn(20, classes)
        self.assertEqual(self.scene.bounds(), self.data["map_maker"]["data_bounds"])


class RobustnessTest(unittest.TestCase):
    def scene(self, features, meta=True):
        data = {"type": "FeatureCollection", "features": features}
        if meta:
            data["map_maker"] = {
                "format": "map-maker-scene", "version": 1, "layers": ["areas", "buildings"],
                "classes": [{"name": "house", "id": 1, "layer": "buildings", "geometry": "Polygon"},
                            {"name": "wood", "id": 57, "layer": "areas", "geometry": "Polygon"}]}
        return scene_data.parse_scene(data)

    def test_unknown_class_and_properties(self):
        s = self.scene([
            feature(square(), layer="buildings", **{"class": "house"}, class_id=1, height=9, roof="gabled"),
            feature(square(20), layer="buildings", **{"class": "pagoda"}, class_id=99, height=20.5,
                    roof="pagoda", colour="red", solar=True, tags=["a"], position=3),
        ])
        b = s.layers["buildings"]
        a = attrs(b)
        self.assertEqual(a["class_id"].values, [1, 99])
        self.assertEqual(a["height"].data_type, "FLOAT")
        self.assertEqual(a["height"].values, [9.0, 20.5])
        self.assertEqual(a["roof"].values, [1, 3])
        self.assertEqual(b.enums()["roof"], ["flat", "gabled", "dome", "pagoda"])
        self.assertEqual(a["colour"].values, [-1, 0])
        self.assertEqual(a["solar"].values, [0, 1])
        self.assertNotIn("position", a)          # reserved name renamed
        self.assertEqual(a["mm_position"].values, [0, 3])
        self.assertNotIn("tags", a)              # lists are ignored
        self.assertEqual(b.strings()["colour"], ["", "red"])
        self.assertIn(99, s.classes_in_layer("buildings"))

    def test_unknown_layer_and_geometry(self):
        s = self.scene([
            feature({"type": "LineString", "coordinates": [[0, 0], [1, 1], [1, 1], [2, 0]]},
                    layer="tramways", **{"class": "tram"}, class_id=31, width=3),
            feature({"type": "MultiPolygon", "coordinates": [square()["coordinates"], square(30)["coordinates"]]},
                    layer="areas", **{"class": "wood"}, z_order=45),
            feature(None, layer="areas", **{"class": "wood"}),
            feature({"type": "GeometryCollection", "geometries": []}, layer="areas"),
            feature({"type": "Point", "coordinates": [5, 5, 12]}, **{"class": "lamp"}),
        ])
        self.assertIn("tramways", s.layers)
        t = s.layers["tramways"]
        self.assertEqual(t.vertex_count, 3)       # repeated point dropped
        self.assertEqual(t.edge_count, 2)
        areas = s.layers["areas"]
        self.assertEqual(areas.face_count, 2)     # both parts, one feature
        self.assertEqual(attrs(areas)["class_id"].values, [57, 57])  # filled in from the class table
        self.assertEqual(attrs(areas)["feature_index"].values, [0, 0])
        self.assertIn("points", s.layers)        # no layer, Point geometry
        self.assertEqual(len(s.warnings), 2)

    def test_clockwise_ring_is_reversed(self):
        s = self.scene([feature(square(clockwise=True), layer="areas", **{"class": "wood"}, class_id=57)])
        a = s.layers["areas"]
        pts = [(a.co[3 * v], a.co[3 * v + 1]) for v in a.loop_vertices]
        self.assertGreater(scene_data._signed_area(pts), 0)

    def test_degenerate_polygon_skipped(self):
        s = self.scene([feature({"type": "Polygon", "coordinates": [[[0, 0], [1, 1], [0, 0]]]},
                                layer="areas", class_id=57)])
        self.assertNotIn("areas", s.layers)
        self.assertEqual(len(s.warnings), 1)

    def test_mixed_layer_uses_point_domain(self):
        s = self.scene([
            feature(square(), layer="misc", class_id=1, height=5),
            feature({"type": "LineString", "coordinates": [[0, 0], [5, 0]]}, layer="misc", class_id=2, width=4),
        ])
        a = attrs(s.layers["misc"])
        self.assertEqual(a["height"].domain, "FACE")   # only polygons carry it
        self.assertEqual(a["class_id"].domain, "POINT")
        self.assertEqual(a["class_id"].values, [1, 1, 1, 1, 2, 2])
        self.assertEqual(a["feature_index"].domain, "POINT")

    def test_plain_geojson(self):
        s = self.scene([feature(square())], meta=False)
        self.assertIn("areas", s.layers)
        self.assertEqual(s.bounds(), [0.0, 0.0, 10.0, 10.0])
        self.assertEqual(len(s.warnings), 1)

    def test_not_geojson(self):
        with self.assertRaises(ValueError):
            scene_data.parse_scene({"type": "Feature"})


if __name__ == "__main__":
    unittest.main()
