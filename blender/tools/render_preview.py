"""Imports a map-maker scene headless and renders preview images.

    blender -b --factory-startup --python blender/tools/render_preview.py -- \
        docs/blender/sample-map.geojson docs/images/blender-preview.png [--oblique out.png] [--samples 16]

Also runs with the `bpy` module from PyPI (python render_preview.py -- ...). The top-down view is
orthographic over the file's view_bounds, so it lines up with the 2D map image.
"""

import argparse
import math
import os
import sys
import time

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))  # blender/, so the add-on package imports by name

import map_maker_importer  # noqa: E402
from map_maker_importer import build_scene  # noqa: E402


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    p = argparse.ArgumentParser()
    p.add_argument("scene")
    p.add_argument("top_down")
    p.add_argument("--oblique")
    p.add_argument("--samples", type=int, default=16)
    p.add_argument("--width", type=int, default=1600)
    return p.parse_args(argv)


def setup_render(samples, width, height):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 4
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "Standard"

    world = bpy.data.worlds.new("preview sky")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.62, 0.72, 0.85, 1.0)
    bg.inputs["Strength"].default_value = 0.9
    scene.world = world

    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 3.5
    sun.angle = math.radians(2)
    obj = bpy.data.objects.new("sun", sun)
    obj.rotation_euler = (math.radians(40), 0.0, math.radians(-35))
    scene.collection.objects.link(obj)


def camera(name, location, rotation, ortho_scale=None, lens=50):
    cam = bpy.data.cameras.new(name)
    if ortho_scale:
        cam.type = "ORTHO"
        cam.ortho_scale = ortho_scale
    else:
        cam.lens = lens
    cam.clip_end = 20000
    obj = bpy.data.objects.new(name, cam)
    obj.location = location
    obj.rotation_euler = rotation
    bpy.context.scene.collection.objects.link(obj)
    return obj


def render(cam, path):
    bpy.context.scene.camera = cam
    bpy.context.scene.render.filepath = os.path.abspath(path)
    t = time.time()
    bpy.ops.render.render(write_still=True)
    print("Rendered %s in %.0f s" % (path, time.time() - t))


def main():
    a = args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    t = time.time()
    collection, report = build_scene.import_file(a.scene, bpy.context)
    print("\n".join(report))
    print("Import took %.1f s" % (time.time() - t))

    x0, y0, x1, y1 = collection["mm_view_bounds"]
    w, h = x1 - x0, y1 - y0
    height = int(round(a.width * h / w))
    setup_render(a.samples, a.width, height)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2

    top = camera("top down", (cx, cy, 3000.0), (0.0, 0.0, 0.0), ortho_scale=max(w, h))
    render(top, a.top_down)
    if a.oblique:
        # From the south west, looking north east over the river towards the interchange
        oblique = camera("oblique", (cx - 0.1 * w, cy - 0.62 * h, 620.0),
                         (math.radians(64), 0.0, math.radians(-28)), lens=28)
        render(oblique, a.oblique)


if __name__ == "__main__":
    main()
