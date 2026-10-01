"""Geometry Nodes groups that turn the imported layer meshes into a 3D city.

Each builder takes the materials to use per class_id, so the trees follow the file's classes
table rather than a hard-coded list.
"""

import math

from .node_builder import Tree

FLOAT, INT, BOOL = "NodeSocketFloat", "NodeSocketInt", "NodeSocketBool"


def buildings_group(class_materials, roof_gabled, roof_flat):
    """Footprints extruded to eave_height. Gabled roofs (roof = 1) rise to height with the ridge
    along the longest side, domes (roof = 2, storage tanks) get a low cap, flat roofs stay flat"""
    t = Tree("MM Buildings", [
        ("Height Scale", FLOAT, 1.0, 0.0, 10.0, "Multiplies every building height"),
    ])
    hs = t.arg("Height Scale")
    height = t.attr("height")
    eave = t.attr("eave_height")
    roof = t.attr("roof", "INT")
    gabled = t.int_eq(roof, 1)
    dome = t.int_eq(roof, 2)

    # Roof rise: height above the eaves for gables. Domes have eaves at full height, so their cap
    # (a fraction of the radius, at most a third of the height) comes off the walls
    gable_rise = t.math("MULTIPLY", t.math("MAXIMUM", t.math("SUBTRACT", height, eave), 0.0), hs)
    radius = t.math("SQRT", t.math("DIVIDE", t.out(t.node("GeometryNodeInputMeshFaceArea")), math.pi))
    dome_rise = t.math("MINIMUM", t.math("MULTIPLY", radius, 0.3), t.math("MULTIPLY", t.math("MULTIPLY", eave, hs), 0.33))
    wall = t.math("SUBTRACT", t.math("MULTIPLY", eave, hs), t.math("MULTIPLY", dome_rise, dome))

    walls = t.node("GeometryNodeExtrudeMesh", {
        "Mesh": t.arg("Geometry"), "Offset": t.vec(z=wall)}, mode="FACES")
    top1 = t.out(walls, "Top")

    rise = t.math("ADD", t.math("MULTIPLY", gable_rise, gabled), t.math("MULTIPLY", dome_rise, dome))
    roofs = t.node("GeometryNodeExtrudeMesh", {
        "Mesh": t.out(walls, "Mesh"),
        "Selection": t.bool_op("AND", top1, t.math("GREATER_THAN", rise, 0.01)),
        "Offset": t.vec(z=rise)}, mode="FACES")
    top2 = t.out(roofs, "Top")
    side2 = t.out(roofs, "Side")

    # Ridge direction: the mean of each edge's doubled-angle vector (dx² - dy², 2 dx dy) points
    # along the longest sides of a rectangle, whichever way round its edges run
    ev = t.node("GeometryNodeInputMeshEdgeVertices")
    d = t.node("ShaderNodeSeparateXYZ", {"Vector": t.out(t.node("ShaderNodeVectorMath", {
        0: t.out(ev, "Position 2"), 1: t.out(ev, "Position 1")}, operation="SUBTRACT"))})
    dx, dy = t.out(d, "X"), t.out(d, "Y")
    cos2 = t.math("SUBTRACT", t.math("MULTIPLY", dx, dx), t.math("MULTIPLY", dy, dy))
    sin2 = t.math("MULTIPLY", t.math("MULTIPLY", dx, dy), 2.0)
    on_faces = lambda v: t.out(t.node("GeometryNodeFieldOnDomain", {"Value": v}, domain="EDGE", data_type="FLOAT"))
    angle = t.math("MULTIPLY", t.math("ARCTAN2", on_faces(sin2), on_faces(cos2)), 0.5)
    across = t.vec(t.math("MULTIPLY", t.math("SINE", angle), -1.0), t.math("COSINE", angle), 0.0)

    # Squash the raised top across the ridge: the long sides become the roof slopes and the short
    # sides the gable ends
    geo = t.out(t.node("GeometryNodeScaleElements", {
        "Geometry": t.out(roofs, "Mesh"), "Selection": t.bool_op("AND", top2, gabled),
        "Scale": 0.0, "Axis": across}, domain="FACE", scale_mode="SINGLE_AXIS"))
    geo = t.out(t.node("GeometryNodeScaleElements", {
        "Geometry": geo, "Selection": t.bool_op("AND", top2, dome), "Scale": 0.55},
        domain="FACE", scale_mode="UNIFORM"))
    # The squashed top is now a sliver along the ridge, the slopes meet without it
    geo = t.out(t.node("GeometryNodeDeleteGeometry", {
        "Geometry": geo, "Selection": t.bool_op("AND", top2, gabled)}, domain="FACE", mode="ONLY_FACE"))
    geo = t.out(t.node("GeometryNodeMergeByDistance", {
        "Geometry": geo, "Selection": t.bool_op("AND", t.bool_op("OR", top2, side2), gabled), "Distance": 0.001}))

    geo = t.class_materials(geo, class_materials)
    normal_z = t.out(t.node("ShaderNodeSeparateXYZ", {"Vector": t.out(t.node("GeometryNodeInputNormal"))}), "Z")
    sloped = t.math("GREATER_THAN", normal_z, 0.2)
    # Top1 also covers gabled sheds whose height equals their eaves
    gable_roof = t.bool_op("AND", t.bool_op("AND", t.bool_op("OR", top1, side2), gabled), sloped)
    flat_roof = t.bool_op("AND", t.bool_op("AND", top1, t.bool_op("NOR", gabled, dome)), sloped)
    geo = t.out(t.node("GeometryNodeSetMaterial", {"Geometry": geo, "Selection": gable_roof, "Material": roof_gabled}))
    geo = t.out(t.node("GeometryNodeSetMaterial", {"Geometry": geo, "Selection": flat_roof, "Material": roof_flat}))
    geo = t.out(t.node("GeometryNodeSetShadeSmooth", {"Geometry": geo, "Shade Smooth": False}, domain="FACE"))
    return t.finish(geo)


def lines_group(name, class_materials, z_offset, deck_material):
    """Centrelines swept into flat ribbons scaled by width. Pieces with bridge = 1 rise to
    deck_height and ease back to the ground over the ramp length at each end"""
    t = Tree(name, [
        ("Width Scale", FLOAT, 1.0, 0.0, 10.0, "Multiplies every width"),
        ("Bridge Height Scale", FLOAT, 1.0, 0.0, 10.0, "Multiplies the deck_height of bridges"),
        ("Bridge Ramp Length", FLOAT, 30.0, 0.0, 500.0, "Metres over which a bridge deck eases back to the ground at each end"),
        ("Z Offset", FLOAT, z_offset, -10.0, 10.0, "Lift above the ground, keeps the ribbons above the areas"),
        ("Junction Discs", BOOL, True, None, None, "Round caps at line ends so joints and junctions have no gaps"),
    ])
    width = t.attr("width")
    curve = t.out(t.node("GeometryNodeMeshToCurve", {"Mesh": t.arg("Geometry")}))

    # Distance to the nearer end of the piece, eased from 0 to 1 over the ramp
    sp = t.node("GeometryNodeSplineParameter")
    length = t.out(t.node("GeometryNodeSplineLength"), "Length")
    along = t.out(sp, "Length")
    to_end = t.math("MINIMUM", along, t.math("SUBTRACT", length, along))
    ramp_len = t.math("MAXIMUM", t.math("MINIMUM", t.arg("Bridge Ramp Length"), t.math("MULTIPLY", length, 0.5)), 0.001)
    ramp = t.out(t.node("ShaderNodeMapRange", {"Value": to_end, "From Min": 0.0, "From Max": ramp_len,
                                               "To Min": 0.0, "To Max": 1.0},
                        data_type="FLOAT", interpolation_type="SMOOTHSTEP", clamp=True))
    deck = t.math("MULTIPLY", t.math("MULTIPLY", t.attr("bridge"), t.attr("deck_height")), t.arg("Bridge Height Scale"))
    # Wider roads sit a little higher so they win at junctions. Pieces of the same width are
    # staggered by a few millimetres, as exactly coplanar overlaps shadow each other black
    spline = t.out(t.node("GeometryNodeFieldOnDomain", {"Value": t.out(t.node("GeometryNodeInputIndex"))},
                          domain="CURVE", data_type="INT"))
    stagger = t.math("MULTIPLY", t.math("FLOORED_MODULO", spline, 4.0), 0.002)
    z = t.math("ADD", t.math("ADD", t.arg("Z Offset"), t.math("MULTIPLY", width, 0.01)), stagger)
    z = t.math("ADD", z, t.math("MULTIPLY", deck, ramp))
    curve = t.out(t.node("GeometryNodeSetPosition", {"Geometry": curve, "Offset": t.vec(z=z)}))
    radius = t.math("MULTIPLY", t.math("MULTIPLY", width, t.arg("Width Scale")), 0.5)
    curve = t.out(t.node("GeometryNodeSetCurveRadius", {"Curve": curve, "Radius": radius}))
    curve = t.out(t.node("GeometryNodeSetCurveNormal", {"Curve": curve}, mode="Z_UP"))

    profile = t.out(t.node("GeometryNodeCurvePrimitiveLine", {"Start": (-1.0, 0.0, 0.0), "End": (1.0, 0.0, 0.0)}))
    ribbon = t.out(t.node("GeometryNodeCurveToMesh", {"Curve": curve, "Profile Curve": profile}))

    # Bridge decks: a slab under the ribbon of bridge pieces, a tenth of the width deep
    bridges = t.out(t.node("GeometryNodeSeparateGeometry", {
        "Geometry": curve, "Selection": t.math("GREATER_THAN", t.attr("bridge"), 0.5)}, domain="CURVE"), "Selection")
    slab = t.out(t.node("GeometryNodeCurvePrimitiveQuadrilateral", {"Width": 1.96, "Height": 0.2}, mode="RECTANGLE"))
    # Profile +Y points down with Z-up normals, this puts the slab just under the ribbon
    slab = t.out(t.node("GeometryNodeTransform", {"Geometry": slab, "Translation": (0.0, 0.104, 0.0)}))
    deck = t.out(t.node("GeometryNodeCurveToMesh", {"Curve": bridges, "Profile Curve": slab, "Fill Caps": True}))
    deck = t.out(t.node("GeometryNodeSetShadeSmooth", {"Geometry": deck, "Shade Smooth": False}, domain="FACE"))

    # Discs at line ends fill the wedges where pieces meet at an angle. Ends that meet at the same
    # point are merged into one disc (coplanar duplicates would shadow each other), and the discs
    # sit under every ribbon. Line ends are always on the ground, bridges ramp down to them
    ends = t.bool_op("AND", t.out(t.node("GeometryNodeCurveEndpointSelection", {"Start Size": 1, "End Size": 1})),
                     t.arg("Junction Discs"))
    marked = t.node("GeometryNodeStoreNamedAttribute", {"Geometry": curve, "Name": "mm_end", "Value": ends},
                    data_type="BOOLEAN", domain="POINT")
    points = t.out(t.node("GeometryNodeCurveToPoints", {"Curve": t.out(marked)}, mode="EVALUATED"), "Points")
    points = t.out(t.node("GeometryNodeDeleteGeometry", {
        "Geometry": points, "Selection": t.bool_op("NOT", t.attr("mm_end", "BOOLEAN"))}, domain="POINT"))
    points = t.out(t.node("GeometryNodeMergeByDistance", {"Geometry": points, "Distance": 0.05}))
    xyz = t.node("ShaderNodeSeparateXYZ", {"Vector": t.out(t.node("GeometryNodeInputPosition"))})
    points = t.out(t.node("GeometryNodeSetPosition", {"Geometry": points, "Position": t.vec(
        t.out(xyz, "X"), t.out(xyz, "Y"), t.math("ADD", t.arg("Z Offset"), 0.01))}))
    disc = t.out(t.node("GeometryNodeMeshCircle", {"Vertices": 16, "Radius": 1.0}, fill_type="NGON"))
    discs = t.node("GeometryNodeInstanceOnPoints", {
        "Points": points, "Instance": disc, "Scale": t.out(t.node("GeometryNodeInputRadius"))})
    discs = t.out(t.node("GeometryNodeRealizeInstances", {"Geometry": t.out(discs)}))

    join = t.node("GeometryNodeJoinGeometry")
    t.link(ribbon, join.inputs[0])
    t.link(discs, join.inputs[0])
    geo = t.class_materials(t.out(join), class_materials)
    join = t.node("GeometryNodeJoinGeometry")
    t.link(geo, join.inputs[0])
    t.link(t.out(t.node("GeometryNodeSetMaterial", {"Geometry": deck, "Material": deck_material})), join.inputs[0])
    return t.finish(t.out(join))


def areas_group(class_materials, wood_ids, leaves, conifer, trunk):
    """Flat faces stacked by z_order, with low-poly trees scattered over the wood classes"""
    t = Tree("MM Areas", [
        ("Z Step", FLOAT, 0.005, 0.0, 1.0, "Height between z_order steps, in metres per z_order unit"),
        ("Tree Density", FLOAT, 0.012, 0.0, 1.0, "Trees per square metre in woods"),
        ("Tree Scale", FLOAT, 1.0, 0.0, 10.0, "Multiplies the size of every tree"),
        ("Seed", INT, 0, None, None, "Random seed for tree placement"),
    ])
    # Faces with the same z_order can overlap (verges, blocks), stagger them within the step gap
    face = t.out(t.node("GeometryNodeFieldOnDomain", {"Value": t.out(t.node("GeometryNodeInputIndex"))},
                        domain="FACE", data_type="INT"))
    stagger = t.math("MULTIPLY", t.math("FLOORED_MODULO", face, 8.0), 0.5)
    z = t.math("MULTIPLY", t.math("ADD", t.attr("z_order"), stagger), t.arg("Z Step"))
    areas = t.out(t.node("GeometryNodeSetPosition", {"Geometry": t.arg("Geometry"), "Offset": t.vec(z=z)}))
    geo = t.class_materials(areas, class_materials)

    class_id = t.attr("class_id", "INT")
    woods = t.any_of([t.int_eq(class_id, cid) for cid in wood_ids])
    if wood_ids:
        points = t.node("GeometryNodeDistributePointsOnFaces", {
            "Mesh": areas, "Selection": woods, "Density": t.arg("Tree Density"), "Seed": t.arg("Seed")},
            distribute_method="RANDOM")
        trees = t.node("GeometryNodeGeometryToInstance")
        # Multi-input sockets put the newest link first: broadleaf is instance 0, conifer 1
        t.link(_conifer_tree(t, conifer, trunk), trees.inputs[0])
        t.link(_broadleaf_tree(t, leaves, trunk), trees.inputs[0])
        rnd = lambda dtype, lo, hi, seed: t.out(t.node("FunctionNodeRandomValue", {
            "Min": lo, "Max": hi, "Seed": seed}, data_type=dtype))
        rotation = t.out(t.node("FunctionNodeEulerToRotation", {
            "Euler": t.vec(z=rnd("FLOAT", 0.0, 2 * math.pi, 1))}))
        scale = t.math("MULTIPLY", rnd("FLOAT", 0.7, 1.3, 2), t.arg("Tree Scale"))
        # Mostly broadleaf, like the woods on the 2D map
        pick = t.math("GREATER_THAN", rnd("FLOAT", 0.0, 1.0, 3), 0.75)
        instances = t.node("GeometryNodeInstanceOnPoints", {
            "Points": t.out(points, "Points"), "Instance": t.out(trees), "Pick Instance": True,
            "Instance Index": pick, "Rotation": rotation, "Scale": scale})
        join = t.node("GeometryNodeJoinGeometry")
        t.link(geo, join.inputs[0])
        t.link(t.out(instances), join.inputs[0])
        geo = t.out(join)
    return t.finish(geo)


def _transform(t, geo, z=0.0, scale=(1.0, 1.0, 1.0)):
    return t.out(t.node("GeometryNodeTransform", {"Geometry": geo, "Translation": (0.0, 0.0, z), "Scale": scale}))


def _material(t, geo, material):
    return t.out(t.node("GeometryNodeSetMaterial", {"Geometry": geo, "Material": material}))


def _trunk(t, trunk, height):
    geo = t.out(t.node("GeometryNodeMeshCylinder", {"Vertices": 6, "Radius": 0.25, "Depth": height}, fill_type="NGON"), "Mesh")
    return _material(t, _transform(t, geo, z=height / 2), trunk)


def _broadleaf_tree(t, leaves, trunk):
    crown = t.out(t.node("GeometryNodeMeshIcoSphere", {"Radius": 3.2, "Subdivisions": 1}), "Mesh")
    crown = _material(t, _transform(t, crown, z=5.2, scale=(1.0, 1.0, 0.85)), leaves)
    join = t.node("GeometryNodeJoinGeometry")
    t.link(_trunk(t, trunk, 3.0), join.inputs[0])
    t.link(crown, join.inputs[0])
    return t.out(join)


def _conifer_tree(t, conifer, trunk):
    crown = t.out(t.node("GeometryNodeMeshCone", {"Vertices": 7, "Radius Top": 0.0, "Radius Bottom": 2.0, "Depth": 7.0},
                         fill_type="NGON"), "Mesh")
    crown = _material(t, _transform(t, crown, z=5.0), conifer)
    join = t.node("GeometryNodeJoinGeometry")
    t.link(_trunk(t, trunk, 2.0), join.inputs[0])
    t.link(crown, join.inputs[0])
    return t.out(join)
