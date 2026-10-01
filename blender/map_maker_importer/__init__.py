"""map-maker scene importer: File > Import > map-maker scene (.geojson)"""

import bpy
from bpy.props import BoolProperty, FloatProperty, StringProperty
from bpy_extras.io_utils import ImportHelper

from . import build_scene


class IMPORT_SCENE_OT_map_maker(bpy.types.Operator, ImportHelper):
    """Import a city exported by map-maker (Download > Blender) as Geometry Nodes driven meshes"""
    bl_idname = "import_scene.map_maker"
    bl_label = "Import map-maker scene"
    bl_options = {"REGISTER", "UNDO", "PRESET"}

    filename_ext = ".geojson"
    filter_glob: StringProperty(default="*.geojson;*.json", options={"HIDDEN"})

    modifiers: BoolProperty(name="Geometry Nodes", default=True,
                            description="Add the Geometry Nodes modifiers that build buildings, roads, areas and trees")
    label_text: BoolProperty(name="Label Text", default=True,
                             description="Make flat text objects for neighbourhood and park labels")
    height_scale: FloatProperty(name="Height Scale", default=1.0, min=0.0, soft_max=5.0,
                                description="Multiplies building heights")
    width_scale: FloatProperty(name="Road Width Scale", default=1.0, min=0.0, soft_max=5.0,
                               description="Multiplies road, railway and path widths")
    bridge_height_scale: FloatProperty(name="Bridge Height Scale", default=1.0, min=0.0, soft_max=5.0,
                                       description="Multiplies the deck height of bridges")
    tree_density: FloatProperty(name="Tree Density", default=0.012, min=0.0, soft_max=0.1, precision=3,
                                description="Trees per square metre in woods")

    def execute(self, context):
        options = build_scene.Options(
            modifiers=self.modifiers, label_text=self.label_text, height_scale=self.height_scale,
            width_scale=self.width_scale, bridge_height_scale=self.bridge_height_scale,
            tree_density=self.tree_density)
        try:
            _, report = build_scene.import_file(self.filepath, context, options)
        except (OSError, ValueError) as e:
            self.report({"ERROR"}, "Could not import %s: %s" % (self.filepath, e))
            return {"CANCELLED"}
        for line in report[1:]:
            self.report({"WARNING"}, line)
        self.report({"INFO"}, report[0])
        return {"FINISHED"}


def menu_func_import(self, context):
    self.layout.operator(IMPORT_SCENE_OT_map_maker.bl_idname, text="map-maker scene (.geojson)")


def register():
    bpy.utils.register_class(IMPORT_SCENE_OT_map_maker)
    bpy.types.TOPBAR_MT_file_import.append(menu_func_import)


def unregister():
    bpy.types.TOPBAR_MT_file_import.remove(menu_func_import)
    bpy.utils.unregister_class(IMPORT_SCENE_OT_map_maker)
