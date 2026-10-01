"""Imports the sample in Blender and checks the evaluated Geometry Nodes output.

    blender -b --factory-startup --python blender/tests/blender_check.py

Also runs with the `bpy` module from PyPI: python blender/tests/blender_check.py
"""

import os
import sys
import time

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))

import map_maker_importer  # noqa: E402

SAMPLE = os.path.join(HERE, "..", "..", "docs", "blender", "sample-map.geojson")

failures = []


def check(ok, message):
    print(("ok    " if ok else "FAIL  ") + message)
    if not ok:
        failures.append(message)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    map_maker_importer.register()
    t = time.time()
    result = bpy.ops.import_scene.map_maker(filepath=SAMPLE)
    seconds = time.time() - t
    check(result == {"FINISHED"}, "operator finished")
    check(seconds < 5.0, "import took %.1f s" % seconds)

    collection = bpy.data.collections["map-maker"]
    names = {o.name for o in collection.objects}
    for layer in ("areas", "roads", "railways", "paths", "waterways", "buildings", "points", "labels", "ground"):
        check(layer in names, "object %s" % layer)

    deps = bpy.context.evaluated_depsgraph_get()

    def evaluated(name):
        return bpy.data.objects[name].evaluated_get(deps).to_mesh()

    # Buildings: every face has a material, roofs reach the tallest height, gables have slopes
    b = bpy.data.objects["buildings"]
    heights = [d.value for d in b.data.attributes["height"].data]
    m = evaluated("buildings")
    top = max(v.co.z for v in m.vertices)
    check(abs(top - max(heights)) < 0.01, "tallest roof %.2f m, tallest height %.2f m" % (top, max(heights)))
    check(all(m.materials[p.material_index] for p in m.polygons), "every building face has a material")
    sloped = sum(1 for p in m.polygons if 0.2 < p.normal.z < 0.95)
    check(sloped > 5000, "%d sloped roof faces" % sloped)
    used = {m.materials[p.material_index].name for p in m.polygons}
    check({"MM roof_gabled", "MM roof_flat", "MM house", "MM storage_tank"} <= used, "roof and class materials used")

    # Roads: bridges rise to their deck height, the ends of bridge pieces stay on the ground
    r = bpy.data.objects["roads"]
    deck = max(d.value for d in r.data.attributes["deck_height"].data)
    m = evaluated("roads")
    zs = [v.co.z for v in m.vertices]
    check(max(zs) > 0.6 + deck * 0.95, "highest road %.2f m, deck height %d m" % (max(zs), deck))
    used = {m.materials[p.material_index].name for p in m.polygons}
    check({"MM motorway", "MM residential"} <= used, "road class materials used")
    ribbons = [p for p in m.polygons if m.materials[p.material_index].name != "MM bridge_deck"]
    upward = sum(1 for p in ribbons if p.normal.z > 0.5)
    check(upward > 0.97 * len(ribbons), "road ribbons face up (%d of %d)" % (upward, len(ribbons)))
    check("MM bridge_deck" in used, "bridge deck slabs")
    low = min(m.vertices[v].co.z for p in ribbons for v in p.vertices)
    check(low > 0.5, "road ribbons sit above the areas (lowest %.2f m)" % low)

    m = evaluated("railways")
    check(len(m.polygons) > 0 and max(v.co.z for v in m.vertices) < 1.0, "railway swept on the ground (no bridges in the sample)")

    # Areas: water stacked above the land it covers, trees in the woods
    trees = sum(1 for inst in deps.object_instances
                if inst.is_instance and inst.parent and inst.parent.original.name == "areas")
    check(trees > 1000, "%d tree instances" % trees)
    m = evaluated("areas")
    check(all(m.materials[p.material_index] for p in m.polygons), "every area face has a material")

    # Strings
    roads = bpy.data.objects["roads"]
    check("I 45" in list(roads["mm_strings"]["ref"]), "road refs kept as a string table")
    check(len(bpy.data.collections["label text"].objects) == 7, "label text objects")

    print("\n%d checks failed" % len(failures) if failures else "\nAll checks passed")
    sys.exit(1 if failures else 0)


main()
