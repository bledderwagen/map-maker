"""Builds Blender objects from a parsed scene: one mesh per layer, a ground plane, materials and
the Geometry Nodes modifiers"""

import time

import bpy

from . import node_groups, palette
from .scene_data import load_scene

COLLECTION = "map-maker"

# Lift of each line layer above the ground, so ribbons sit above the stacked areas
LINE_LAYERS = {"paths": 0.5, "railways": 0.55, "roads": 0.6}


class Options:
    def __init__(self, modifiers=True, label_text=True, height_scale=1.0, width_scale=1.0,
                 bridge_height_scale=1.0, tree_density=0.012):
        self.modifiers = modifiers
        self.label_text = label_text
        self.height_scale = height_scale
        self.width_scale = width_scale
        self.bridge_height_scale = bridge_height_scale
        self.tree_density = tree_density


def import_file(path, context, options=None):
    """Imports a scene file. Returns (collection, report lines)"""
    options = options or Options()
    t0 = time.time()
    scene = load_scene(path)
    t_parse = time.time() - t0

    collection = bpy.data.collections.new(COLLECTION)
    context.scene.collection.children.link(collection)
    collection["mm_format"] = scene.meta.get("format", "")
    collection["mm_version"] = scene.meta.get("version", 0)
    collection["mm_view_bounds"] = scene.bounds("view_bounds")
    collection["mm_data_bounds"] = scene.bounds("data_bounds")
    collection["mm_classes"] = {str(cid): name for cid, name in scene.class_names.items()}
    collection["mm_source"] = bpy.path.basename(path)

    objects = {}
    for name, layer in scene.layers.items():
        obj = bpy.data.objects.new(name, _build_mesh(name, layer))
        obj["mm_layer"] = name
        obj["mm_feature_ids"] = layer.feature_ids()
        obj["mm_strings"] = layer.strings()
        obj["mm_enums"] = layer.enums()
        collection.objects.link(obj)
        objects[name] = obj

    ground = _ground(scene.bounds("data_bounds"))
    collection.objects.link(ground)

    if options.modifiers:
        for name, obj in objects.items():
            _add_modifier(scene, name, obj, options)

    if options.label_text and "labels" in objects:
        _label_text(scene.layers["labels"], collection)

    report = ["Imported %d features in %d layers in %.1f s (parse %.1f s)"
              % (sum(len(l.features) for l in scene.layers.values()), len(scene.layers), time.time() - t0, t_parse)]
    report.extend(scene.warnings)
    return collection, report


def _build_mesh(name, layer):
    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(layer.vertex_count)
    mesh.vertices.foreach_set("co", layer.co)
    if layer.edge_count:
        mesh.edges.add(layer.edge_count)
        mesh.edges.foreach_set("vertices", layer.edges)
    if layer.face_count:
        mesh.loops.add(len(layer.loop_vertices))
        mesh.loops.foreach_set("vertex_index", layer.loop_vertices)
        mesh.polygons.add(layer.face_count)
        mesh.polygons.foreach_set("loop_start", layer.loop_starts)
    mesh.update(calc_edges=True)

    for a in layer.attributes():
        attr = mesh.attributes.new(a.name, a.data_type, a.domain)
        attr.data.foreach_set("value", a.values)
    # Attributes are in place before validation, so they stay aligned if anything is removed
    mesh.validate(clean_customdata=False)
    mesh.update()
    return mesh


def _ground(bounds):
    x0, y0, x1, y1 = bounds
    mesh = bpy.data.meshes.new("ground")
    mesh.from_pydata([(x0, y0, 0.0), (x1, y0, 0.0), (x1, y1, 0.0), (x0, y1, 0.0)], [], [(0, 1, 2, 3)])
    mesh.materials.append(material("ground"))
    mesh.update()
    obj = bpy.data.objects.new("ground", mesh)
    obj["mm_layer"] = "ground"
    return obj


def material(class_name, layer=None):
    """Gets or makes the material for a class. Edit the material in Blender to restyle every
    feature of that class"""
    name = "MM " + class_name
    mat = bpy.data.materials.get(name)
    if mat is not None:
        return mat
    hex_colour, roughness = palette.colour(class_name, layer)
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    rgba = palette.srgb_to_linear(hex_colour) + [1.0]
    if bsdf is not None:
        bsdf.inputs["Base Color"].default_value = rgba
        bsdf.inputs["Roughness"].default_value = roughness
    mat.diffuse_color = rgba
    mat.roughness = roughness
    return mat


def _class_materials(scene, layer):
    return [(cid, material(c.get("name", "class_%d" % cid), layer))
            for cid, c in scene.classes_in_layer(layer).items()]


def _set_inputs(modifier, values):
    for item in modifier.node_group.interface.items_tree:
        if getattr(item, "in_out", None) == "INPUT" and item.name in values:
            modifier[item.identifier] = values[item.name]


def _add_modifier(scene, name, obj, options):
    if name == "buildings":
        group = node_groups.buildings_group(_class_materials(scene, name), material("roof_gabled"), material("roof_flat"))
        values = {"Height Scale": options.height_scale}
    elif name in LINE_LAYERS:
        group = node_groups.lines_group("MM " + name.capitalize(), _class_materials(scene, name), LINE_LAYERS[name],
                                         material("bridge_deck"))
        values = {"Width Scale": options.width_scale, "Bridge Height Scale": options.bridge_height_scale}
        # Flat ribbons gain nothing from casting shadows, and where two cross at the same height
        # they would shadow each other black
        obj.visible_shadow = False
    elif name == "areas":
        classes = scene.classes_in_layer(name)
        woods = [cid for cid, c in classes.items() if c.get("name") in ("wood", "forest")]
        group = node_groups.areas_group(_class_materials(scene, name), woods, material("tree_leaves"),
                                        material("tree_conifer"), material("tree_trunk"))
        values = {"Tree Density": options.tree_density}
    else:
        return
    mod = obj.modifiers.new("map-maker", "NODES")
    mod.node_group = group
    _set_inputs(mod, values)


def _label_text(layer, collection):
    """Flat text objects for the labels layer, which is where neighbourhood and park names live"""
    sub = bpy.data.collections.new("label text")
    collection.children.link(sub)
    names = layer.strings().get("name", [])
    mat = material("label")
    for i, (fid, props) in enumerate(layer.features):
        name = names[i] if i < len(names) else ""
        if not name:
            continue
        v = layer.vertex_feature.index(i)
        x, y = layer.co[3 * v], layer.co[3 * v + 1]
        curve = bpy.data.curves.new("label %s" % name, "FONT")
        curve.body = name
        curve.align_x = "CENTER"
        curve.align_y = "CENTER"
        curve.size = 28.0
        curve.materials.append(mat)
        obj = bpy.data.objects.new("label %s" % name, curve)
        obj.location = (x, y, 25.0)
        obj.visible_shadow = False
        obj["mm_feature_index"] = i
        sub.objects.link(obj)
