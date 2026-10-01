"""Material colours by class name. Classes not listed here fall back to a colour for their layer,
so new classes in the file still get a material"""

# sRGB hex, roughness
CLASS_COLOURS = {
    # Buildings, walls
    "house": ("#d9cfc1", 0.8),
    "outbuilding": ("#b8ad9f", 0.8),
    "small_house": ("#d4c3a8", 0.8),
    "warehouse": ("#b7bcc2", 0.6),
    "industrial_office": ("#cbc3b6", 0.7),
    "storage_tank": ("#e4e6e8", 0.35),
    "port_shed": ("#a6b2bd", 0.6),
    "container_stack": ("#b0533c", 0.6),
    "church": ("#ece6d6", 0.8),

    # Roads
    "motorway": ("#8f8d89", 0.85),       # concrete
    "motorway_link": ("#8f8d89", 0.85),
    "primary": ("#4b4b4e", 0.9),          # asphalt
    "secondary": ("#505053", 0.9),
    "tertiary": ("#555558", 0.9),
    "residential": ("#59595c", 0.9),
    "service": ("#626264", 0.9),
    "rail": ("#6d6155", 1.0),             # ballast
    "footway": ("#c4a57e", 1.0),          # gravel path
    "river_centreline": ("#5a97b8", 0.2),

    # Areas
    "residential_area": ("#b8bea0", 1.0),  # lawns and yards
    "low_income_area": ("#bcb99c", 1.0),
    "industrial_area": ("#aba3a9", 0.9),
    "highway_verge": ("#a5b585", 1.0),
    "floodplain": ("#a9cf8b", 1.0),
    "park": ("#9fcc82", 1.0),
    "pitch": ("#74b55f", 1.0),
    "wood": ("#6f9a5a", 1.0),
    "sea": ("#5e9cbf", 0.08),
    "port_quay": ("#aea8a2", 0.9),
    "port_water": ("#5e9cbf", 0.08),
    "beach": ("#e8d6a0", 1.0),
    "river": ("#68a5c6", 0.08),
    "lake": ("#68a5c6", 0.08),
    "sand_bar": ("#dfcf9c", 1.0),
}

LAYER_COLOURS = {
    "buildings": ("#d0c8bc", 0.8),
    "roads": ("#555558", 0.9),
    "railways": ("#6d6155", 1.0),
    "paths": ("#c4a57e", 1.0),
    "waterways": ("#5a97b8", 0.2),
    "areas": ("#b8bea0", 1.0),
}

OTHER_COLOURS = {
    "roof_gabled": ("#8c4f3e", 0.75),
    "roof_flat": ("#8d8f8f", 0.85),
    "bridge_deck": ("#b4b0a8", 0.8),
    "tree_leaves": ("#4c7a37", 1.0),
    "tree_conifer": ("#355a32", 1.0),
    "tree_trunk": ("#5a4330", 1.0),
    "ground": ("#b8bea0", 1.0),
    "label": ("#2b2b2b", 1.0),
}

DEFAULT_COLOUR = ("#a0a0a0", 0.8)

WATER = {"sea", "port_water", "river", "lake", "river_centreline"}


def colour(class_name, layer=None):
    if class_name in CLASS_COLOURS:
        return CLASS_COLOURS[class_name]
    if class_name in OTHER_COLOURS:
        return OTHER_COLOURS[class_name]
    return LAYER_COLOURS.get(layer, DEFAULT_COLOUR)


def srgb_to_linear(hex_colour):
    h = hex_colour.lstrip("#")
    out = []
    for i in (0, 2, 4):
        c = int(h[i:i + 2], 16) / 255.0
        out.append(c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4)
    return out
