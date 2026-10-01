# Prompt: Blender Geometry Nodes add-on for map-maker

Copy everything below the line into a new agent session on the `bledderwagen/map-maker` repository.

---

Build a Blender add-on that turns cities exported by map-maker into a 3D scene driven by Geometry Nodes.

**Branch.** The export and these docs are on branch `claude/zen-babbage-bpdlsw` (until it's merged). Check it out, and branch from it for your work.

**Context.** map-maker (this repository, TypeScript, runs in the browser) procedurally generates American-style cities. Download → *Blender* exports the city as a `.geojson` scene file. Read these first:

- `docs/blender-export.md`: the file format. It covers the coordinate system, the layers, every class with its stable `class_id`, and the per-layer attributes (`height`, `eave_height`, `levels`, `roof`, `width`, `lanes`, `bridge`, `level`, `deck_height`, `z_order`, names). It also has a suggested Blender mapping. Treat the format as fixed. If something you need is missing, write it down rather than working around it silently.
- `docs/blender/sample-map.geojson`: a real export (about 6,400 features: houses, apartment complexes, a shopping mall in a big car park, warehouses, a port, freeways with a cloverleaf, a river with bridges, a railway, parks and woods). It's the city shown in `docs/images/osm-style-map.png`, so compare against that image.
- `src/ts/impl/scene_export.ts`: the exporter, in case the doc is unclear.

**What to build.** Put it in a new `blender/` folder:

1. **Importer** (`File → Import → map-maker scene (.geojson)`), standard library only.
   - Read the file and create a `map-maker` collection with one mesh object per layer (`areas`, `roads`, `railways`, `paths`, `waterways`, `buildings`, `points`, `labels`).
   - Polygons become faces, with attributes on the `FACE` domain. Lines become vertex/edge chains, with attributes on the `POINT` domain so they survive *Mesh to Curve*. Points become loose vertices.
   - Store `class_id` and the numeric properties as named attributes.
   - Use the file's `classes` table rather than a hard-coded copy. Unknown classes and properties must not break the import.
   - Add a ground plane over `data_bounds`.
   - Keep string properties (`name`, `ref`) somewhere usable, for example a per-object list indexed by an INT `feature_index` attribute.
   - Import the sample file in a few seconds. Build meshes in bulk with `from_pydata` / `foreach_set`, not one bmesh operation per feature.

2. **Geometry Nodes groups**, applied as modifiers by the importer:
   - **Buildings**: extrude footprints to `eave_height`. Gabled roofs (ridge along the longest side) rise to `height`, flat roofs stay flat, and storage tanks are cylinders. A material or colour by `class_id`.
   - **Roads, railways, paths**: convert to curves and sweep a flat profile scaled by `width`. Raise points with `bridge = 1` to `deck_height`, and blend the deck smoothly back to the ground at the ends of each bridge piece. A material per class (asphalt, motorway, rail ballast, footpath).
   - **Areas**: flat faces stacked by `z_order` (a small z offset per step, or a boolean/priority approach) with a material per class. Water slightly below ground. Scatter tree instances in `wood` areas, using simple low-poly trees generated in the node tree, so no external assets are needed.
   - Expose the useful knobs as modifier inputs: height scale, tree density, road width scale, bridge height.

3. **Packaging**: target Blender 4.2 LTS or newer and package it as a Blender extension (`blender_manifest.toml`), installable as a zip. Add a short `blender/README.md` covering install and use.

**Check your work.**
- If Blender is available (`blender -b`), import the sample headless with a script, render a top-down or oblique preview image, and check it against `docs/images/osm-style-map.png`: coast on the left, the meandering river, bridges, the cloverleaf on the right, the port, the mall at the bottom.
- Commit the preview as `docs/images/blender-preview.png`.
- If Blender isn't available, test the parsing and mesh-building logic with plain Python against the sample file, and say clearly what could not be verified.

Don't change the generator or the export format. If the format needs a change, describe it in your final summary.
