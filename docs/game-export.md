# Game export

Download → **Game** saves `map-game.zip` with two files made from the same export:

* `map.json`: the scene. Every building, road, area and label as a feature with its attributes, the road network for routing, and the map boundary. It's the [Blender scene format](blender-export.md) with a few additions, described below.
* `map.glb`: a binary glTF model of the same scene, ready to load with three.js, Babylon.js or any other glTF loader.

Every mesh vertex in the glTF carries the id of the `map.json` feature it belongs to. A raycast hit therefore leads straight to the building, road or park in the JSON.

A minimal three.js host is in [`examples/webgl/`](../examples/webgl/). It shows the camera, the floating labels, picking and routing. Unzip an export next to its `index.html`, serve the folder (`python3 -m http.server`) and open it.

## Coordinates

* `map.json`: metres, x east, y north, origin at the middle of the generated area. Heights are attributes, never coordinates.
* `map.glb`: metres, x east, y up, z south, the glTF convention. A scene point `(x, y)` at height `h` is glTF `(x, h, -y)`.

The origin is the middle of the area the map was generated in, not of the view when you export. Panning before exporting doesn't move anything.

## Boundary

`map_maker.boundary` is the area the map was generated in: the view when the coastline (the first step of a map) was generated, enlarged by the same 20% the generator uses. Roads, blocks and buildings are generated inside it. Treat it as the edge of the world, for example to clamp the camera.

```jsonc
"boundary": {
    "bounds": [minX, minY, maxX, maxY],      // metres
    "polygon": [[x, y], ...],                // the same rectangle as a closed ring
    "land": [[[x, y], ...], ...]             // the rectangle less the sea, closed rings
}
```

Highways and ramps can run a little past the boundary, where the generator draws them beyond its edge. They end there as dead ends.

## Road network

Road features are the edges of a graph. Each one runs between two nodes, `from_node` and `to_node`. Roads are split wherever they meet, at bridge ends, and where a ramp joins.

```jsonc
"road_network": {
    "nodes": [ { "id": 1, "coordinates": [x, y], "edges": [412, 413, 977] }, ... ]   // edges are feature ids
}
```

Extra properties on road features:

| property | type | meaning |
|---|---|---|
| `from_node`, `to_node` | int | node ids. The line runs from `from_node` to `to_node` |
| `length` | float, m | along the line |
| `grade_separated` | 0/1 | 1 on motorways and ramps |
| `driveway` | 0/1 | 1 on a driveway the exporter added to reach a car park the generator left unconnected |

Rules the network follows:

* Surface roads meet wherever they cross, and where one ends on another (within 4 m of its kerb).
* Motorways and ramps are grade separated. They pass over anything that crosses them and only meet other roads where a ramp ends. A route can never step off a motorway onto a street underneath it.
* Cloverleaf loops are drawn as whole circles touching the carriageways they link. They join each carriageway where they come closest to it.
* Every car park is reachable. One that the generator left without a way in gets a `driveway` to the nearest street.

Roads are two-way, and a motorway is one centreline for both carriageways. For a route, run A* or Dijkstra over the nodes with `length` (or `length / speed` per class) as the cost. `examples/webgl/game.js` has a 40-line version.

## Labels

Label features (`neighbourhood_label`, `park_label`, `mall_label`, `apartments_label`, `river_label`) have a `hover_height` in metres. That's where the map maker's floating labels hover, at real building scale. Multiply it by `pseudo_3d.height_exaggeration` if you draw buildings as tall as the map maker does.

In the glTF, labels are empty nodes under the `labels` node, placed at their hover height. Each is named after its label, with `extras.feature_id`, `extras.class` and `extras.name`.

## Matching the map maker's 3D look

The map maker's pseudo 3D view is a perspective camera looking straight down, with north up. `map_maker.pseudo_3d` records the settings at export:

```jsonc
"pseudo_3d": {
    "height_exaggeration": 2,      // buildings are drawn twice their real height
    "camera_height_m": 2000,       // above the ground, at the zoom of the export (2000 m / zoom)
    "viewport_px": [1400, 900],
    "vertical_fov_deg": 48.46      // 2 * atan(viewport height / 2000 px)
}
```

To get the same lean as the camera moves, use a perspective camera with that vertical field of view. Point it straight down with `up` set to north, `(0, 0, -1)` in glTF axes, and scale the `buildings` node's y by `height_exaggeration`. Buildings stand on y = 0, so scaling makes them taller without lifting them. Any camera height works, and lower is closer.

```js
const camera = new THREE.PerspectiveCamera(header.pseudo_3d.vertical_fov_deg, aspect, 1, 20000);
camera.up.set(0, 0, -1);
camera.position.set(x, height, -y);
camera.lookAt(x, 0, -y);
gltf.scene.getObjectByName('buildings').scale.y = header.pseudo_3d.height_exaggeration;
```

## glTF contents

The scene has one node per layer, each holding one mesh per class:

| node | children |
|---|---|
| `ground` | the land inside the boundary, feature id 0 |
| `areas` | `park`, `sea`, `residential_area`, ... flat, stacked a few millimetres apart by `z_order` |
| `paths`, `roads`, `railways` | flat strips of the feature's `width`, 0.5 m up. Motorways and ramps are 0.8 m up so they cover what they cross |
| `buildings` | `house`, `warehouse`, `mall`, ... footprints extruded to `height`. Pitched roofs are flat, halfway between eaves and ridge |
| `labels` | empty nodes, see above |

Each mesh has `POSITION`, `NORMAL` and `_FEATURE_ID` attributes and a plain material in the colours of the Google style. Each mesh node's `extras` hold its `class` and `class_id`. The scene's `extras` repeat `boundary` and `pseudo_3d`.

Picking in three.js (`GLTFLoader` lower-cases the attribute name):

```js
const hit = raycaster.intersectObject(gltf.scene, true).find(h => h.object.geometry.attributes._feature_id);
const id = hit.object.geometry.attributes._feature_id.getX(hit.face.a);
const feature = features.get(id);   // map.json feature, or id 0 for the ground
```

One mesh per class keeps draw calls low, about 30 for a whole city. To highlight one building, filter its triangles by `_FEATURE_ID`, or look up its footprint in `map.json` and draw an outline.
