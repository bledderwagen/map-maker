# Blender scene export

Download → **Blender** saves the generated city as `map.geojson`. It's written for a Blender
Geometry Nodes importer: each object on the map is one feature with a class and numeric
attributes, so node trees can switch on `class_id` and read `height`, `width`, `bridge` and so on.

A sample export of the map in the README (`docs/images/osm-style-map.png`) is in
[`docs/blender/sample-map.geojson`](blender/sample-map.geojson). Use it to test an importer
without running the generator.

The exporter is `src/ts/impl/scene_export.ts`. Format changes go in both places.

An importer that follows the mapping below is in [`blender/`](../blender/README.md): a Blender 4.2+
extension that builds buildings, roads, bridges, areas and trees with Geometry Nodes.

## File

The file is a GeoJSON `FeatureCollection` with one extra top-level member, `map_maker`.
GeoJSON tools can open it. **Coordinates are local metres, not longitude and latitude.**

```jsonc
{
  "type": "FeatureCollection",
  "map_maker": {
    "format": "map-maker-scene",
    "version": 1,
    "units": "metres",
    "axes": "x east, y north, z up; ground at z = 0",
    "world_unit_m": 2,                   // generator units, for reference only
    "view_bounds": [minX, minY, maxX, maxY],  // what the 2D map showed at export
    "data_bounds": [minX, minY, maxX, maxY],  // everything, reaches past the view
    "boundary": { "bounds": [...], "polygon": [...], "land": [...] },  // the generated area, see docs/game-export.md
    "pseudo_3d": { "height_exaggeration": 2, ... },                     // the 2D map's 3D camera, see docs/game-export.md
    "layers": ["areas", "waterways", "paths", "roads", "railways", "buildings", "points", "labels"],
    "classes": [ { "name": "house", "id": 1, "layer": "buildings", "geometry": "Polygon", "description": "..." }, ... ],
    "feature_count": 7222
  },
  "road_network": { "nodes": [ { "id": 1, "coordinates": [x, y], "edges": [412, 413] }, ... ] },
  "features": [
    {
      "type": "Feature",
      "id": 1,
      "geometry": { "type": "Polygon", "coordinates": [[[x, y], ...]] },
      "properties": { "layer": "buildings", "class": "house", "class_id": 1, "height": 9.8, ... }
    }
  ]
}
```

* Units are metres. x points east, y points north, z points up, and the origin is the middle of the area the map was generated in, so panning before exporting moves nothing. This matches Blender's axes, so importing needs no transform.
* Everything is flat at z = 0. Heights are given as attributes, never as a third coordinate.
* Polygons have one closed exterior ring (the first point is repeated at the end) and no holes. The ring is anticlockwise seen from above, so a face built from it points up (+Z). Drop the repeated last point when building a face.
* Lines are open `LineString`s.
* Points are `Point`s.
* Every feature has `layer`, `class` and `class_id`. The other properties depend on the layer and are listed below.
* Class ids are stable. New classes get new ids, and an id is never reused or renumbered. An importer should still read the `classes` table and not rely on a hard-coded copy.

## Layers and classes

### `buildings` (Polygon): footprints to extrude

| id | class | notes |
|---|---|---|
| 1 | `house` | detached house, 1-2 storeys. In dense neighbourhoods some are taller blocks of up to 14 storeys, with flat roofs |
| 2 | `outbuilding` | garage or shed behind a house |
| 3 | `small_house` | low income house in a fenced yard |
| 4 | `warehouse` | industrial shed |
| 5 | `industrial_office` | small office at the front of an industrial lot |
| 6 | `storage_tank` | round tank, footprint is a 16-sided polygon |
| 7 | `port_shed` | long transit shed on a pier |
| 8 | `container_stack` | stack of shipping containers on the quay |
| 9 | `church` | place of worship, the same building the 2D map marks with a cross |
| 10 | `apartments` | 2-3 storey block, 16 m deep, in a garden apartment complex |
| 11 | `mall` | part of a shopping mall: concourse, anchor department store or food court. The parts touch and together make the mall |
| 12 | `retail` | shop: strip mall unit, big box store, or restaurant on a pad in the car park |

| property | type | meaning |
|---|---|---|
| `height` | float, m | ground to the top of the roof |
| `eave_height` | float, m | ground to the eaves. Equal to `height` for flat roofs |
| `levels` | int | storeys |
| `roof` | string | `gabled`, `flat` or `dome` (tanks) |
| `address` | string | street address, e.g. `273 East 14th Street` |
| `housenumber` | int | the number in the address |
| `street` | string | the street in the address, the `name` of a road feature |
| `svg_id` | string | `building-N`, the building's id in an SVG export of the same map |

Gabled roofs can run along the longest side of the footprint. Most footprints are rectangles or L shapes.

### `roads` (LineString): centrelines to sweep a profile along

| id | class | default `width` (m) | `lanes` |
|---|---|---|---|
| 20 | `motorway` | 36 (both directions) | 8 |
| 21 | `motorway_link` | 10 | 1 |
| 22 | `primary` | 16 | 4 |
| 23 | `secondary` | 13 | 4 |
| 24 | `tertiary` | 11 | 2 |
| 25 | `residential` | 9 | 2 |
| 26 | `service` | 6 | 1 |
| 27 | `parking_aisle` | 6 | 2 |

| property | type | meaning |
|---|---|---|
| `width` | float, m | total width, kerb to kerb |
| `lanes` | int | lanes, both directions together |
| `bridge` | 0/1 | 1 where the road crosses the river or a lake |
| `level` | int | 0 on the ground, 1 on a bridge |
| `deck_height` | float, m | suggested height of the deck above the ground, 0 off bridges |
| `dual_carriageway` | 0/1 | motorways only: two carriageways either side of a median |
| `median_width` | float, m | motorways only |
| `frontage` | 0/1 | frontage road running alongside a motorway |
| `from_node`, `to_node` | int | ends of the road in `road_network`, see [game-export.md](game-export.md) |
| `length` | float, m | along the line |
| `grade_separated` | 0/1 | motorways and ramps, which pass over what they cross |
| `driveway` | 0/1 | a driveway added so a car park joins the streets |
| `name` | string | street name, missing on ramps and service roads |
| `ref` | string | motorway number such as `I 45` |

Roads are split where they meet each other and where a bridge starts or ends, so each road feature is one edge of the road network. The pieces share their end point, so a bridge piece meets the ground pieces either side of it. A bridge piece reaches a few metres onto each bank. That overlap is where a ramp or abutment can go.

Roads cross each other at grade, except that a motorway passes over anything that crosses it.
`parking_aisle` lines run across car parks and may be closed loops (first point equals last), such as the ring road round a mall.

### `railways` (LineString)

| id | class | properties |
|---|---|---|
| 30 | `rail` | `width` 4, `gauge` 1.435, `tracks` 1, plus `bridge`, `level` and `deck_height` as for roads |

### `paths` (LineString)

| id | class | properties |
|---|---|---|
| 40 | `footway` | `width` 2.5. Footpaths in parks and along the riverbanks |

### `waterways` (LineString)

| id | class | properties |
|---|---|---|
| 45 | `river_centreline` | `name`. The middle of the river channel, for flow direction or a name label. The water itself is the `river` area |

### `areas` (Polygon): flat surfaces, stacked by `z_order`

Areas overlap. Draw or stack them in increasing `z_order`, with the higher one on top, the way the 2D map paints them. For example, the river runs on top of the floodplain, which sits on top of the land. Land not covered by any area is plain ground; the 2D map shows it in the residential colour.

| id | class | `z_order` | notes |
|---|---|---|---|
| 50 | `residential_area` | 10 | a housing block, bounded by street centrelines |
| 51 | `low_income_area` | 10 | block of small houses |
| 68 | `apartment_area` | 10 | block taken by a garden apartment complex |
| 53 | `highway_verge` | 15 | strips along motorways and interchange areas, no buildings |
| 52 | `industrial_area` | 20 | industrial block |
| 65 | `retail_area` | 20 | shopping mall or strip mall superblock |
| 66 | `parking_lot` | 25 | car park surface. The mall's covers its whole site under the buildings; apartment car parks sit between rows of blocks |
| 54 | `floodplain` | 30 | riverside park between the bank roads |
| 55 | `park` | 35 | `name` when the park has one |
| 56 | `pitch` | 40 | football pitch, about 104 x 68 m |
| 57 | `wood` | 45 | trees, scatter tree instances inside |
| 58 | `sea` | 50 | `name` (bay or lake) |
| 59 | `port_quay` | 55 | quays and piers built out over the sea, solid ground |
| 60 | `port_water` | 60 | slips between piers, water cut back into the quay |
| 61 | `beach` | 65 | sand |
| 62 | `river` | 70 | `name`. The river channel |
| 63 | `lake` | 75 | oxbow lake or park pond |
| 67 | `swimming_pool` | 77 | pool in an apartment courtyard |
| 64 | `sand_bar` | 80 | sand on the inside of river bends |

Blocks are bounded by street centrelines, so they run under half of each road. Sweep the roads on top of them.

### `points` (Point)

| id | class | notes |
|---|---|---|
| 80 | `place_of_worship` | centre of a `church` building |
| 81 | `parking` | car park in an industrial block |

### `labels` (Point)

| id | class | properties |
|---|---|---|
| 90 | `neighbourhood_label` | `name` |
| 91 | `park_label` | `name`, at the middle of its park |
| 92 | `mall_label` | `name`, at the middle of the mall |
| 93 | `apartments_label` | `name` of an apartment complex |
| 94 | `river_label` | `name`, halfway along the river on the map |

Labels also have `hover_height` (m), where the 2D map's floating labels hover, at real building scale.

Street, river and sea names are properties of their features.

## Suggested Blender mapping

These are suggestions for an importer:

* **One mesh object per layer**, named after the layer (`buildings`, `roads`, ...), in a `map-maker` collection. Or one object per class, if that suits the node trees better.
* **Polygons** become faces. Store attributes on the `FACE` domain:
  * `class_id` (INT), `z_order` (INT)
  * `height`, `eave_height` (FLOAT) and `levels` (INT) for buildings
  * a `roof` INT: 0 for flat, 1 for gabled, 2 for dome
* **Lines** become chains of vertices and edges. Store `class_id`, `width`, `lanes`, `bridge`, `level` and `deck_height` on the `POINT` domain, because Geometry Nodes' *Mesh to Curve* keeps point attributes. Then use *Curve to Mesh* with a profile scaled by `width`, and raise vertices by `deck_height`.
* **Points** become loose vertices with `class_id`.
* **Strings** (`name`, `ref`) can't be mesh attributes. Keep them as custom properties on the object, as a list indexed by an INT `feature_index` attribute, or make text objects from the `labels` layer.
* A ground plane covering `data_bounds` at z = 0 gives the land under everything.

Reading the file in Blender needs only the standard library:

```python
import json, bpy

data = json.load(open(path))
classes = {c["name"]: c for c in data["map_maker"]["classes"]}
for f in data["features"]:
    props, geom = f["properties"], f["geometry"]
    if geom["type"] == "Polygon":
        ring = geom["coordinates"][0][:-1]   # drop the repeated closing point
        ...                                  # add a face, set FACE attributes from props
```
