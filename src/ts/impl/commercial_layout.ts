import Vector from '../vector';
import PolygonUtil from './polygon_util';
import LocalFrame from './local_frame';

export type SiteBuildingKind = 'mall' | 'retail' | 'apartments';

export interface SiteLayout {
    kind: 'mall' | 'strip_mall' | 'car_park' | 'apartments';
    buildings: {polygon: Vector[]; kind: SiteBuildingKind}[];  // World space
    parking: Vector[][];  // Car park surfaces
    aisles: Vector[][];  // Drives and parking aisles
    pools: Vector[][];
    centre: Vector;  // Where the name goes
}

/**
 * Shopping malls and garden apartment complexes, the two kinds of site that take a whole block
 * and are laid out as one development rather than lot by lot. Units are world units (2 m)
 */
export default class CommercialLayout {
    private static empty(block: Vector[], kind: SiteLayout['kind']): SiteLayout {
        return {kind, buildings: [], parking: [], aisles: [], pools: [], centre: PolygonUtil.averagePoint(block)};
    }

    private static inset(block: Vector[], by: number): Vector[] {
        const inset = PolygonUtil.resizeGeometry(block, -by);
        if (inset.length > 3 && inset[0].equals(inset[inset.length - 1])) inset.pop();
        return inset;
    }

    private static inside(polygon: Vector[], area: Vector[]): boolean {
        return polygon.every(p => PolygonUtil.insidePolygon(p, area));
    }

    /**
     * Parallel aisles across a car park, broken where they would run through a building
     * @param obstacles rectangles in the frame's coordinates, [u0, u1, v0, v1]
     */
    private static aisles(frame: LocalFrame, area: Vector[], umin: number, umax: number, v0: number, v1: number,
                          spacing: number, obstacles: number[][]): Vector[][] {
        const out: Vector[][] = [];
        for (let v = v0; v <= v1; v += spacing) {
            const clipped = PolygonUtil.clipLineToPolygon(frame.line(umin - 20, v, umax + 20, v), area);
            if (clipped.length < 2) continue;
            const us = clipped.map(p => frame.toLocal(p).u);
            let pieces = [[Math.min(...us), Math.max(...us)]];
            for (const o of obstacles) {
                if (v < o[2] - 3 || v > o[3] + 3) continue;
                const next: number[][] = [];
                for (const [a, b] of pieces) {
                    if (o[1] + 3 <= a || o[0] - 3 >= b) {
                        next.push([a, b]);
                        continue;
                    }
                    if (o[0] - 3 > a) next.push([a, o[0] - 3]);
                    if (o[1] + 3 < b) next.push([o[1] + 3, b]);
                }
                pieces = next;
            }
            for (const [a, b] of pieces) if (b - a > 8) out.push(frame.line(a, v, b, v));
        }
        return out;
    }

    /**
     * A regional mall: a covered concourse between anchor department stores, in a sea of parking
     * with a ring road and a few restaurants on pads by the street.
     * Blocks too small for that get a strip mall along the back with parking in front
     */
    static mall(block: Vector[]): SiteLayout {
        const out = CommercialLayout.empty(block, 'car_park');
        const inset = CommercialLayout.inset(block, 5);
        if (inset.length < 3) return out;
        // Whatever doesn't fit a building is still a car park
        const carPark = (): SiteLayout => {
            out.parking.push(inset);
            return out;
        };
        const bounds = LocalFrame.orientedBounds(inset);
        if (bounds === null) return carPark();
        const {frame, umin, umax, vmin, vmax} = bounds;
        const L = umax - umin;
        const D = vmax - vmin;
        if (L < 40 || D < 25) return carPark();

        const rects: {r: number[]; kind: SiteBuildingKind}[] = [];
        const big = L >= 130 && D >= 90;
        if (big) {
            for (let scale = 1; scale > 0.4 && rects.length === 0; scale *= 0.85) {
                const uc = (umin + umax) / 2 + (Math.random() - 0.5) * 0.1 * L;
                const vc = vmin + 0.58 * D;
                const cl = Math.min(160, Math.max(60, 0.5 * L)) * scale;
                const cd = Math.min(34, Math.max(16, 0.2 * D)) * scale;
                const aw = Math.min(45, Math.max(22, 0.14 * L)) * scale;
                const ad = 2 * cd;
                const candidate: {r: number[]; kind: SiteBuildingKind}[] = [
                    {r: [uc - cl / 2, uc + cl / 2, vc - cd / 2, vc + cd / 2], kind: 'mall'},
                    {r: [uc - cl / 2 - aw, uc - cl / 2, vc - ad / 2, vc + ad / 2], kind: 'mall'},
                    {r: [uc + cl / 2, uc + cl / 2 + aw, vc - ad / 2, vc + ad / 2], kind: 'mall'},
                ];
                // A third anchor halfway along, facing the main car park
                if (Math.random() < 0.7) candidate.push({r: [uc - aw / 2, uc + aw / 2, vc - cd / 2 - 0.8 * ad, vc - cd / 2], kind: 'mall'});
                // Food court wing at the back
                if (Math.random() < 0.6) candidate.push({r: [uc + 0.15 * cl, uc + 0.15 * cl + 0.6 * aw, vc + cd / 2, vc + cd / 2 + 0.5 * ad], kind: 'mall'});
                if (candidate.every(c => CommercialLayout.inside(frame.rect(c.r[0] - 8, c.r[1] + 8, c.r[2] - 8, c.r[3] + 8), inset))) {
                    rects.push(...candidate);
                }
            }
        }
        if (rects.length === 0) {
            // Strip mall: a row of shops along the back with parking in front. On a big site it's a
            // power centre, a row of big box stores of different depths
            const back = vmax - 3;
            const deepest = Math.min(L > 150 ? 38 : 24, 0.4 * D);
            const u0 = umin + 0.1 * L;
            const u1 = umax - 0.1 * L;
            const stores = Math.max(2, Math.min(6, Math.round((u1 - u0) / 45)));
            let u = u0;
            for (let i = 0; i < stores; i++) {
                const w = (u1 - u0) / stores;
                const depth = deepest * (0.65 + 0.35 * Math.random());
                rects.push({r: [u, u + w, back - depth, back], kind: 'retail'});
                u += w;
            }
            // Shrink towards the middle until the row fits the site
            for (let attempt = 0; attempt < 6 && !rects.every(c => CommercialLayout.inside(frame.rect(c.r[0], c.r[1], c.r[2], c.r[3]), inset)); attempt++) {
                const mid = (u0 + u1) / 2;
                for (const c of rects) {
                    c.r[0] = mid + (c.r[0] - mid) * 0.85;
                    c.r[1] = mid + (c.r[1] - mid) * 0.85;
                    c.r[2] = back - (back - c.r[2]) * 0.9;
                }
            }
            if (!rects.every(c => CommercialLayout.inside(frame.rect(c.r[0], c.r[1], c.r[2], c.r[3]), inset))) return carPark();
        }
        out.kind = rects.some(c => c.kind === 'mall') ? 'mall' : 'strip_mall';

        // Footprint of the whole mall, for the ring road and keeping clear of it
        const fu0 = Math.min(...rects.map(c => c.r[0]));
        const fu1 = Math.max(...rects.map(c => c.r[1]));
        const fv0 = Math.min(...rects.map(c => c.r[2]));
        const fv1 = Math.max(...rects.map(c => c.r[3]));
        const obstacles = rects.map(c => c.r);

        // Restaurants and banks on pads along the front
        if (big) {
            const pads = 3 + Math.floor(Math.random() * 4);
            for (let i = 0; i < pads; i++) {
                const w = 10 + Math.random() * 5;
                const d = 8 + Math.random() * 3;
                const u = umin + 12 + (i + 0.5) * (L - 24) / pads + (Math.random() - 0.5) * 10;
                const pad = [u - w / 2, u + w / 2, vmin + 5, vmin + 5 + d];
                if (pad[3] > fv0 - 15) continue;
                if (!CommercialLayout.inside(frame.rect(pad[0] - 3, pad[1] + 3, pad[2] - 3, pad[3] + 3), inset)) continue;
                rects.push({r: pad, kind: 'retail'});
                obstacles.push([pad[0] - 3, pad[1] + 3, pad[2] - 3, pad[3] + 3]);
            }
        }

        for (const c of rects) out.buildings.push({polygon: frame.rect(c.r[0], c.r[1], c.r[2], c.r[3]), kind: c.kind});
        out.parking.push(inset);
        out.aisles.push(...CommercialLayout.aisles(frame, inset, umin, umax, vmin + 4, vmax - 3, 9, obstacles));
        if (big) {
            const ring = frame.rect(fu0 - 6, fu1 + 6, fv0 - 6, fv1 + 6);
            if (CommercialLayout.inside(ring, inset)) out.aisles.push(ring.concat([ring[0]]));
        }
        // Drive round the edge of the car park
        const edge = CommercialLayout.inset(block, 8);
        if (edge.length >= 3) out.aisles.push(edge.concat([edge[0]]));
        out.centre = frame.toWorld((fu0 + fu1) / 2, (fv0 + fv1) / 2);
        return out;
    }

    /**
     * Garden apartments: rows of three storey blocks, car parks between some rows and
     * courtyards with a pool between the others
     */
    static apartments(block: Vector[]): SiteLayout {
        const out = CommercialLayout.empty(block, 'apartments');
        const inset = CommercialLayout.inset(block, 5);
        if (inset.length < 3) return out;
        const bounds = LocalFrame.orientedBounds(inset);
        if (bounds === null) return out;
        const {frame, umin, umax, vmin, vmax} = bounds;
        if (umax - umin < 35 || vmax - vmin < 12) return out;

        const DEPTH = 8;  // 16 m deep buildings
        let v = vmin + 1.5;
        let parkingNext = Math.random() < 0.5;
        while (v + DEPTH <= vmax - 1) {
            // A row of buildings
            const length = 22 + Math.random() * 10;
            const gap = 5 + Math.random() * 3;
            let u = umin + 2 + Math.random() * 4;
            while (u + 12 <= umax - 2) {
                const u1 = Math.min(u + length, umax - 2);
                const r = frame.rect(u, u1, v, v + DEPTH);
                if (u1 - u >= 12 && CommercialLayout.inside(r, inset)) out.buildings.push({polygon: r, kind: 'apartments'});
                u = u1 + gap;
            }
            v += DEPTH;

            // Then a car park or a courtyard
            const space = parkingNext ? 15 : 12;
            if (v + space + DEPTH > vmax - 1) break;
            const s0 = v + 2;
            const s1 = v + space - 2;
            if (parkingNext) {
                let lot: Vector[] = null;
                for (let shrink = 0; shrink < 8 && lot === null; shrink++) {
                    const r = frame.rect(umin + 2 + shrink * 4, umax - 2 - shrink * 4, s0, s1);
                    if (CommercialLayout.inside(r, inset)) lot = r;
                }
                if (lot !== null) {
                    out.parking.push(lot);
                    const a = frame.toLocal(lot[0]).u;
                    const b = frame.toLocal(lot[1]).u;
                    out.aisles.push(frame.line(a, (s0 + s1) / 2, b, (s0 + s1) / 2));
                }
            } else if (Math.random() < 0.6) {
                const uc = umin + (umax - umin) * (0.3 + 0.4 * Math.random());
                const pool = frame.rect(uc - 4, uc + 4, (s0 + s1) / 2 - 2, (s0 + s1) / 2 + 2);
                if (CommercialLayout.inside(pool, inset)) out.pools.push(pool);
            }
            parkingNext = !parkingNext;
            v += space;
        }
        return out;
    }
}
