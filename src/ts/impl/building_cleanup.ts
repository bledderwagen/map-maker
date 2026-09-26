import * as jsts from 'jsts';
import Vector from '../vector';
import PolygonUtil from './polygon_util';

export interface RoadClearance {
    line: Vector[];
    halfWidth: number;  // Half the drawn width of the road, world units
}

/**
 * Tidies building footprints after layout
 */
export default class BuildingCleanup {
    private static readonly CELL = 20;
    private static factory = new jsts.geom.GeometryFactory();

    /**
     * Removes buildings that touch a road, allowing for the road's width
     */
    static clearRoads(buildings: Vector[][], roads: RoadClearance[], margin = 0.5): Vector[][] {
        if (roads.length === 0) return buildings;
        const cell = BuildingCleanup.CELL;
        const grid = new Map<string, {a: Vector; b: Vector; clearance: number}[]>();
        for (const road of roads) {
            const clearance = road.halfWidth + margin;
            for (let i = 0; i < road.line.length - 1; i++) {
                const a = road.line[i];
                const b = road.line[i + 1];
                const x0 = Math.floor((Math.min(a.x, b.x) - clearance) / cell);
                const x1 = Math.floor((Math.max(a.x, b.x) + clearance) / cell);
                const y0 = Math.floor((Math.min(a.y, b.y) - clearance) / cell);
                const y1 = Math.floor((Math.max(a.y, b.y) + clearance) / cell);
                // Very long segments would fill too many cells, they're rare after simplification
                if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) continue;
                for (let x = x0; x <= x1; x++) {
                    for (let y = y0; y <= y1; y++) {
                        const key = `${x},${y}`;
                        if (!grid.has(key)) grid.set(key, []);
                        grid.get(key).push({a, b, clearance});
                    }
                }
            }
        }

        return buildings.filter(polygon => {
            const box = PolygonUtil.boundingBox(polygon);
            const seen = new Set<{a: Vector; b: Vector; clearance: number}>();
            for (let x = Math.floor(box[0] / cell); x <= Math.floor(box[2] / cell); x++) {
                for (let y = Math.floor(box[1] / cell); y <= Math.floor(box[3] / cell); y++) {
                    for (const s of grid.get(`${x},${y}`) || []) {
                        if (seen.has(s)) continue;
                        seen.add(s);
                        if (BuildingCleanup.touches(polygon, s.a, s.b, s.clearance)) return false;
                    }
                }
            }
            return true;
        });
    }

    private static touches(polygon: Vector[], a: Vector, b: Vector, clearance: number): boolean {
        // A corner too close to the road
        for (const v of polygon) {
            if (PolygonUtil.distanceToSegment(v, a, b) < clearance) return true;
        }
        // The road runs through the building
        if (PolygonUtil.insidePolygon(a, polygon) || PolygonUtil.insidePolygon(b, polygon)) return true;
        for (let i = 0; i < polygon.length; i++) {
            const c = polygon[i];
            const d = polygon[(i + 1) % polygon.length];
            if (PolygonUtil.segmentIntersection(a, b, c, d) !== null) return true;
            // A long wall passing close to the road without a corner near it
            if (PolygonUtil.distanceToSegment(a, c, d) < clearance || PolygonUtil.distanceToSegment(b, c, d) < clearance) return true;
        }
        return false;
    }

    /**
     * Where buildings overlap: a building overlapping two or more others is removed,
     * then any building overlapping exactly one other is merged with it
     */
    static resolveOverlaps(buildings: Vector[][]): Vector[][] {
        const geometries = buildings.map(b => BuildingCleanup.toJts(b));
        const neighbours = BuildingCleanup.overlapGraph(buildings, geometries);

        // A building caught between two or more others is the one that doesn't belong
        const removed = new Set<number>();
        neighbours.forEach((n, i) => { if (n.length >= 2) removed.add(i); });

        const out: Vector[][] = [];
        const merged = new Set<number>();
        for (let i = 0; i < buildings.length; i++) {
            if (removed.has(i) || merged.has(i)) continue;
            const partners = neighbours[i].filter(j => !removed.has(j));
            if (partners.length === 1 && !merged.has(partners[0]) && geometries[i] && geometries[partners[0]]) {
                const j = partners[0];
                const union = BuildingCleanup.merge(geometries[i], geometries[j]);
                if (union !== null) {
                    out.push(union);
                    merged.add(i);
                    merged.add(j);
                    continue;
                }
            }
            out.push(buildings[i]);
        }
        return out;
    }

    private static overlapGraph(buildings: Vector[][], geometries: any[]): number[][] {
        const cell = BuildingCleanup.CELL;
        const boxes = buildings.map(b => PolygonUtil.boundingBox(b));
        const grid = new Map<string, number[]>();
        boxes.forEach((box, i) => {
            for (let x = Math.floor(box[0] / cell); x <= Math.floor(box[2] / cell); x++) {
                for (let y = Math.floor(box[1] / cell); y <= Math.floor(box[3] / cell); y++) {
                    const key = `${x},${y}`;
                    if (!grid.has(key)) grid.set(key, []);
                    grid.get(key).push(i);
                }
            }
        });

        const neighbours: number[][] = buildings.map(() => []);
        const checked = new Set<string>();
        grid.forEach(ids => {
            for (let p = 0; p < ids.length; p++) {
                for (let q = p + 1; q < ids.length; q++) {
                    const i = Math.min(ids[p], ids[q]);
                    const j = Math.max(ids[p], ids[q]);
                    const key = `${i},${j}`;
                    if (checked.has(key)) continue;
                    checked.add(key);
                    if (!PolygonUtil.boundingBoxesOverlap(boxes[i], boxes[j])) continue;
                    if (!geometries[i] || !geometries[j]) continue;
                    try {
                        // Touching along an edge is fine, only a real overlap counts
                        if (geometries[i].intersects(geometries[j]) && geometries[i].intersection(geometries[j]).getArea() > 0.01) {
                            neighbours[i].push(j);
                            neighbours[j].push(i);
                        }
                    } catch (e) {
                        // Invalid geometry, leave it be
                    }
                }
            }
        });
        return neighbours;
    }

    private static merge(a: any, b: any): Vector[] {
        try {
            const union = a.union(b);
            if (union.getNumGeometries() !== 1 || !union.getExteriorRing) return null;
            const out = union.getExteriorRing().getCoordinates().map((c: any) => new Vector(c.x, c.y));
            out.pop();
            return out.length >= 3 ? out : null;
        } catch (e) {
            return null;
        }
    }

    private static toJts(polygon: Vector[]): any {
        if (polygon.length < 3) return null;
        try {
            const coords = polygon.map(v => new jsts.geom.Coordinate(v.x, v.y));
            coords.push(coords[0]);
            const g = BuildingCleanup.factory.createPolygon(BuildingCleanup.factory.createLinearRing(coords), []);
            return g.isValid() ? g : null;
        } catch (e) {
            return null;
        }
    }
}
