"""Reads a map-maker scene file into flat arrays, one set per layer, ready for bulk mesh building.

Pure Python with no bpy import, so it can be tested outside Blender. The format is described in
docs/blender-export.md. Everything here is driven by the file itself (the `classes` table and
whatever properties features carry), so unknown classes, layers and properties import without
special cases.
"""

import json
from collections import OrderedDict

FORMAT = "map-maker-scene"
SUPPORTED_VERSION = 1

# Properties that are not turned into attributes. `layer` and `class` are covered by the object
# and `class_id`
SKIP_PROPERTIES = {"layer", "class"}

# Free text, kept only in the per-object string table
TEXT_PROPERTIES = {"name", "ref"}

# String properties that also become INT attributes. Known values keep the numbers the format doc
# suggests, new values are appended
ENUMS = {"roof": ["flat", "gabled", "dome"]}

# Attribute names Blender or Geometry Nodes treat specially
RESERVED = {
    "position", "id", "radius", "material_index", "normal", "shade_smooth", "sharp_face",
    "sharp_edge", "crease_vert", "crease_edge", "uv_seam", "velocity", "tilt", "resolution",
    "cyclic", "handle_left", "handle_right", "nurbs_weight", "curve_type", "nurbs_order",
}

POLYGON, LINE, POINT = 0, 1, 2

FACE_DOMAIN, POINT_DOMAIN = "FACE", "POINT"


def attribute_name(prop):
    """Property name to a safe attribute name"""
    if prop in RESERVED or prop.startswith("."):
        return "mm_" + prop.lstrip(".")
    return prop


class Attribute:
    """One named attribute column"""

    def __init__(self, name, domain, data_type, values):
        self.name = name
        self.domain = domain        # 'FACE' or 'POINT'
        self.data_type = data_type  # 'INT' or 'FLOAT'
        self.values = values

    def __repr__(self):
        return "Attribute(%r, %s, %s, %d values)" % (self.name, self.domain, self.data_type, len(self.values))


class LayerData:
    """Geometry for one layer as flat lists, in the shape Mesh.foreach_set wants.

    Every feature gets its own vertices, nothing is shared or merged. That keeps each line its own
    spline after Mesh to Curve (so bridge pieces can ramp independently) and makes face to point
    attribute interpolation exact.
    """

    def __init__(self, name):
        self.name = name
        self.co = []            # x, y, z per vertex
        self.edges = []         # v0, v1 per edge (lines only, face edges are derived by Blender)
        self.loop_vertices = [] # vertex index per face corner
        self.loop_starts = []   # first corner per face
        self.loop_totals = []   # corners per face
        self.vertex_feature = []  # feature index per vertex
        self.face_feature = []    # feature index per face
        self.features = []        # (id, properties) per feature, in feature_index order
        self.kinds = []           # POLYGON, LINE or POINT per feature (first part for multi geometries)

    @property
    def vertex_count(self):
        return len(self.co) // 3

    @property
    def face_count(self):
        return len(self.loop_starts)

    @property
    def edge_count(self):
        return len(self.edges) // 2

    def _add_vertex(self, xy, feature):
        self.co.append(float(xy[0]))
        self.co.append(float(xy[1]))
        self.co.append(0.0)
        self.vertex_feature.append(feature)
        return len(self.vertex_feature) - 1

    def add_polygon(self, ring, feature):
        """Adds a closed ring as one face. Returns False if it is degenerate"""
        pts = _dedupe(ring)
        if len(pts) > 1 and pts[0][0] == pts[-1][0] and pts[0][1] == pts[-1][1]:
            pts.pop()
        if len(pts) < 3:
            return False
        if _signed_area(pts) < 0:  # The format promises anticlockwise, but faces must point up
            pts.reverse()
        self.loop_starts.append(len(self.loop_vertices))
        self.loop_totals.append(len(pts))
        for p in pts:
            self.loop_vertices.append(self._add_vertex(p, feature))
        self.face_feature.append(feature)
        return True

    def add_line(self, coords, feature):
        pts = _dedupe(coords)
        if len(pts) < 2:
            return False
        prev = self._add_vertex(pts[0], feature)
        for p in pts[1:]:
            v = self._add_vertex(p, feature)
            self.edges.append(prev)
            self.edges.append(v)
            prev = v
        return True

    def add_point(self, xy, feature):
        if not _is_xy(xy):
            return False
        self._add_vertex(xy, feature)
        return True

    # Attributes

    def attributes(self):
        """Named attribute columns: class_id and every numeric property, plus feature_index and
        enum properties such as roof. Polygon-only properties go on the FACE domain, anything that
        lines or points carry goes on the POINT domain so it survives Mesh to Curve"""
        has_polygons = self.face_count > 0
        has_others = any(k != POLYGON for k in self.kinds)

        # Which properties are numeric, their type and which kinds of feature carry them
        seen = OrderedDict()  # name -> [is_float, kinds]
        enum_values = {}
        for (_, props), kind in zip(self.features, self.kinds):
            for key, value in props.items():
                if key in SKIP_PROPERTIES or key in TEXT_PROPERTIES:
                    continue
                if isinstance(value, bool):
                    value = int(value)
                if isinstance(value, (int, float)):
                    entry = seen.setdefault(key, [False, set()])
                    entry[0] = entry[0] or isinstance(value, float)
                    entry[1].add(kind)
                elif isinstance(value, str):
                    table = enum_values.setdefault(key, list(ENUMS.get(key, [])))
                    if value not in table:
                        table.append(value)
                    entry = seen.setdefault(key, [False, set()])
                    entry[1].add(kind)

        out = []
        for key, (is_float, kinds) in seen.items():
            domain = FACE_DOMAIN if kinds == {POLYGON} else POINT_DOMAIN
            if key in enum_values:
                table = enum_values[key]
                index = {v: i for i, v in enumerate(table)}
                per_feature = [index.get(p.get(key), -1) if isinstance(p.get(key), str) else -1
                               for _, p in self.features]
                data_type = "INT"
            else:
                data_type = "FLOAT" if is_float else "INT"
                cast = float if is_float else int
                per_feature = [_number(p.get(key), cast) for _, p in self.features]
            out.append(Attribute(attribute_name(key), domain, data_type, self._spread(per_feature, domain)))

        index_domain = FACE_DOMAIN if has_polygons and not has_others else POINT_DOMAIN
        out.append(Attribute("feature_index", index_domain, "INT",
                             self._spread(list(range(len(self.features))), index_domain)))
        return out

    def enums(self):
        """String values behind the INT enum attributes, {property: [value for 0, 1, ...]}"""
        tables = {}
        for _, props in self.features:
            for key, value in props.items():
                if key in SKIP_PROPERTIES or key in TEXT_PROPERTIES or not isinstance(value, str):
                    continue
                table = tables.setdefault(key, list(ENUMS.get(key, [])))
                if value not in table:
                    table.append(value)
        return tables

    def strings(self):
        """Every string property as a column indexed by feature_index, '' where missing"""
        keys = []
        for _, props in self.features:
            for key, value in props.items():
                if isinstance(value, str) and key not in SKIP_PROPERTIES and key not in keys:
                    keys.append(key)
        return OrderedDict((k, [p.get(k) if isinstance(p.get(k), str) else "" for _, p in self.features])
                           for k in keys)

    def feature_ids(self):
        return [fid if isinstance(fid, int) else -1 for fid, _ in self.features]

    def class_ids(self):
        return sorted({_number(p.get("class_id"), int) for _, p in self.features})

    def _spread(self, per_feature, domain):
        rows = self.face_feature if domain == FACE_DOMAIN else self.vertex_feature
        return [per_feature[f] for f in rows]


class Scene:
    def __init__(self, meta, classes, layers, warnings):
        self.meta = meta          # the map_maker member
        self.classes = classes    # OrderedDict id -> class entry from the file
        self.layers = layers      # OrderedDict name -> LayerData, non-empty layers only
        self.warnings = warnings  # problems that did not stop the import

    @property
    def class_names(self):
        return OrderedDict((cid, c.get("name", str(cid))) for cid, c in self.classes.items())

    def classes_in_layer(self, layer):
        """Class entries for a layer: from the table, plus any ids features use that it lacks"""
        out = OrderedDict((cid, c) for cid, c in self.classes.items() if c.get("layer") == layer)
        if layer in self.layers:
            for cid in self.layers[layer].class_ids():
                if cid not in out and cid >= 0:
                    out[cid] = {"id": cid, "name": "class_%d" % cid, "layer": layer}
        return out

    def bounds(self, key="data_bounds"):
        b = self.meta.get(key)
        if isinstance(b, list) and len(b) == 4 and all(isinstance(v, (int, float)) for v in b):
            return [float(v) for v in b]
        return self._computed_bounds()

    def _computed_bounds(self):
        xs, ys = [], []
        for layer in self.layers.values():
            xs.extend(layer.co[0::3])
            ys.extend(layer.co[1::3])
        if not xs:
            return [-1.0, -1.0, 1.0, 1.0]
        return [min(xs), min(ys), max(xs), max(ys)]


def load_scene(path):
    with open(path, "r", encoding="utf-8") as f:
        return parse_scene(json.load(f))


def parse_scene(data):
    if not isinstance(data, dict) or data.get("type") != "FeatureCollection":
        raise ValueError("Not a GeoJSON FeatureCollection")
    warnings = []
    meta = data.get("map_maker")
    if not isinstance(meta, dict):
        warnings.append("No map_maker header, treating the file as plain GeoJSON in metres")
        meta = {}
    elif meta.get("format") != FORMAT:
        warnings.append("Unexpected format %r" % meta.get("format"))
    if isinstance(meta.get("version"), int) and meta["version"] > SUPPORTED_VERSION:
        warnings.append("File is format version %d, this importer knows version %d"
                        % (meta["version"], SUPPORTED_VERSION))

    classes = OrderedDict()
    by_name = {}
    for c in meta.get("classes") or []:
        if isinstance(c, dict) and isinstance(c.get("id"), int):
            classes[c["id"]] = c
            if isinstance(c.get("name"), str):
                by_name[c["name"]] = c

    layer_order = [l for l in meta.get("layers") or [] if isinstance(l, str)]
    layers = OrderedDict((name, LayerData(name)) for name in layer_order)
    skipped = {}

    for feature in data.get("features") or []:
        if not isinstance(feature, dict):
            continue
        props = feature.get("properties")
        props = dict(props) if isinstance(props, dict) else {}
        geom = feature.get("geometry")
        gtype = geom.get("type") if isinstance(geom, dict) else None
        coords = geom.get("coordinates") if isinstance(geom, dict) else None

        cls = by_name.get(props.get("class"))
        if not isinstance(props.get("class_id"), int):
            props["class_id"] = cls["id"] if cls else -1
        layer_name = props.get("layer")
        if not isinstance(layer_name, str):
            layer_name = cls.get("layer") if cls and isinstance(cls.get("layer"), str) else _default_layer(gtype)
        layer = layers.get(layer_name)
        if layer is None:
            layer = layers[layer_name] = LayerData(layer_name)

        index = len(layer.features)
        added, kind = _add_geometry(layer, gtype, coords, index)
        if added:
            layer.features.append((feature.get("id"), props))
            layer.kinds.append(kind)
        else:
            skipped[gtype] = skipped.get(gtype, 0) + 1

    for gtype, n in skipped.items():
        warnings.append("Skipped %d features with empty or unsupported %s geometry" % (n, gtype))

    layers = OrderedDict((k, v) for k, v in layers.items() if v.features)
    return Scene(meta, classes, layers, warnings)


def _add_geometry(layer, gtype, coords, index):
    """Adds a feature's geometry. Holes are ignored, the format has none"""
    try:
        if gtype == "Polygon":
            return layer.add_polygon(coords[0], index), POLYGON
        if gtype == "MultiPolygon":
            return _any([layer.add_polygon(p[0], index) for p in coords if p]), POLYGON
        if gtype == "LineString":
            return layer.add_line(coords, index), LINE
        if gtype == "MultiLineString":
            return _any([layer.add_line(l, index) for l in coords]), LINE
        if gtype == "Point":
            return layer.add_point(coords, index), POINT
        if gtype == "MultiPoint":
            return _any([layer.add_point(p, index) for p in coords]), POINT
    except (TypeError, IndexError, ValueError):
        pass
    return False, None


def _default_layer(gtype):
    if gtype in ("Polygon", "MultiPolygon"):
        return "areas"
    if gtype in ("LineString", "MultiLineString"):
        return "lines"
    return "points"


def _any(results):
    # A list, not a generator, so every part is added
    return any(results)


def _is_xy(p):
    return (isinstance(p, (list, tuple)) and len(p) >= 2
            and isinstance(p[0], (int, float)) and isinstance(p[1], (int, float)))


def _dedupe(coords):
    """Drops invalid points and repeated consecutive points"""
    out = []
    for p in coords:
        if not _is_xy(p):
            continue
        if out and out[-1][0] == p[0] and out[-1][1] == p[1]:
            continue
        out.append(p)
    return out


def _signed_area(pts):
    area = 0.0
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        area += a[0] * b[1] - b[0] * a[1]
    return area / 2


def _number(value, cast):
    if isinstance(value, bool):
        return cast(int(value))
    if isinstance(value, (int, float)):
        return cast(value)
    return cast(0)
