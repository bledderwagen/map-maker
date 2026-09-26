import * as log from 'loglevel';
import Vector from '../vector';
import FieldIntegrator from './integrator';
import StreamlineGenerator from './streamlines';
import {StreamlineParams} from './streamlines';
import TensorField from './tensor_field';
import PolygonUtil from './polygon_util';
import * as SimplexNoise from 'simplex-noise';
import {MeanderSimulator, ShorelineSimulator, despike, normals, removeLoops, resampleEqual, smoothLine, smoothValues} from './hydrology';

export interface WaterParams extends StreamlineParams {
    coastNoise: NoiseStreamlineParams;
    riverNoise: NoiseStreamlineParams;
    riverBankSize: number;
    riverSize: number;
}

export interface NoiseStreamlineParams {
    noiseEnabled: boolean;
    noiseSize: number;
    noiseAngle: number;
}

/**
 * Integrates polylines to create coastline and river, with controllable noise
 */
export default class WaterGenerator extends StreamlineGenerator {
    private readonly TRIES = 100;
    private coastlineMajor = true;
    private _coastline: Vector[] = [];  // Noisy line
    private _seaPolygon: Vector[] = [];  // Uses screen rectangle and simplified road
    private _coastRoad: Vector[] = [];  // Simplified coastline, the edge of the sea polygon
    private _riverPolygon: Vector[] = []; // Simplified
    private _riverSecondaryRoad: Vector[] = [];
    private _shore: Vector[] = [];  // Simplified water's edge along the coast
    private _backshore: Vector[] = [];  // Landward edge of the beach, or the water's edge where there is none
    private _shoreBeach: number[] = [];  // Beach width at each point of the unsimplified shore
    private _shoreDetailed: Vector[] = [];
    private _beaches: Vector[][] = [];
    private _floodplain: Vector[] = [];  // Riverside park between the bank roads
    private _lakes: Vector[][] = [];  // Oxbow lakes
    private _sandBars: Vector[][] = [];
    private _riversidePaths: Vector[][] = [];
    private noise = new SimplexNoise();

    constructor(integrator: FieldIntegrator,
                origin: Vector,
                worldDimensions: Vector,
                protected params: WaterParams,
                private tensorField: TensorField) {
        super(integrator, origin, worldDimensions, params);
    }

    get coastline(): Vector[] {
        return this._coastline;
    }

    get seaPolygon(): Vector[] {
        return this._seaPolygon;
    }

    get coastRoad(): Vector[] {
        return this._coastRoad;
    }

    get riverPolygon(): Vector[] {
        return this._riverPolygon;
    }

    get riverSecondaryRoad(): Vector[] {
        return this._riverSecondaryRoad;
    }

    get shore(): Vector[] {
        return this._shore;
    }

    get backshore(): Vector[] {
        return this._backshore;
    }

    get shoreDetailed(): Vector[] {
        return this._shoreDetailed;
    }

    get shoreBeachWidths(): number[] {
        return this._shoreBeach;
    }

    get beaches(): Vector[][] {
        return this._beaches;
    }

    get floodplain(): Vector[] {
        return this._floodplain;
    }

    get lakes(): Vector[][] {
        return this._lakes;
    }

    get sandBars(): Vector[][] {
        return this._sandBars;
    }

    get riversidePaths(): Vector[][] {
        return this._riversidePaths;
    }

    createCoast(): void {
        let coastStreamline;
        let seed;
        let major;

        if (this.params.coastNoise.noiseEnabled) {
            this.tensorField.enableGlobalNoise(this.params.coastNoise.noiseAngle, this.params.coastNoise.noiseSize);    
        }
        for (let i = 0; i < this.TRIES; i++) {
            major = Math.random() < 0.5;
            seed = this.getSeed(major);
            coastStreamline = this.extendStreamline(this.integrateStreamline(seed, major));

            if (this.reachesEdges(coastStreamline)) {
                break;
            }
        }
        this.tensorField.disableGlobalNoise();

        this.coastlineMajor = major;

        // Which side is the sea? The sea polygon is the smaller side of the line
        const initialSea = this.getSeaPolygon(this.simplifyStreamline(coastStreamline));
        const seaward = this.seaSide(coastStreamline, initialSea);

        // Let the waves shape it
        const shaped = ShorelineSimulator.evolve(coastStreamline, seaward, {
            spacing: 5,
            iterations: 700,
            headlandAmplitude: 180,
            erosionRate: 0.15,
            maxBeachWidth: 30,  // 60 m
        });
        const shore = shaped.shore;
        this._coastline = shore;
        this._shoreDetailed = shore;
        this._shoreBeach = shaped.beachWidths;
        this._shore = this.simplifyShore(shore);
        this._seaPolygon = this.seaPolygonOnSide(this._shore, seaward);
        this.tensorField.sea = this._seaPolygon;
        // The sea is the smaller side of the final shore, check which side that is now
        const landward = -this.seaSide(shore, this._seaPolygon);
        if (landward !== -seaward) {
            // Sea swapped sides, so beach widths measured towards the old land now point the wrong way
            this._shoreBeach = shaped.beachWidths.map(() => 0);
        }
        this._beaches = this.beachPolygons(shore, this._shoreBeach, landward);
        this.tensorField.beaches = this._beaches;
        // Back of the beach, a little inland so streets that stop at the sand cross it
        const shoreNormals = normals(shore);
        this._backshore = this.simplifyShore(smoothLine(shore.map((p, i) =>
            p.clone().add(shoreNormals[i].clone().multiplyScalar(landward * (this._shoreBeach[i] + 2)))), 2));

        const road = this.simplifyStreamline(this.coastRoadLine(shore, this._shoreBeach, landward));
        this._coastRoad = road;
        this.allStreamlinesSimple.push(road);

        // Create intermediate samples
        const complex = this.complexifyStreamline(road);
        this.grid(major).addPolyline(complex);
        this.streamlines(major).push(complex);
        this.allStreamlines.push(complex);
        // Keep streets running along the shore off the waterfront, they can still run down to it
        this.grid(major).addPolyline(this.complexifyStreamline(this._shore));
    }

    /**
     * 1 if the sea is to the left of the line's direction, -1 if right, by majority vote along the line
     */
    private seaSide(line: Vector[], sea: Vector[]): number {
        const norms = normals(line);
        let vote = 0;
        const step = Math.max(1, Math.floor(line.length / 40));
        for (let i = step; i < line.length - step; i += step) {
            if (!this.pointInBounds(line[i])) continue;
            const left = PolygonUtil.insidePolygon(line[i].clone().add(norms[i].clone().multiplyScalar(8)), sea);
            const right = PolygonUtil.insidePolygon(line[i].clone().sub(norms[i].clone().multiplyScalar(8)), sea);
            if (left && !right) vote++;
            if (right && !left) vote--;
        }
        return vote >= 0 ? 1 : -1;
    }

    /**
     * The piece of the map on the given side of the line (1 left, -1 right)
     */
    private seaPolygonOnSide(line: Vector[], side: number): Vector[] {
        const pieces = PolygonUtil.lineRectanglePolygons(this.origin, this.worldDimensions, line);
        if (pieces.length === 0) return [];
        const norms = normals(line);
        const votes = pieces.map(() => 0);
        const step = Math.max(1, Math.floor(line.length / 60));
        for (let i = step; i < line.length - step; i += step) {
            if (!this.pointInBounds(line[i])) continue;
            const probe = line[i].clone().add(norms[i].clone().multiplyScalar(side * 6));
            pieces.forEach((p, k) => { if (PolygonUtil.insidePolygon(probe, p)) votes[k]++; });
        }
        let best = 0;
        pieces.forEach((_, k) => { if (votes[k] > votes[best]) best = k; });
        return pieces[best];
    }

    private simplifyShore(shore: Vector[]): Vector[] {
        const saved = this.params.simplifyTolerance;
        this.params.simplifyTolerance = 0.8;
        const out = this.simplifyStreamline(shore);
        this.params.simplifyTolerance = saved;
        return out;
    }

    private beachPolygons(shore: Vector[], widths: number[], landward: number): Vector[][] {
        const norms = normals(shore);
        const out: Vector[][] = [];
        let i = 0;
        while (i < shore.length) {
            if (widths[i] < 2) { i++; continue; }
            let j = i;
            while (j < shore.length && widths[j] >= 2) j++;
            if (j - i >= 3) {
                const outer = shore.slice(i, j).map(p => p.clone());
                const inner = shore.slice(i, j).map((p, k) =>
                    p.clone().add(norms[i + k].clone().multiplyScalar(landward * widths[i + k])));
                // Taper the ends into the shore, so sand doesn't sit on the water
                const polygon = PolygonUtil.cleanPolygon(outer.concat(inner.reverse()));
                if (polygon.length >= 3) out.push(polygon);
            }
            i = j;
        }
        return out;
    }

    /**
     * The coast road runs behind the waterfront, not on it. In places it's a promenade just behind
     * the beach, elsewhere a row of waterfront lots or a park sits between the road and the water
     */
    private coastRoadLine(shore: Vector[], beachWidths: number[], landward: number): Vector[] {
        const base = smoothLine(resampleEqual(shore, 5), 5);
        const norms = normals(base);
        const nearestBeach = base.map(p => {
            let best = 0;
            let bestDistance = Infinity;
            for (let i = 0; i < shore.length; i += 2) {
                const d = shore[i].distanceToSquared(p);
                if (d < bestDistance) {
                    bestDistance = d;
                    best = i;
                }
            }
            return beachWidths[best];
        });
        let along = 0;
        const setback = base.map((p, i) => {
            if (i > 0) along += p.distanceTo(base[i - 1]);
            const promenade = this.noise.noise2D(along / 450, 17.1) > 0.25;
            const waterfront = 32 + 14 * this.noise.noise2D(along / 200, 3.3);  // Room for a row of lots or a park
            return nearestBeach[i] + (promenade ? 6 : waterfront);
        });
        const smoothSetback = smoothValues(setback, 12);

        // Walk inland from the smoothed shore until far enough from the water, never into the sea
        const walked = base.map((p, i) => {
            const needed = Math.max(nearestBeach[i] + 5, smoothSetback[i]);
            const q = p.clone();
            let t = 0;
            for (; t < 150; t++) {
                const inSea = PolygonUtil.insidePolygon(q, this._seaPolygon);
                if (!inSea && PolygonUtil.distanceToPolyline(q, shore) >= needed) break;
                q.add(norms[i].clone().multiplyScalar(landward * 2));
            }
            return 2 * t;
        });
        // A walk much longer than its neighbours' went off at a bad angle, use theirs instead
        const median = walked.map((_, i) => {
            const window = walked.slice(Math.max(0, i - 10), i + 11).sort((a, b) => a - b);
            return window[window.length >> 1];
        });
        const distances = smoothValues(walked.map((t, i) => t > 1.3 * median[i] + 6 ? median[i] : t), 2);
        const road = base.map((p, i) => p.clone().add(norms[i].clone().multiplyScalar(landward * distances[i])));
        return despike(removeLoops(smoothLine(road, 3), 15, 3).line, Math.PI / 3, 30);
    }

    createRiver(): void {
        let riverStreamline;
        let seed;

        // Need to ignore sea when integrating for edge check
        const oldSea = this.tensorField.sea;
        this.tensorField.sea = [];
        if (this.params.riverNoise.noiseEnabled) {
            this.tensorField.enableGlobalNoise(this.params.riverNoise.noiseAngle, this.params.riverNoise.noiseSize);    
        }        
        for (let i = 0; i < this.TRIES; i++) {
            seed = this.getSeed(!this.coastlineMajor);
            riverStreamline = this.extendStreamline(this.integrateStreamline(seed, !this.coastlineMajor));

            if (this.reachesEdges(riverStreamline)) {
                break;
            } else if (i === this.TRIES - 1) {
                log.error('Failed to find river reaching edge');
            }
        }
        this.tensorField.sea = oldSea;
        this.tensorField.disableGlobalNoise();

        // Flow towards the sea. Pick the direction giving the longest stretch on land before
        // the river reaches the sea, and end it there rather than letting it run along the coast
        riverStreamline = riverStreamline.slice();
        if (this._seaPolygon.length > 0) {
            const reach = 3 * (this.params.riverSize - this.params.riverBankSize);
            const contact = riverStreamline.map(v => this.pointInBounds(v) && (PolygonUtil.insidePolygon(v, this._seaPolygon)
                || PolygonUtil.distanceToPolyline(v, this._shore) < reach));
            const first = contact.indexOf(true);
            if (first >= 0) {
                const last = contact.lastIndexOf(true);
                if (riverStreamline.length - 1 - last > first) riverStreamline.reverse();
                const mouth = riverStreamline.length - 1 - last > first ? riverStreamline.length - 1 - last : first;
                const end = riverStreamline[mouth];
                // Head straight out to sea from there
                let towards: Vector = null;
                let best = Infinity;
                for (let i = 0; i < this._shore.length - 1; i++) {
                    const d = PolygonUtil.distanceToSegment(end, this._shore[i], this._shore[i + 1]);
                    if (d < best) {
                        best = d;
                        towards = this._shore[i].clone().add(this._shore[i + 1]).divideScalar(2);
                    }
                }
                riverStreamline = riverStreamline.slice(0, mouth + 1);
                const dir = towards.clone().sub(end);
                if (dir.lengthSq() > 0) {
                    dir.normalize();
                    for (let k = 1; k <= 12; k++) riverStreamline.push(end.clone().add(dir.clone().multiplyScalar(10 * k + best)));
                }
            }
        }

        // Grow meanders
        const width = 2 * (this.params.riverSize - this.params.riverBankSize);
        const meander = MeanderSimulator.simulate(riverStreamline, {
            width,
            widthDownstream: 1.4 * width,
            sinuosity: 1.25 + 0.3 * Math.random(),
            maxIterations: 2500,
            fixed: v => PolygonUtil.insidePolygon(v, this._seaPolygon),
        });
        this._riverPolygon = meander.channel;
        const onLand = (polygon: Vector[]): boolean => !PolygonUtil.insidePolygon(PolygonUtil.averagePoint(polygon), this._seaPolygon);
        this._sandBars = meander.pointBars.filter(onLand);
        this._lakes = meander.oxbows.map(o => PolygonUtil.resizeGeometry(o, 0.35 * width, false)).filter(l => l.length >= 3 && onLand(l));

        // Bank roads run outside the meander belt, the floodplain between them is parkland
        const banks = this.bankLines(riverStreamline, meander.centreline, meander.widths, meander.oxbows, width);
        this._riversidePaths = this.bankPaths(meander.centreline, meander.widths);

        // Create river roads
        const road1 = banks.left.filter(v =>
            !PolygonUtil.insidePolygon(v, this._seaPolygon)
            && !this.vectorOffScreen(v));
        const road1Simple = this.simplifyStreamline(road1);
        const road2 = banks.right.filter(v =>
            !PolygonUtil.insidePolygon(v, this._seaPolygon)
            && !this.vectorOffScreen(v));
        const road2Simple = this.simplifyStreamline(road2);

        if (road1.length === 0 || road2.length === 0) return;

        if (road1[0].distanceToSquared(road2[0]) < road1[0].distanceToSquared(road2[road2.length - 1])) {
            road2Simple.reverse();
        }

        this.tensorField.river = road1Simple.concat(road2Simple);
        // Only the land part is parkland
        const floodplainPieces = this._seaPolygon.length > 2 ?
            PolygonUtil.subtractPolygons(this.tensorField.river, [this._seaPolygon], 100) : [this.tensorField.river];
        this._floodplain = floodplainPieces.length > 0 ? floodplainPieces[0] : [];
        // Riverside paths only where there is room between the water and the road
        this._riversidePaths = this._riversidePaths.map(path => path.filter(v =>
            PolygonUtil.insidePolygon(v, this._floodplain)
            && PolygonUtil.distanceToPolyline(v, road1Simple) > 5
            && PolygonUtil.distanceToPolyline(v, road2Simple) > 5
            && !this._lakes.some(l => PolygonUtil.insidePolygon(v, l))))
            .filter(path => path.length >= 4);

        // Road 1
        this.allStreamlinesSimple.push(road1Simple);
        this._riverSecondaryRoad = road2Simple;

        this.grid(!this.coastlineMajor).addPolyline(road1);
        this.grid(!this.coastlineMajor).addPolyline(road2);
        this.streamlines(!this.coastlineMajor).push(road1);
        this.streamlines(!this.coastlineMajor).push(road2);
        this.allStreamlines.push(road1);
        this.allStreamlines.push(road2);
    }

    /**
     * Lines either side of the valley, far enough out to clear the meander belt,
     * with a varying margin so the road is sometimes right by the water and sometimes far back
     */
    private bankLines(valley: Vector[], centreline: Vector[], widths: number[], oxbows: Vector[][], width: number): {left: Vector[]; right: Vector[]} {
        const axis = smoothLine(resampleEqual(valley, 10), 25);
        const axisNormals = normals(axis);
        const left = new Array(axis.length).fill(width / 2);
        const right = new Array(axis.length).fill(width / 2);

        const nearestAxis = (p: Vector): number => {
            let best = 0;
            let bestDistance = Infinity;
            for (let i = 0; i < axis.length; i++) {
                const d = axis[i].distanceToSquared(p);
                if (d < bestDistance) {
                    bestDistance = d;
                    best = i;
                }
            }
            return best;
        };
        const extend = (p: Vector, halfWidth: number): void => {
            const i = nearestAxis(p);
            const offset = p.clone().sub(axis[i]).dot(axisNormals[i]);
            left[i] = Math.max(left[i], offset + halfWidth);
            right[i] = Math.max(right[i], -offset + halfWidth);
        };
        centreline.forEach((p, i) => extend(p, widths[i] / 2));
        for (const o of oxbows) o.forEach(p => extend(p, 0.4 * width));

        // Spread each extent to its neighbours so the road clears the bends it passes, then smooth
        const dilate = (values: number[], radius: number): number[] => values.map((_, i) => {
            let m = 0;
            for (let k = -radius; k <= radius; k++) {
                const j = i + k;
                if (j >= 0 && j < values.length) m = Math.max(m, values[j]);
            }
            return m;
        });
        let along = 0;
        const margin = axis.map((p, i) => {
            if (i > 0) along += p.distanceTo(axis[i - 1]);
            return 6 + 40 * Math.max(0, this.noise.noise2D(along / 400, 9.9));
        });
        const leftMargin = smoothValues(margin, 8);
        const rightMargin = smoothValues(margin.map((_, i) => 6 + 40 * Math.max(0, this.noise.noise2D(i / 40, 4.4))), 8);
        const leftExtent = smoothValues(dilate(left, 4), 3).map((v, i) => Math.max(v, left[i]) + leftMargin[i]);
        const rightExtent = smoothValues(dilate(right, 4), 3).map((v, i) => Math.max(v, right[i]) + rightMargin[i]);

        // Offsetting a curved line far can fold it back on itself on the inside of curves, cut those out
        const tidy = (line: Vector[]): Vector[] => despike(removeLoops(smoothLine(line, 2), 20, 3).line, Math.PI / 3, 30);
        return {
            left: tidy(axis.map((p, i) => p.clone().add(axisNormals[i].clone().multiplyScalar(leftExtent[i])))),
            right: tidy(axis.map((p, i) => p.clone().sub(axisNormals[i].clone().multiplyScalar(rightExtent[i])))),
        };
    }

    /**
     * Footpaths following each bank of the river
     */
    private bankPaths(centreline: Vector[], widths: number[]): Vector[][] {
        const norms = normals(centreline);
        return [1, -1].map(side => smoothLine(centreline.map((p, i) =>
            p.clone().add(norms[i].clone().multiplyScalar(side * (widths[i] / 2 + 7)))), 2));
    }

    /**
     * Assumes simplified
     * Used for adding river roads
     */
    private manuallyAddStreamline(s: Vector[], major: boolean): void {
        this.allStreamlinesSimple.push(s);
        // Create intermediate samples
        const complex = this.complexifyStreamline(s);
        this.grid(major).addPolyline(complex);
        this.streamlines(major).push(complex);
        this.allStreamlines.push(complex);
    }

    /**
     * Might reverse input array
     */
    private getSeaPolygon(polyline: Vector[]): Vector[] {
        // const seaPolygon = PolygonUtil.sliceRectangle(this.origin, this.worldDimensions,
        //     polyline[0], polyline[polyline.length - 1]);

        // // Replace the longest side with coastline
        // let longestIndex = 0;
        // let longestLength = 0;
        // for (let i = 0; i < seaPolygon.length; i++) {
        //     const next = (i + 1) % seaPolygon.length;
        //     const d = seaPolygon[i].distanceToSquared(seaPolygon[next]);
        //     if (d > longestLength) {
        //         longestLength = d;
        //         longestIndex = i;
        //     }
        // }

        // const insertBackwards = seaPolygon[longestIndex].distanceToSquared(polyline[0]) > seaPolygon[longestIndex].distanceToSquared(polyline[polyline.length - 1]);
        // if (insertBackwards) {
        //     polyline.reverse();
        // }

        // seaPolygon.splice((longestIndex + 1) % seaPolygon.length, 0, ...polyline);
        
        return PolygonUtil.lineRectanglePolygonIntersection(this.origin, this.worldDimensions, polyline);

        // return PolygonUtil.boundPolyToScreen(this.origin, this.worldDimensions, seaPolygon);
    }

    /**
     * Mutates streamline
     */
    private extendStreamline(streamline: Vector[]): Vector[] {
            streamline.unshift(streamline[0].clone().add(
                streamline[0].clone().sub(streamline[1]).setLength(this.params.dstep * 5)));
            streamline.push(streamline[streamline.length - 1].clone().add(
                streamline[streamline.length - 1].clone().sub(streamline[streamline.length - 2]).setLength(this.params.dstep * 5)));
            return streamline;
        }

    private reachesEdges(streamline: Vector[]): boolean {
        return this.vectorOffScreen(streamline[0]) && this.vectorOffScreen(streamline[streamline.length - 1]);
    }

    private vectorOffScreen(v: Vector): boolean {
        const toOrigin = v.clone().sub(this.origin);
        return toOrigin.x <= 0 || toOrigin.y <= 0 ||
            toOrigin.x >= this.worldDimensions.x || toOrigin.y >= this.worldDimensions.y;
    }
}
