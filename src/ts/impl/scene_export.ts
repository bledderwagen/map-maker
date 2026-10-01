/* eslint-disable @typescript-eslint/camelcase */  // Keys are the file format, which uses snake_case
import Vector from '../vector';
import PolygonUtil from './polygon_util';
import RoadNetwork from './road_network';

/**
 * Exports a generated city as a scene for 3D tools such as Blender Geometry Nodes.
 * The file is GeoJSON shaped (a FeatureCollection) but in local metres, not longitude and latitude.
 * Every map object is one feature with a layer, a class name, an integer class_id and numeric
 * attributes, so an importer can turn each layer into one mesh with named attributes.
 * The format is described in docs/blender-export.md, keep the two in step
 */

export const SCENE_FORMAT = 'map-maker-scene';
export const SCENE_VERSION = 1;

export type Layer = 'buildings' | 'roads' | 'railways' | 'paths' | 'waterways' | 'areas' | 'points' | 'labels';

interface ClassInfo {
    id: number;
    layer: Layer;
    geometry: 'Polygon' | 'LineString' | 'Point';
    description: string;
}

/**
 * Stable ids, never renumber, only add
 */
export const CLASSES: {[name: string]: ClassInfo} = {
    // Buildings, footprints to extrude by height
    house: {id: 1, layer: 'buildings', geometry: 'Polygon', description: 'Detached house'},
    outbuilding: {id: 2, layer: 'buildings', geometry: 'Polygon', description: 'Garage or shed behind a house'},
    small_house: {id: 3, layer: 'buildings', geometry: 'Polygon', description: 'Small house in a low income neighbourhood'},
    warehouse: {id: 4, layer: 'buildings', geometry: 'Polygon', description: 'Industrial shed or warehouse'},
    industrial_office: {id: 5, layer: 'buildings', geometry: 'Polygon', description: 'Office at the front of an industrial lot'},
    storage_tank: {id: 6, layer: 'buildings', geometry: 'Polygon', description: 'Round storage tank, footprint is a 16 sided polygon'},
    port_shed: {id: 7, layer: 'buildings', geometry: 'Polygon', description: 'Transit shed on a pier'},
    container_stack: {id: 8, layer: 'buildings', geometry: 'Polygon', description: 'Stack of shipping containers'},
    church: {id: 9, layer: 'buildings', geometry: 'Polygon', description: 'Place of worship'},
    apartments: {id: 10, layer: 'buildings', geometry: 'Polygon', description: 'Three storey block in a garden apartment complex'},
    mall: {id: 11, layer: 'buildings', geometry: 'Polygon', description: 'Part of a shopping mall: concourse, anchor store or food court'},
    retail: {id: 12, layer: 'buildings', geometry: 'Polygon', description: 'Shop: strip mall unit, big box store or restaurant on a pad'},

    // Roads, centrelines to sweep a profile along
    motorway: {id: 20, layer: 'roads', geometry: 'LineString', description: 'Freeway, both carriageways on one centreline'},
    motorway_link: {id: 21, layer: 'roads', geometry: 'LineString', description: 'Freeway ramp'},
    primary: {id: 22, layer: 'roads', geometry: 'LineString', description: 'Main road'},
    secondary: {id: 23, layer: 'roads', geometry: 'LineString', description: 'Major road, frontage road or waterfront road'},
    tertiary: {id: 24, layer: 'roads', geometry: 'LineString', description: 'Minor through road'},
    residential: {id: 25, layer: 'roads', geometry: 'LineString', description: 'Side street'},
    service: {id: 26, layer: 'roads', geometry: 'LineString', description: 'Service road in industry or the port'},
    parking_aisle: {id: 27, layer: 'roads', geometry: 'LineString', description: 'Aisle or drive in a car park, may be a closed loop'},

    rail: {id: 30, layer: 'railways', geometry: 'LineString', description: 'Railway track'},

    footway: {id: 40, layer: 'paths', geometry: 'LineString', description: 'Footpath in a park or along the river'},

    river_centreline: {id: 45, layer: 'waterways', geometry: 'LineString', description: 'Centreline of the river channel'},

    // Areas, flat polygons drawn in z_order, higher on top
    residential_area: {id: 50, layer: 'areas', geometry: 'Polygon', description: 'Housing block'},
    low_income_area: {id: 51, layer: 'areas', geometry: 'Polygon', description: 'Block of small houses in fenced yards'},
    industrial_area: {id: 52, layer: 'areas', geometry: 'Polygon', description: 'Industrial block'},
    highway_verge: {id: 53, layer: 'areas', geometry: 'Polygon', description: 'Land along freeways and inside interchanges, no buildings'},
    floodplain: {id: 54, layer: 'areas', geometry: 'Polygon', description: 'Riverside park between the bank roads'},
    park: {id: 55, layer: 'areas', geometry: 'Polygon', description: 'Park'},
    pitch: {id: 56, layer: 'areas', geometry: 'Polygon', description: 'Football pitch'},
    wood: {id: 57, layer: 'areas', geometry: 'Polygon', description: 'Trees, scatter instances inside'},
    sea: {id: 58, layer: 'areas', geometry: 'Polygon', description: 'Sea or lake beyond the coast'},
    port_quay: {id: 59, layer: 'areas', geometry: 'Polygon', description: 'Quays and piers built out over the sea'},
    port_water: {id: 60, layer: 'areas', geometry: 'Polygon', description: 'Water in the slips between piers, cut out of port_quay'},
    beach: {id: 61, layer: 'areas', geometry: 'Polygon', description: 'Sand beach along the coast'},
    river: {id: 62, layer: 'areas', geometry: 'Polygon', description: 'River channel'},
    lake: {id: 63, layer: 'areas', geometry: 'Polygon', description: 'Oxbow lake or park pond'},
    sand_bar: {id: 64, layer: 'areas', geometry: 'Polygon', description: 'Sand bar on the inside of a river bend'},
    retail_area: {id: 65, layer: 'areas', geometry: 'Polygon', description: 'Shopping mall or strip mall site'},
    parking_lot: {id: 66, layer: 'areas', geometry: 'Polygon', description: 'Car park surface'},
    swimming_pool: {id: 67, layer: 'areas', geometry: 'Polygon', description: 'Pool in an apartment courtyard'},
    apartment_area: {id: 68, layer: 'areas', geometry: 'Polygon', description: 'Garden apartment complex'},

    // Points
    place_of_worship: {id: 80, layer: 'points', geometry: 'Point', description: 'Church, also exported as a church building'},
    parking: {id: 81, layer: 'points', geometry: 'Point', description: 'Car park'},

    neighbourhood_label: {id: 90, layer: 'labels', geometry: 'Point', description: 'Neighbourhood name'},
    park_label: {id: 91, layer: 'labels', geometry: 'Point', description: 'Park name'},
    mall_label: {id: 92, layer: 'labels', geometry: 'Point', description: 'Shopping mall name'},
    apartments_label: {id: 93, layer: 'labels', geometry: 'Point', description: 'Apartment complex name'},
    river_label: {id: 94, layer: 'labels', geometry: 'Point', description: 'River name, halfway along the river on the map'},
};

/**
 * Drawing order of areas, as the OpenStreetMap style draws them
 */
const Z_ORDER: {[name: string]: number} = {
    residential_area: 10, low_income_area: 10, apartment_area: 10, highway_verge: 15, industrial_area: 20,
    retail_area: 20, parking_lot: 25, floodplain: 30, park: 35, swimming_pool: 77,
    pitch: 40, wood: 45, sea: 50, port_quay: 55, port_water: 60, beach: 65, river: 70, lake: 75, sand_bar: 80,
};

/**
 * Real widths in metres. Roads match the clearance buildings keep from them
 */
const ROAD_WIDTH: {[name: string]: number} = {
    motorway: 36, motorway_link: 10, primary: 16, secondary: 13, tertiary: 11, residential: 9, service: 6,
    parking_aisle: 6, rail: 4, footway: 2.5,
};
const ROAD_LANES: {[name: string]: number} = {
    motorway: 8, motorway_link: 1, primary: 4, secondary: 4, tertiary: 2, residential: 2, service: 1,
    parking_aisle: 2,
};

export interface SceneRoad {
    line: Vector[];
    cls: string;
    name?: string;
    ref?: string;
    frontage?: boolean;
}

/**
 * Everything in world space (1 unit = 2 m, y down)
 */
export interface SceneInput {
    // Street addresses by world space footprint, with each building's id in an exported SVG
    addresses: Map<Vector[], {id: string; address: string; number: number; street: string}>;
    streets: {name: string; kind: string; crossStreets: string[]}[];
    viewOrigin: Vector;
    viewSize: Vector;
    mapOrigin: Vector;  // The view the map was generated for, its boundary. Fully built up to its edges
    mapSize: Vector;
    mapLand: Vector[][];  // The boundary less the sea
    generationOrigin: Vector;  // Where the map was generated, the boundary enlarged a little. Its middle is the origin of the scene
    generationSize: Vector;
    land: Vector[][];  // The generation area less the sea
    camera: {heightExaggeration: number; cameraHeight: number; screenSize: Vector};  // The pseudo 3D view
    houses: Vector[][];
    lowIncomeHouses: Vector[][];
    industrialBuildings: Vector[][];
    portBuildings: Set<Vector[]>;
    churches: Vector[][];
    siteBuildings: {polygon: Vector[]; kind: 'mall' | 'retail' | 'apartments'}[];
    heights: Map<Vector[], number>;
    roads: SceneRoad[];
    railways: Vector[][];
    paths: Vector[][];
    riverCentreline: Vector[];
    riverName: string;
    areas: {polygon: Vector[]; cls: string; name?: string}[];
    bridgeWater: Vector[][];  // Polygons that roads and railways cross on bridges
    parking: Vector[];
    labels: {at: Vector; cls: string; name: string; hoverHeight: number}[];  // Hover height in metres
}

const WORLD_UNIT_M = 2;
const BRIDGE_DECK_M = 6;  // Suggested height of a bridge deck above the ground

export default class SceneExport {
    private features: any[] = [];
    private nextId = 1;
    private centre: Vector;
    private min = new Vector(Infinity, Infinity);
    private max = new Vector(-Infinity, -Infinity);

    private constructor(private input: SceneInput) {
        // The middle of the generated area, so the scene doesn't move if the view is panned before exporting
        this.centre = input.generationOrigin.clone().add(input.generationSize.clone().divideScalar(2));
    }

    static build(input: SceneInput): any {
        return new SceneExport(input).run();
    }

    /**
     * World units to metres: x east, y north, origin at the middle of the view
     */
    private toMetres(v: Vector): number[] {
        const x = Math.round((v.x - this.centre.x) * WORLD_UNIT_M * 100) / 100;
        const y = Math.round(-(v.y - this.centre.y) * WORLD_UNIT_M * 100) / 100;
        this.min.x = Math.min(this.min.x, x);
        this.min.y = Math.min(this.min.y, y);
        this.max.x = Math.max(this.max.x, x);
        this.max.y = Math.max(this.max.y, y);
        return [x, y];
    }

    /**
     * Closed ring, anticlockwise seen from above so faces point up
     */
    private ring(polygon: Vector[]): number[][] {
        const pts = polygon.map(v => this.toMetres(v));
        while (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
        let area = 0;
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i];
            const b = pts[(i + 1) % pts.length];
            area += a[0] * b[1] - b[0] * a[1];
        }
        if (area < 0) pts.reverse();
        pts.push(pts[0].slice());
        return pts;
    }

    private add(cls: string, geometry: any, properties: {[k: string]: any}): void {
        const info = CLASSES[cls];
        this.features.push({
            type: 'Feature',
            id: this.nextId++,
            geometry,
            properties: Object.assign({layer: info.layer, class: cls, class_id: info.id}, properties),
        });
    }

    private addPolygon(cls: string, polygon: Vector[], properties: {[k: string]: any}): void {
        if (!polygon || polygon.length < 3) return;
        const ring = this.ring(polygon);
        if (ring.length < 4) return;
        this.add(cls, {type: 'Polygon', coordinates: [ring]}, properties);
    }

    /**
     * @param dropTiny leave out lines shorter than a centimetre. Network edges are always kept, so every node's edges exist
     * @return feature id, or null if nothing was added
     */
    private addLine(cls: string, line: Vector[], properties: {[k: string]: any}, dropTiny = true): number {
        if (!line || line.length < 2) return null;
        let coords = line.map(v => this.toMetres(v))
            .filter((c, i, all) => i === 0 || c[0] !== all[i - 1][0] || c[1] !== all[i - 1][1]);
        if (coords.length < 2) {
            if (dropTiny) return null;
            coords = [coords[0], coords[0].slice()];
        }
        this.add(cls, {type: 'LineString', coordinates: coords}, properties);
        return this.nextId - 1;
    }

    private addPoint(cls: string, at: Vector, properties: {[k: string]: any}): void {
        this.add(cls, {type: 'Point', coordinates: this.toMetres(at)}, properties);
    }

    private static areaM2(polygon: Vector[]): number {
        return PolygonUtil.calcPolygonArea(polygon) * WORLD_UNIT_M * WORLD_UNIT_M;
    }

    /**
     * Splits a line into stretches on and off bridges. Neighbouring stretches share an end point
     */
    private bridgeStretches(line: Vector[]): {line: Vector[]; bridge: boolean}[] {
        const water = this.input.bridgeWater.filter(w => w.length >= 3);
        if (water.length === 0 || line.length < 2) return [{line, bridge: false}];
        const boxes = water.map(w => PolygonUtil.boundingBox(w));
        const wet = (p: Vector): boolean => water.some((w, i) => {
            const b = boxes[i];
            return p.x >= b[0] && p.y >= b[1] && p.x <= b[2] && p.y <= b[3] && PolygonUtil.insidePolygon(p, w);
        });

        // Extra points only where the line could cross water
        const STEP = 2;
        const pts: Vector[] = [];
        for (let i = 0; i < line.length - 1; i++) {
            const a = line[i];
            const b = line[i + 1];
            pts.push(a);
            const near = boxes.some(box => Math.max(a.x, b.x) >= box[0] && Math.min(a.x, b.x) <= box[2]
                && Math.max(a.y, b.y) >= box[1] && Math.min(a.y, b.y) <= box[3]);
            if (!near) continue;
            const n = Math.ceil(a.distanceTo(b) / STEP);
            for (let k = 1; k < n; k++) pts.push(a.clone().add(b.clone().sub(a).multiplyScalar(k / n)));
        }
        pts.push(line[line.length - 1]);

        const flags = pts.map(wet);
        if (!flags.some(f => f)) return [{line, bridge: false}];
        // Bridges reach a little way onto each bank, as abutments
        const onBridge = flags.map((_, i) => flags.slice(Math.max(0, i - 2), i + 3).some(f => f));

        const out: {line: Vector[]; bridge: boolean}[] = [];
        let start = 0;
        for (let i = 1; i <= pts.length; i++) {
            if (i === pts.length || onBridge[i] !== onBridge[start]) {
                const piece = pts.slice(start, Math.min(pts.length, i + 1));
                if (piece.length >= 2) out.push({line: piece, bridge: onBridge[start]});
                start = i;
            }
        }
        return out;
    }

    private run(): any {
        const input = this.input;

        // Areas
        for (const a of input.areas) {
            this.addPolygon(a.cls, a.polygon, Object.assign({z_order: Z_ORDER[a.cls]}, a.name ? {name: a.name} : {}));
        }

        // Buildings
        const churches = new Set(input.churches);
        const height = (b: Vector[], fallback: number): number =>
            Math.round((input.heights.has(b) ? input.heights.get(b) * WORLD_UNIT_M : fallback) * 10) / 10;
        // Houses have storeys of about 3 m under a pitched roof, sheds and tanks are one tall storey
        const address = (b: Vector[]): {[k: string]: any} => {
            const a = input.addresses.get(b);
            if (!a) return {};
            const out: {[k: string]: any} = {svg_id: a.id};
            if (a.address) Object.assign(out, {address: a.address, housenumber: a.number, street: a.street});
            return out;
        };
        const building = (cls: string, b: Vector[], h: number, roof: string): void => {
            const maxLevels = cls === 'apartments' ? 3 : 2;
            // Too tall for a pitched roof house: an apartment or office block with a flat roof
            if (roof === 'gabled' && h > 3 * maxLevels + 4) {
                this.addPolygon(cls, b, Object.assign({height: h, eave_height: h, levels: Math.round(h / 3), roof: 'flat'}, address(b)));
                return;
            }
            const levels = roof === 'gabled' ? Math.max(1, Math.min(maxLevels, Math.floor((h - 2.5) / 3))) : (cls === 'industrial_office' || cls === 'mall' ? 2 : 1);
            const eave = roof === 'gabled' ? Math.min(h, 3 * levels + 0.5) : h;
            this.addPolygon(cls, b, Object.assign({height: h, eave_height: Math.round(eave * 10) / 10, levels, roof}, address(b)));
        };
        for (const b of input.houses) {
            const area = SceneExport.areaM2(b);
            if (churches.has(b)) building('church', b, 14, 'gabled');
            else if (area < 45) building('outbuilding', b, 3, 'gabled');
            else building('house', b, height(b, 9), 'gabled');
        }
        for (const b of input.lowIncomeHouses) {
            if (SceneExport.areaM2(b) < 45) building('outbuilding', b, 3, 'gabled');
            else building('small_house', b, height(b, 7), 'gabled');
        }
        for (const b of input.industrialBuildings) {
            const area = SceneExport.areaM2(b);
            if (input.portBuildings.has(b)) {
                if (area < 600) building('container_stack', b, 8, 'flat');
                else building('port_shed', b, height(b, 11), 'flat');
            } else if (b.length === 16) {
                building('storage_tank', b, 12, 'dome');
            } else if (area < 400) {
                building('industrial_office', b, 7, 'flat');
            } else {
                building('warehouse', b, height(b, 11), 'flat');
            }
        }

        for (const s of input.siteBuildings) {
            if (s.kind === 'apartments') building('apartments', s.polygon, height(s.polygon, 12), 'gabled');
            else if (s.kind === 'mall') building('mall', s.polygon, height(s.polygon, 12), 'flat');
            else building('retail', s.polygon, height(s.polygon, 6), 'flat');
        }

        // Roads, split at bridges and where they meet, as the edges of a road network
        const pieces: {line: Vector[]; cls: string; halfWidth: number; road: SceneRoad; bridge: boolean}[] = [];
        for (const r of input.roads) {
            const halfWidth = ROAD_WIDTH[r.cls] / WORLD_UNIT_M / 2;
            for (const st of this.bridgeStretches(r.line)) pieces.push({line: st.line, cls: r.cls, halfWidth, road: r, bridge: st.bridge});
        }
        const network = RoadNetwork.build(pieces);
        const edgeFeature: number[] = [];
        for (const e of network.edges) {
            // Past the end of the pieces are driveways added to reach car parks
            const piece = pieces[e.road] || {road: {line: e.line, cls: 'service'} as SceneRoad, bridge: false};
            const r = piece.road;
            const props: {[k: string]: any} = {
                width: ROAD_WIDTH[r.cls],
                lanes: ROAD_LANES[r.cls],
                bridge: piece.bridge ? 1 : 0,
                level: piece.bridge ? 1 : 0,
                deck_height: piece.bridge ? BRIDGE_DECK_M : 0,
                // Motorways and ramps pass over anything they cross, joining other roads only where a ramp ends
                grade_separated: r.cls === 'motorway' || r.cls === 'motorway_link' ? 1 : 0,
                from_node: e.from + 1,
                to_node: e.to + 1,
                length: Math.round(e.length * WORLD_UNIT_M * 100) / 100,
            };
            if (r.cls === 'motorway') {
                props.dual_carriageway = 1;
                props.median_width = 2;
            }
            if (r.frontage) props.frontage = 1;
            if (!pieces[e.road]) props.driveway = 1;
            if (r.name) props.name = r.name;
            if (r.ref) props.ref = r.ref;
            const id = this.addLine(r.cls, e.line, props, false);
            edgeFeature.push(id);
        }
        const nodes = network.nodes.map((n, i) => ({
            id: i + 1,
            coordinates: this.toMetres(n.at),
            edges: n.edges.map(e => edgeFeature[e]).filter(id => id !== null),
        }));

        for (const r of input.railways) {
            for (const s of this.bridgeStretches(r)) {
                this.addLine('rail', s.line, {width: ROAD_WIDTH.rail, gauge: 1.435, tracks: 1,
                    bridge: s.bridge ? 1 : 0, level: s.bridge ? 1 : 0, deck_height: s.bridge ? BRIDGE_DECK_M : 0});
            }
        }
        for (const p of input.paths) this.addLine('footway', p, {width: ROAD_WIDTH.footway});
        if (input.riverCentreline.length >= 2) {
            this.addLine('river_centreline', input.riverCentreline, input.riverName ? {name: input.riverName} : {});
        }

        // Points and labels
        for (const c of input.churches) this.addPoint('place_of_worship', PolygonUtil.averagePoint(c), {});
        for (const p of input.parking) this.addPoint('parking', p, {});
        // Hover height is where the 2D map's floating labels float, at real (unexaggerated) building scale
        for (const l of input.labels) this.addPoint(l.cls, l.at, {name: l.name, hover_height: Math.round(l.hoverHeight * 10) / 10});

        const view = [input.viewOrigin, input.viewOrigin.clone().add(input.viewSize)].map(v => this.toMetres(v));
        const rect = (corners: number[][]): number[] => [Math.min(corners[0][0], corners[1][0]), Math.min(corners[0][1], corners[1][1]),
            Math.max(corners[0][0], corners[1][0]), Math.max(corners[0][1], corners[1][1])];
        const rectangle = (origin: Vector, size: Vector): Vector[] => {
            const end = origin.clone().add(size);
            return [origin, new Vector(end.x, origin.y), end, new Vector(origin.x, end.y)];
        };
        const area = (origin: Vector, size: Vector, land: Vector[][]): any => ({
            bounds: rect([this.toMetres(origin), this.toMetres(origin.clone().add(size))]),
            polygon: this.ring(rectangle(origin, size)),
            land: land.filter(l => l.length >= 3).map(l => this.ring(l)),
        });
        const classes = Object.keys(CLASSES).map(name => Object.assign({name}, CLASSES[name]))
            .sort((a, b) => a.id - b.id);
        return {
            type: 'FeatureCollection',
            map_maker: {
                format: SCENE_FORMAT,
                version: SCENE_VERSION,
                units: 'metres',
                axes: 'x east, y north, z up; ground at z = 0',
                world_unit_m: WORLD_UNIT_M,
                // The view is what the 2D map shows, data reaches a little beyond it
                view_bounds: rect(view),
                // The view the map was generated for. It's built up right to its edges, so it's the edge of the world
                boundary: area(input.mapOrigin, input.mapSize, input.mapLand),
                // Where roads and buildings were generated, the boundary enlarged a little. The edge of the
                // generator is out here, where streets and blocks can stop short, out of sight from inside the boundary
                generated_area: area(input.generationOrigin, input.generationSize, input.land),
                // How the 2D map's pseudo 3D view is drawn, to match it with a perspective camera, see docs/game-export.md
                pseudo_3d: {
                    height_exaggeration: input.camera.heightExaggeration,
                    camera_height_m: Math.round(input.camera.cameraHeight * WORLD_UNIT_M * 10) / 10,
                    viewport_px: [input.camera.screenSize.x, input.camera.screenSize.y],
                    vertical_fov_deg: Math.round(2 * Math.atan(input.camera.screenSize.y / 2 / 1000) * 180 / Math.PI * 100) / 100,
                },
                data_bounds: [this.min.x, this.min.y, this.max.x, this.max.y],
                layers: ['areas', 'waterways', 'paths', 'roads', 'railways', 'buildings', 'points', 'labels'],
                classes,
                feature_count: this.features.length,
            },
            features: this.features,
            // Where roads meet. Each road feature is one edge between two nodes (from_node, to_node)
            road_network: {nodes},
            // Every street name once, with the streets it meets
            streets: input.streets.map(st => ({name: st.name, kind: st.kind, cross_streets: st.crossStreets})),
        };
    }
}
