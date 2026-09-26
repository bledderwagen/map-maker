import * as log from 'loglevel';
import Vector from '../vector';
import FieldIntegrator from './integrator';
import StreamlineGenerator from './streamlines';
import {StreamlineParams} from './streamlines';
import TensorField from './tensor_field';
import PolygonUtil from './polygon_util';

export interface HighwayParams extends StreamlineParams {
    numHighways: number;
    frontageRoads: boolean;
    frontageDistance: number;  // Distance from highway centreline to frontage road
    interchangeSize: number;
}

interface Crossing {
    point: Vector;
    highwayDir: Vector;
    roadDir: Vector;
    cloverleaf: boolean;
    highway: Vector[];
    distanceAlong: number;  // Distance along the highway to the crossing
}

export interface Interchange {
    centre: Vector;
    ramps: Vector[][];  // Polylines, world space
    area: Vector[];  // Polygon covering the interchange, world space
    cloverleaf: boolean;
}

/**
 * Long, smooth, limited-access roads that cross the whole map
 * Integrated along the tensor field like other roads so they fit the city layout,
 * but heavily smoothed and allowed to bridge rivers
 */
export default class HighwayGenerator extends StreamlineGenerator {
    private readonly TRIES = 40;
    private readonly SMOOTHING_ITERATIONS = 3;
    private readonly HIGHWAY_HALF_WIDTH = 5;  // Ramps leave from the edge of the carriageway

    public highways: Vector[][] = [];  // Simplified and smoothed
    public frontageRoads: Vector[][] = [];
    public interchanges: Interchange[] = [];
    private rawFrontageRoads: Vector[][] = [];  // Before interchanges are cut out

    constructor(integrator: FieldIntegrator,
                origin: Vector,
                worldDimensions: Vector,
                protected params: HighwayParams,
                private tensorField: TensorField) {
        super(integrator, origin, worldDimensions, params);
    }

    clearStreamlines(): void {
        super.clearStreamlines();
        this.highways = [];
        this.frontageRoads = [];
        this.rawFrontageRoads = [];
        this.interchanges = [];
    }

    createHighways(): void {
        const oldIgnoreRiver = this.tensorField.ignoreRiver;
        this.tensorField.ignoreRiver = true;  // Highways bridge rivers

        const firstMajor = Math.random() < 0.5;
        const minDimension = Math.min(this.worldDimensions.x, this.worldDimensions.y);

        for (let i = 0; i < this.params.numHighways; i++) {
            // Alternate directions so highways cross each other
            const major = i % 2 === 0 ? firstMajor : !firstMajor;
            let best: Vector[] = null;
            let bestLength = 0;

            for (let t = 0; t < this.TRIES; t++) {
                const seed = this.getSeed(major);
                if (seed === null) break;
                const streamline = this.integrateStreamline(seed, major);
                if (streamline.length < 10) continue;

                const length = this.polylineLength(streamline);
                const reachesEdges = this.endsAtBoundary(streamline[0]) && this.endsAtBoundary(streamline[streamline.length - 1]);
                if (reachesEdges && length > 0.8 * minDimension) {
                    best = streamline;
                    break;
                }

                if (length > bestLength) {
                    bestLength = length;
                    best = streamline;
                }
            }

            if (best === null || this.polylineLength(best) < 0.5 * minDimension) {
                log.info('Highway generator: could not find a long enough route');
                continue;
            }

            this.addHighway(best, major);
        }

        this.tensorField.ignoreRiver = oldIgnoreRiver;
    }

    private addHighway(streamline: Vector[], major: boolean): void {
        this.extendOffScreen(streamline);
        const simplified = this.simplifyStreamline(streamline);
        const highway = PolygonUtil.smoothPolyline(simplified, this.SMOOTHING_ITERATIONS);
        this.highways.push(highway);
        this.allStreamlinesSimple.push(highway);

        const complex = this.complexifyStreamline(highway);
        this.grid(major).addPolyline(complex);
        this.streamlines(major).push(complex);
        this.allStreamlines.push(complex);

        if (this.params.frontageRoads) {
            for (const side of [-1, 1]) {
                const offset = PolygonUtil.offsetPolyline(highway, side * this.params.frontageDistance);
                for (const piece of this.splitWhere(offset, v => this.integrator.onLand(v))) {
                    if (piece.length < 3) continue;
                    this.rawFrontageRoads.push(piece);
                    this.grid(major).addPolyline(this.complexifyStreamline(piece));
                }
            }
            this.frontageRoads = this.rawFrontageRoads.slice();
        }
    }

    /**
     * Distance from point to the nearest highway centreline
     */
    distanceToHighways(point: Vector): number {
        let min = Infinity;
        for (const h of this.highways) {
            min = Math.min(min, PolygonUtil.distanceToPolyline(point, h));
        }
        return min;
    }

    /**
     * Finds where roads cross highways and builds ramps there
     * Highway-highway crossings get cloverleafs, other roads get diamond interchanges
     */
    createInterchanges(roads: Vector[][]): void {
        this.interchanges = [];
        const L = this.params.interchangeSize;

        const crossings: Crossing[] = [];
        for (let i = 0; i < this.highways.length; i++) {
            for (let j = i + 1; j < this.highways.length; j++) {
                crossings.push(...this.findCrossings(this.highways[i], this.highways[j], true));
            }
        }
        for (const h of this.highways) {
            for (const r of roads) {
                crossings.push(...this.findCrossings(h, r, false));
            }
        }

        for (const c of crossings) {
            const size = c.cloverleaf ? 1.3 * L : L;
            if (!this.integrator.onLand(c.point) || !this.pointInBounds(c.point)) continue;
            // Keep interchanges apart, cloverleafs take priority as they are added first
            if (this.interchanges.some(existing => existing.centre.distanceTo(c.point) < 5 * L)) continue;

            // No ramps out over the sea, e.g. near the coast; try a tighter interchange first
            for (const scale of [1, 0.75, 0.55]) {
                const ramps = c.cloverleaf ?
                    this.cloverleafRamps(c.point, c.highwayDir, c.roadDir, size * scale) :
                    this.diamondRamps(c, size * scale);
                if (ramps.length === 0) break;

                const allPoints: Vector[] = [];
                for (const r of ramps) allPoints.push(...r);
                const wet = allPoints.filter(v => !this.integrator.onLand(v)).length;
                if (wet > 0.05 * allPoints.length) continue;
                const area = PolygonUtil.bufferedHull(allPoints, 6);
                this.interchanges.push({centre: c.point, ramps, area, cloverleaf: c.cloverleaf});
                break;
            }
        }

        // Frontage roads run straight through diamond interchanges, but stop at cloverleafs
        this.frontageRoads = [];
        const cloverleafs = this.interchanges.filter(i => i.cloverleaf);
        for (const f of this.rawFrontageRoads) {
            const fine = PolygonUtil.resamplePolyline(f, 3).points;
            const pieces = this.splitWhere(fine, v => !cloverleafs.some(i => PolygonUtil.insidePolygon(v, i.area)));
            for (const piece of pieces) {
                if (piece.length >= 3) this.frontageRoads.push(piece);
            }
        }
    }

    /**
     * Whether a frontage road runs alongside the highway at this point
     */
    private frontageAt(point: Vector): boolean {
        if (!this.params.frontageRoads) return false;
        return this.rawFrontageRoads.some(f => PolygonUtil.distanceToPolyline(point, f) < 1);
    }

    private findCrossings(highway: Vector[], road: Vector[], cloverleaf: boolean): Crossing[] {
        const out: Crossing[] = [];
        for (let i = 0; i < highway.length - 1; i++) {
            for (let j = 0; j < road.length - 1; j++) {
                const hit = PolygonUtil.segmentIntersection(highway[i], highway[i + 1], road[j], road[j + 1]);
                if (hit === null) continue;
                const highwayDir = this.tangentAt(highway, i);
                const roadDir = this.tangentAt(road, j);
                // Ignore glancing crossings, ramps would be degenerate
                if (Math.abs(highwayDir.x * roadDir.y - highwayDir.y * roadDir.x) < 0.5) continue;
                let distanceAlong = 0;
                for (let k = 0; k < i; k++) distanceAlong += highway[k].distanceTo(highway[k + 1]);
                distanceAlong += hit.t * highway[i].distanceTo(highway[i + 1]);
                out.push({point: hit.point, highwayDir, roadDir, cloverleaf, highway, distanceAlong});
            }
        }
        return out;
    }

    /**
     * Smoothed direction around segment i, normalised
     */
    private tangentAt(line: Vector[], i: number): Vector {
        const a = line[Math.max(0, i - 2)];
        const b = line[Math.min(line.length - 1, i + 3)];
        return b.clone().sub(a).normalize();
    }

    /**
     * Four slip roads, one for each direction on and off the highway
     *
     * With frontage roads (Texas style) the ramps join the frontage road well before the crossroad,
     * and the frontage road meets the crossroad at an ordinary junction.
     * Without, the ramps run alongside the highway and meet the crossroad at two junctions either side.
     * Ramps leave the highway at a shallow angle, as a real slip road does.
     */
    private diamondRamps(c: Crossing, L: number): Vector[][] {
        const ramps: Vector[][] = [];
        const h = c.highwayDir;
        const r = c.roadDir;
        const n = new Vector(-h.y, h.x);
        // u is distance along the highway from the crossroad, v is offset to the side, so ramps follow curves
        const along = HighwayGenerator.alongPolyline(c.highway);
        const at = (u: number, v: number): Vector => {
            const {point, normal} = along(c.distanceAlong + u);
            // Keep offsets on the same side as n at the crossing
            const sign = normal.dot(n) >= 0 ? 1 : -1;
            return point.add(normal.multiplyScalar(sign * v));
        };
        const edge = this.HIGHWAY_HALF_WIDTH;
        const F = this.params.frontageDistance;
        const gore = 5 * L;  // Where the ramp leaves the highway, from the crossroad

        // Distance along the highway at which the crossroad is offset v from the highway
        const rn = r.dot(n);
        const rh = r.dot(h);
        const crossroadU = (v: number): number => Math.abs(rn) < 0.2 ? 0 : v * rh / rn;

        for (const side of [-1, 1]) {
            for (const dir of [-1, 1]) {
                const start = dir * gore;
                if (this.frontageAt(at(dir * 2.2 * L, side * F))) {
                    // Merge into the frontage road
                    const end = dir * 2.2 * L;
                    const span = start - end;
                    ramps.push(HighwayGenerator.bezierUV(at,
                        [start, side * edge],
                        [start - 0.5 * span, side * edge],
                        [end + 0.4 * span, side * F],
                        [end, side * F]));
                } else {
                    // Run alongside the highway to a junction with the crossroad
                    const offset = 1.3 * L;
                    const end = crossroadU(side * offset);
                    const span = start - end;
                    if (span * dir < L) continue;  // Crossroad too oblique on this side
                    ramps.push(HighwayGenerator.bezierUV(at,
                        [start, side * edge],
                        [start - 0.45 * span, side * edge],
                        [end + 0.45 * span, side * offset],
                        [end, side * offset]));
                }
            }
        }
        return ramps;
    }

    /**
     * Cubic bezier in (along, offset) coordinates, mapped to world space point by point
     */
    private static bezierUV(at: (u: number, v: number) => Vector,
                            p0: number[], p1: number[], p2: number[], p3: number[]): Vector[] {
        const samples = 16;
        const out: Vector[] = [];
        for (let i = 0; i <= samples; i++) {
            const t = i / samples;
            const mt = 1 - t;
            const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
            out.push(at(
                a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]));
        }
        return out;
    }

    /**
     * Returns a function giving the point and unit normal at a distance along a polyline
     */
    private static alongPolyline(line: Vector[]): (distance: number) => {point: Vector; normal: Vector} {
        const cumulative = [0];
        for (let i = 0; i < line.length - 1; i++) cumulative.push(cumulative[i] + line[i].distanceTo(line[i + 1]));
        return (distance: number): {point: Vector; normal: Vector} => {
            let i = 0;
            while (i < line.length - 2 && cumulative[i + 1] < distance) i++;
            const segment = line[i + 1].clone().sub(line[i]);
            const length = segment.length();
            const t = length === 0 ? 0 : (distance - cumulative[i]) / length;
            const point = line[i].clone().add(segment.clone().multiplyScalar(t));
            // Smooth the normal using neighbouring segments
            const a = line[Math.max(0, i - 1)];
            const b = line[Math.min(line.length - 1, i + 2)];
            const tangent = b.clone().sub(a).normalize();
            return {point, normal: new Vector(-tangent.y, tangent.x)};
        };
    }

    /**
     * Loops in each quadrant plus outer connecting ramps
     */
    private cloverleafRamps(centre: Vector, h: Vector, r: Vector, L: number): Vector[][] {
        const ramps: Vector[][] = [];
        const sinTheta = Math.abs(h.x * r.y - h.y * r.x);
        const loopRadius = 0.6 * L;
        const edge = this.HIGHWAY_HALF_WIDTH / sinTheta;
        const at = (u: number, v: number): Vector => centre.clone().add(h.clone().multiplyScalar(u)).add(r.clone().multiplyScalar(v));
        for (const su of [-1, 1]) {
            for (const sv of [-1, 1]) {
                // Loop just touching the edge of both highways
                const d = (loopRadius + this.HIGHWAY_HALF_WIDTH) / sinTheta;
                const loop = PolygonUtil.circle(at(su * d, sv * d), loopRadius, 28);
                loop.push(loop[0]);
                ramps.push(loop);

                // Outer ramp for right turns, leaving each highway at a shallow angle and bulging round the loop
                ramps.push(PolygonUtil.bezier(
                    at(su * 4.2 * L, sv * edge),
                    at(su * 2.4 * L, sv * (edge + 0.2 * L)),
                    at(su * (edge + 0.2 * L), sv * 2.4 * L),
                    at(su * edge, sv * 4.2 * L),
                    20));
            }
        }
        return ramps;
    }

    /**
     * Splits line into runs of consecutive points satisfying keep
     */
    private splitWhere(line: Vector[], keep: (v: Vector) => boolean): Vector[][] {
        const out: Vector[][] = [];
        let current: Vector[] = [];
        for (const v of line) {
            if (keep(v)) {
                current.push(v);
            } else if (current.length > 0) {
                out.push(current);
                current = [];
            }
        }
        if (current.length > 0) out.push(current);
        return out;
    }

    private polylineLength(line: Vector[]): number {
        let length = 0;
        for (let i = 0; i < line.length - 1; i++) length += line[i].distanceTo(line[i + 1]);
        return length;
    }

    /**
     * A highway may end at the edge of the map or at the sea
     */
    private endsAtBoundary(v: Vector): boolean {
        const margin = 5 * this.params.dstep;
        const toOrigin = v.clone().sub(this.origin);
        const nearEdge = toOrigin.x <= margin || toOrigin.y <= margin ||
            toOrigin.x >= this.worldDimensions.x - margin || toOrigin.y >= this.worldDimensions.y - margin;
        if (nearEdge) return true;

        // Check whether sea is just ahead
        for (const dir of [new Vector(1, 0), new Vector(-1, 0), new Vector(0, 1), new Vector(0, -1)]) {
            if (!this.integrator.onLand(v.clone().add(dir.multiplyScalar(margin)))) return true;
        }
        return false;
    }

    /**
     * Continue straight past the map edge so the highway doesn't visibly stop
     */
    private extendOffScreen(streamline: Vector[]): void {
        const extend = (end: Vector, previous: Vector): Vector => {
            const toOrigin = end.clone().sub(this.origin);
            const margin = 5 * this.params.dstep;
            const nearEdge = toOrigin.x <= margin || toOrigin.y <= margin ||
                toOrigin.x >= this.worldDimensions.x - margin || toOrigin.y >= this.worldDimensions.y - margin;
            if (!nearEdge) return null;
            return end.clone().add(end.clone().sub(previous).setLength(this.params.dstep * 30));
        };

        const n = streamline.length;
        const newEnd = extend(streamline[n - 1], streamline[Math.max(0, n - 6)]);
        if (newEnd !== null) streamline.push(newEnd);
        const newStart = extend(streamline[0], streamline[Math.min(streamline.length - 1, 5)]);
        if (newStart !== null) streamline.unshift(newStart);
    }
}
