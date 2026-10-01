/* eslint-disable @typescript-eslint/camelcase */  // Keys follow the scene file and glTF, which use snake_case and camelCase
import * as THREE from 'three';

/**
 * Builds a binary glTF (.glb) scene from an exported map scene (see scene_export.ts), for loading
 * straight into a WebGL game.
 *
 * glTF axes: x east, y up, z south, in metres, so the scene's (x, y) becomes (x, -z).
 * One mesh per class (houses, residential roads, parks ...), each vertex tagged with the id of
 * the scene feature it belongs to in a _FEATURE_ID attribute, so a raycast hit leads back to the
 * building or road edge in the JSON. Labels are empty nodes at their hover height.
 * The format is described in docs/game-export.md, keep the two in step
 */

type Vec3 = [number, number, number];

interface MeshBuilder {
    positions: number[];
    normals: number[];
    featureIds: number[];
    indices: number[];
}

/**
 * Surface colours, roughly the Google style the 2D map draws
 */
const COLOURS: {[cls: string]: string} = {
    ground: '#ececec',
    residential_area: '#ececec', low_income_area: '#ebe7e2', apartment_area: '#ececec', industrial_area: '#e6e3ec',
    retail_area: '#efe9ee', highway_verge: '#e3eadf', parking_lot: '#dcdcdc', floodplain: '#c6e8c6', park: '#c6e8c6',
    pitch: '#aedcae', wood: '#a8d5a2', sea: '#a6d5f9', port_quay: '#e0e0e0', port_water: '#a6d5f9', beach: '#f2e6c4',
    river: '#a6d5f9', lake: '#a6d5f9', swimming_pool: '#8fd3f0', sand_bar: '#f2e6c4',
    motorway: '#ffe58a', motorway_link: '#fff2af', primary: '#fff2af', secondary: '#ffffff', tertiary: '#ffffff',
    residential: '#ffffff', service: '#f7f7f7', parking_aisle: '#f4f4f4', rail: '#9a9a9a', footway: '#f6efe3',
    house: '#f2f2f2', outbuilding: '#e8e8e8', small_house: '#efece8', warehouse: '#e4e1ea', industrial_office: '#ebe8f0',
    storage_tank: '#dcdcdc', port_shed: '#e2e2e2', container_stack: '#c9b8a8', church: '#efe6dc', apartments: '#f0eeea',
    mall: '#f0e6ef', retail: '#f0e6ef',
};

// Small lifts keep flat surfaces from flickering through each other: areas by z_order, then roads
const AREA_LIFT = 0.005;
const ROAD_LIFT = 0.5;
const GRADE_SEPARATED_LIFT = 0.8;
const ROAD_ORDER: {[cls: string]: number} = {
    footway: 0, parking_aisle: 1, service: 2, residential: 3, tertiary: 4, secondary: 5, primary: 6, rail: 7,
};

export default class GltfExport {
    private meshes = new Map<string, MeshBuilder>();

    private constructor(private scene: any) {}

    /**
     * @param scene as returned by SceneExport.build
     */
    static build(scene: any): ArrayBuffer {
        return new GltfExport(scene).run();
    }

    private mesh(name: string): MeshBuilder {
        if (!this.meshes.has(name)) this.meshes.set(name, {positions: [], normals: [], featureIds: [], indices: []});
        return this.meshes.get(name);
    }

    /**
     * Scene metres (x east, y north) at height h to glTF
     */
    private static toGltf(p: number[], h: number): Vec3 {
        return [p[0], h, -p[1]];
    }

    /**
     * Adds a flat shaded triangle, turned so it faces the way `facing` points
     */
    private static triangle(m: MeshBuilder, a: Vec3, b: Vec3, c: Vec3, facing: Vec3, id: number): void {
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const len = Math.hypot(n[0], n[1], n[2]);
        if (len < 1e-9) return;
        if (n[0] * facing[0] + n[1] * facing[1] + n[2] * facing[2] < 0) {
            [b, c] = [c, b];
            n[0] = -n[0];
            n[1] = -n[1];
            n[2] = -n[2];
        }
        const base = m.positions.length / 3;
        for (const p of [a, b, c]) {
            m.positions.push(p[0], p[1], p[2]);
            m.normals.push(n[0] / len, n[1] / len, n[2] / len);
            m.featureIds.push(id);
        }
        m.indices.push(base, base + 1, base + 2);
    }

    /**
     * Flat polygon facing up, ring in scene metres without the repeated closing point
     */
    private static flat(m: MeshBuilder, ring: number[][], h: number, id: number): void {
        if (ring.length < 3) return;
        const contour = ring.map(p => new THREE.Vector2(p[0], p[1]));
        let tris: number[][];
        try {
            tris = THREE.ShapeUtils.triangulateShape(contour, []);
        } catch (e) {
            return;
        }
        for (const t of tris) {
            GltfExport.triangle(m, GltfExport.toGltf(ring[t[0]], h), GltfExport.toGltf(ring[t[1]], h),
                GltfExport.toGltf(ring[t[2]], h), [0, 1, 0], id);
        }
    }

    private static openRing(polygon: number[][][]): number[][] {
        const ring = polygon[0].slice();
        const first = ring[0];
        const last = ring[ring.length - 1];
        if (ring.length > 1 && first[0] === last[0] && first[1] === last[1]) ring.pop();
        return ring;
    }

    /**
     * Footprint extruded to a height: walls facing out, flat roof
     */
    private static prism(m: MeshBuilder, ring: number[][], height: number, id: number): void {
        for (let i = 0; i < ring.length; i++) {
            const a = ring[i];
            const b = ring[(i + 1) % ring.length];
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            // The ring is anticlockwise seen from above, so outside is on the right
            const out: Vec3 = [dy, 0, dx];
            const a0 = GltfExport.toGltf(a, 0);
            const b0 = GltfExport.toGltf(b, 0);
            const a1 = GltfExport.toGltf(a, height);
            const b1 = GltfExport.toGltf(b, height);
            GltfExport.triangle(m, a0, b0, b1, out, id);
            GltfExport.triangle(m, a0, b1, a1, out, id);
        }
        GltfExport.flat(m, ring, height, id);
    }

    /**
     * Flat strip of a width along a line, mitred at the bends
     */
    private static ribbon(m: MeshBuilder, line: number[][], width: number, h: number, id: number): void {
        if (line.length < 2) return;
        const half = width / 2;
        const dirs: number[][] = [];
        for (let i = 0; i < line.length - 1; i++) {
            const dx = line[i + 1][0] - line[i][0];
            const dy = line[i + 1][1] - line[i][1];
            const len = Math.hypot(dx, dy) || 1;
            dirs.push([dx / len, dy / len]);
        }
        const left: number[][] = [];
        const right: number[][] = [];
        for (let i = 0; i < line.length; i++) {
            const d0 = dirs[Math.max(0, i - 1)];
            const d1 = dirs[Math.min(dirs.length - 1, i)];
            let nx = -(d0[1] + d1[1]);
            let ny = d0[0] + d1[0];
            let len = Math.hypot(nx, ny);
            if (len < 1e-6) {
                nx = -d1[1];
                ny = d1[0];
                len = 1;
            }
            nx /= len;
            ny /= len;
            // Longer offsets at bends keep the strip its full width, within reason
            const cos = nx * -d1[1] + ny * d1[0];
            const miter = Math.min(3, 1 / Math.max(0.2, cos));
            left.push([line[i][0] + nx * half * miter, line[i][1] + ny * half * miter]);
            right.push([line[i][0] - nx * half * miter, line[i][1] - ny * half * miter]);
        }
        for (let i = 0; i < line.length - 1; i++) {
            const l0 = GltfExport.toGltf(left[i], h);
            const l1 = GltfExport.toGltf(left[i + 1], h);
            const r0 = GltfExport.toGltf(right[i], h);
            const r1 = GltfExport.toGltf(right[i + 1], h);
            GltfExport.triangle(m, l0, r0, r1, [0, 1, 0], id);
            GltfExport.triangle(m, l0, r1, l1, [0, 1, 0], id);
        }
    }

    private run(): ArrayBuffer {
        const header = this.scene.map_maker;
        const labels: any[] = [];

        // Ground: the land everything was generated on, which reaches a little past the boundary, feature id 0
        for (const ring of (header.generated_area || header.boundary).land) {
            GltfExport.flat(this.mesh('ground'), GltfExport.openRing([ring]), 0, 0);
        }

        for (const f of this.scene.features) {
            const p = f.properties;
            const geometry = f.geometry;
            if (p.layer === 'areas' && geometry.type === 'Polygon') {
                GltfExport.flat(this.mesh(p.class), GltfExport.openRing(geometry.coordinates), (p.z_order || 0) * AREA_LIFT, f.id);
            } else if (p.layer === 'buildings' && geometry.type === 'Polygon') {
                // Pitched roofs are left flat, halfway between the eaves and the ridge
                const h = p.roof === 'gabled' ? (p.eave_height + p.height) / 2 : p.height;
                GltfExport.prism(this.mesh(p.class), GltfExport.openRing(geometry.coordinates), h, f.id);
            } else if ((p.layer === 'roads' || p.layer === 'railways' || p.layer === 'paths') && geometry.type === 'LineString') {
                const lift = p.grade_separated ? GRADE_SEPARATED_LIFT : ROAD_LIFT + 0.01 * (ROAD_ORDER[p.class] || 0);
                GltfExport.ribbon(this.mesh(p.class), geometry.coordinates, p.width || 2, lift, f.id);
            } else if (p.layer === 'labels' && geometry.type === 'Point') {
                labels.push(f);
            }
        }

        return this.writeGlb(labels);
    }

    private writeGlb(labels: any[]): ArrayBuffer {
        const header = this.scene.map_maker;
        const chunks: ArrayBuffer[] = [];
        let byteLength = 0;
        const bufferViews: any[] = [];
        const accessors: any[] = [];

        const addView = (data: Float32Array | Uint32Array, target: number): number => {
            const padded = Math.ceil(data.byteLength / 4) * 4;
            const copy = new Uint8Array(padded);
            copy.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            chunks.push(copy.buffer);
            bufferViews.push({buffer: 0, byteOffset: byteLength, byteLength: data.byteLength, target});
            byteLength += padded;
            return bufferViews.length - 1;
        };
        const addAccessor = (data: Float32Array | Uint32Array, type: string, componentType: number, target: number,
                             bounds = false): number => {
            const size = type === 'VEC3' ? 3 : 1;
            const accessor: any = {bufferView: addView(data, target), componentType, count: data.length / size, type};
            if (bounds) {
                const min = [Infinity, Infinity, Infinity].slice(0, size);
                const max = [-Infinity, -Infinity, -Infinity].slice(0, size);
                for (let i = 0; i < data.length; i++) {
                    min[i % size] = Math.min(min[i % size], data[i]);
                    max[i % size] = Math.max(max[i % size], data[i]);
                }
                accessor.min = min;
                accessor.max = max;
            }
            accessors.push(accessor);
            return accessors.length - 1;
        };

        const ARRAY_BUFFER = 34962;
        const ELEMENT_ARRAY_BUFFER = 34963;
        const FLOAT = 5126;
        const UNSIGNED_INT = 5125;

        const materials: any[] = [];
        const meshes: any[] = [];
        const nodes: any[] = [];
        const groups: {[layer: string]: number[]} = {};
        const layerOf = (name: string): string => {
            if (name === 'ground') return 'ground';
            const cls = header.classes.find((c: any) => c.name === name);
            return cls ? cls.layer : 'other';
        };

        this.meshes.forEach((m, name) => {
            if (m.indices.length === 0) return;
            // glTF colour factors are linear
            const colour = new THREE.Color(COLOURS[name] || '#dddddd').convertSRGBToLinear();
            materials.push({
                name,
                pbrMetallicRoughness: {baseColorFactor: [colour.r, colour.g, colour.b, 1], metallicFactor: 0, roughnessFactor: 1},
            });
            const cls = header.classes.find((c: any) => c.name === name);
            meshes.push({
                name,
                primitives: [{
                    attributes: {
                        POSITION: addAccessor(new Float32Array(m.positions), 'VEC3', FLOAT, ARRAY_BUFFER, true),
                        NORMAL: addAccessor(new Float32Array(m.normals), 'VEC3', FLOAT, ARRAY_BUFFER),
                        _FEATURE_ID: addAccessor(new Float32Array(m.featureIds), 'SCALAR', FLOAT, ARRAY_BUFFER),
                    },
                    indices: addAccessor(new Uint32Array(m.indices), 'SCALAR', UNSIGNED_INT, ELEMENT_ARRAY_BUFFER),
                    material: materials.length - 1,
                }],
            });
            nodes.push({name, mesh: meshes.length - 1, extras: {class: name, class_id: cls ? cls.id : 0}});
            const layer = layerOf(name);
            if (!groups[layer]) groups[layer] = [];
            groups[layer].push(nodes.length - 1);
        });

        // Labels: empty nodes to hang text on, at their hover height
        groups.labels = groups.labels || [];
        for (const f of labels) {
            const p = f.properties;
            nodes.push({
                name: p.name,
                translation: GltfExport.toGltf(f.geometry.coordinates, p.hover_height || 0),
                extras: {feature_id: f.id, class: p.class, name: p.name, hover_height: p.hover_height},
            });
            groups.labels.push(nodes.length - 1);
        }

        // One parent node per layer, in drawing order
        const order = ['ground', 'areas', 'paths', 'roads', 'railways', 'buildings', 'labels', 'other'];
        const roots: number[] = [];
        for (const layer of order) {
            if (!groups[layer] || groups[layer].length === 0) continue;
            nodes.push({name: layer, children: groups[layer]});
            roots.push(nodes.length - 1);
        }

        const json = {
            asset: {version: '2.0', generator: 'map-maker'},
            scene: 0,
            scenes: [{
                name: 'map',
                nodes: roots,
                extras: {
                    format: 'map-maker-gltf',
                    axes: 'x east, y up, z south; metres; scene file (x, y) is glTF (x, -z)',
                    boundary: header.boundary,
                    generated_area: header.generated_area,
                    pseudo_3d: header.pseudo_3d,
                },
            }],
            nodes,
            meshes,
            materials,
            accessors,
            bufferViews,
            buffers: [{byteLength}],
        };

        // GLB: 12 byte header, JSON chunk padded with spaces, BIN chunk padded with zeros
        const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
        const jsonPadded = Math.ceil(jsonBytes.length / 4) * 4;
        const total = 12 + 8 + jsonPadded + 8 + byteLength;
        const out = new ArrayBuffer(total);
        const view = new DataView(out);
        const bytes = new Uint8Array(out);
        view.setUint32(0, 0x46546C67, true);  // glTF
        view.setUint32(4, 2, true);
        view.setUint32(8, total, true);
        view.setUint32(12, jsonPadded, true);
        view.setUint32(16, 0x4E4F534A, true);  // JSON
        bytes.set(jsonBytes, 20);
        for (let i = 20 + jsonBytes.length; i < 20 + jsonPadded; i++) bytes[i] = 0x20;
        let offset = 20 + jsonPadded;
        view.setUint32(offset, byteLength, true);
        view.setUint32(offset + 4, 0x004E4942, true);  // BIN
        offset += 8;
        for (const c of chunks) {
            bytes.set(new Uint8Array(c), offset);
            offset += c.byteLength;
        }
        return out;
    }
}
