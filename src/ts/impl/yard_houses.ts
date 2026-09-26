import Vector from '../vector';
import PolygonUtil from './polygon_util';
import LocalFrame from './local_frame';
import * as simplify from 'simplify-js';

export interface YardHouses {
    houses: Vector[][];  // World space
    fences: Vector[][];  // Closed polylines around each lot
}

export interface YardStyle {
    crookedness: number;  // Maximum rotation of a house within its lot, radians
    wander: number;  // 0-1, how far houses stray from where they should be
    vacantChance: number;
    shedChance: number;
    fences: boolean;
    frontage: number;  // Typical lot width along the street, world units (1 unit = 2 m)
    maxDepth: number;  // Deepest a lot gets before the block is split into two rows
}

/**
 * Detached houses, each in its own yard
 */
export default class YardHouseLayout {
    // Neat houses square to the street
    static readonly TIDY: YardStyle = {
        crookedness: 0.03,
        wander: 0.3,
        vacantChance: 0.01,
        shedChance: 0.5,
        fences: false,
        frontage: 7,  // 14 m, measured lots are 8-15 m wide
        maxDepth: 25,
    };

    // Houses sitting a little crookedly behind chain link fences, some lots empty
    static readonly RUN_DOWN: YardStyle = {
        crookedness: 0.25,
        wander: 0.6,
        vacantChance: 0.18,
        shedChance: 0.3,
        fences: true,
        frontage: 7.5,
        maxDepth: 25,
    };

    /**
     * Lines each side of every block with lots facing the street, like a real street grid,
     * with back yards meeting in the middle, and puts a house near the front of each lot
     */
    static layoutBlocks(blocks: Vector[][], style: YardStyle): YardHouses {
        const out: YardHouses = {houses: [], fences: []};
        for (const raw of blocks) {
            if (raw.length < 3) continue;
            // Straighten out small wiggles so curved blocks still get long edges
            let block: Vector[] = simplify(raw.map(v => ({x: v.x, y: v.y})), 1.5, true).map((p: {x: number; y: number}) => new Vector(p.x, p.y));
            if (block.length > 3 && block[0].equals(block[block.length - 1])) block.pop();
            if (block.length < 3) block = raw;
            const clockwise = PolygonUtil.signedArea(block) < 0;

            // Longest edges first, they get the full depth and the corners
            const edges: number[] = block.map((_, i) => i);
            edges.sort((i, j) => block[(j + 1) % block.length].distanceTo(block[j]) - block[(i + 1) % block.length].distanceTo(block[i]));

            const lots: Vector[][] = [];
            for (const i of edges) {
                const a = block[i];
                const b = block[(i + 1) % block.length];
                const length = a.distanceTo(b);
                if (length < 0.8 * style.frontage) continue;
                const t = b.clone().sub(a).divideScalar(length);
                const n = clockwise ? new Vector(t.y, -t.x) : new Vector(-t.y, t.x);  // Inwards
                const frame = new LocalFrame(a, t, n);

                const across = YardHouseLayout.distanceAcross(block, frame.toWorld(length / 2, 0.1), n);
                const depth = Math.min(style.maxDepth, across / 2);
                if (depth < 5) continue;

                // Lots of slightly varied width filling the edge exactly
                const widths: number[] = [];
                let total = 0;
                while (total < length - 0.5 * style.frontage) {
                    const w = style.frontage * (0.8 + 0.5 * Math.random());
                    widths.push(w);
                    total += w;
                }
                const scale = length / Math.max(total, 1e-6);
                let u = 0;
                for (const w0 of widths) {
                    const w = w0 * scale;
                    const front = frame.toWorld(u + w / 2, 2);
                    // Corners are already taken by the lots of a longer edge
                    if (!lots.some(l => PolygonUtil.insidePolygon(front, l))) {
                        const lot = YardHouseLayout.addLot(out, block, frame, u, u + w, depth, style, lots);
                        if (lot !== null) lots.push(lot);
                    }
                    u += w;
                }
            }
        }
        return out;
    }

    /**
     * Distance from point, travelling in direction dir, to the far side of polygon
     */
    private static distanceAcross(polygon: Vector[], point: Vector, dir: Vector): number {
        const far = point.clone().add(dir.clone().multiplyScalar(1e4));
        let best = Infinity;
        for (let i = 0; i < polygon.length; i++) {
            const hit = PolygonUtil.segmentIntersection(point, far, polygon[i], polygon[(i + 1) % polygon.length]);
            if (hit !== null && hit.t * 1e4 > 0.5) best = Math.min(best, hit.t * 1e4);
        }
        return best === Infinity ? 0 : best;
    }

    /**
     * Returns the lot polygon, or null if the lot didn't fit
     */
    private static addLot(out: YardHouses, block: Vector[], frame: LocalFrame,
                          u0: number, u1: number, D: number, style: YardStyle, existing: Vector[][]): Vector[] {
        const W = u1 - u0;
        if (W < 3) return null;
        let lot = PolygonUtil.intersectPolygons(frame.rect(u0, u1, 0, D), block);
        if (lot.length < 3) return null;
        // Lots never overlap: cut away any part already taken by a neighbouring lot
        const box = PolygonUtil.boundingBox(lot);
        const neighbours = existing.filter(l => PolygonUtil.boundingBoxesOverlap(box, PolygonUtil.boundingBox(l)));
        if (neighbours.length > 0) {
            const pieces = PolygonUtil.subtractPolygons(lot, neighbours, 0.3 * W * D);
            if (pieces.length === 0) return null;
            lot = pieces.reduce((a, b) => PolygonUtil.calcPolygonArea(a) >= PolygonUtil.calcPolygonArea(b) ? a : b);
        }
        if (PolygonUtil.calcPolygonArea(lot) < 0.5 * W * D) return null;
        YardHouseLayout.addRowLot(out, lot, frame, u0, u1, 0, D, true, style);
        return lot;
    }

    private static addRowLot(out: YardHouses, lot: Vector[], frame: LocalFrame,
                             u0: number, u1: number, v0: number, v1: number,
                             frontLow: boolean, style: YardStyle): void {
        const W = u1 - u0;
        const D = v1 - v0;
        if (W < 3 || D < 5) return;
        if (style.fences) {
            const fence = lot.slice();
            fence.push(lot[0]);
            out.fences.push(fence);
        }
        if (Math.random() < style.vacantChance) return;

        // Lot coordinates: a along the street, d back from the street
        const angle = (Math.random() - 0.5) * 2 * style.crookedness;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const toWorld = (a: number, d: number): Vector => frame.toWorld(u0 + a, frontLow ? v0 + d : v1 - d);
        const rect = (a0: number, a1: number, d0: number, d1: number): Vector[] => {
            // Rotate slightly about the rectangle's centre
            const ca = (a0 + a1) / 2, cd = (d0 + d1) / 2;
            return [[a0, d0], [a1, d0], [a1, d1], [a0, d1]].map(([a, d]) =>
                toWorld(ca + (a - ca) * cos - (d - cd) * sin, cd + (a - ca) * sin + (d - cd) * cos));
        };
        const inside = (polygon: Vector[]): boolean => polygon.every(p => PolygonUtil.insidePolygon(p, lot));

        const houseWidth = W * (0.55 + 0.2 * Math.random());
        // Houses on narrow lots are deep rather than wide, as in the measured neighbourhoods
        const houseDepth = Math.min(D * 0.6, houseWidth * (1.3 + 0.7 * Math.random()));
        const setback = Math.min(D * 0.25, 2.5 + 2 * Math.random() + style.wander * 3 * Math.random());
        const offset = (W - houseWidth) / 2 + (Math.random() - 0.5) * (W - houseWidth) * style.wander;

        for (let attempt = 0; attempt < 3; attempt++) {
            const scale = 1 - 0.15 * attempt;
            const a0 = offset + houseWidth * (1 - scale) / 2;
            const house = rect(a0, a0 + houseWidth * scale, setback, setback + houseDepth * scale);
            if (!inside(house)) continue;
            out.houses.push(house);

            if (Math.random() < style.shedChance) {
                // Garage or shed at the back of the lot
                const s = Math.min(W * 0.45, 3 + Math.random() * 1.5);
                const onLeft = Math.random() < 0.5;
                const sa0 = onLeft ? 1 : W - 1 - s;
                const shed = rect(sa0, sa0 + s, D - 1.5 - s, D - 1.5);
                if (inside(shed)) out.houses.push(shed);
            }
            return;
        }
    }

    static layout(lots: Vector[][], style: YardStyle): YardHouses {
        const out: YardHouses = {houses: [], fences: []};
        for (const lot of lots) {
            if (lot.length < 3) continue;
            if (style.fences) {
                const fence = lot.slice();
                fence.push(lot[0]);
                out.fences.push(fence);
            }
            if (Math.random() < style.vacantChance) continue;
            out.houses.push(...YardHouseLayout.housesFor(lot, style));
        }
        return out;
    }

    private static housesFor(lot: Vector[], style: YardStyle): Vector[][] {
        const bounds = LocalFrame.orientedBounds(lot);
        if (bounds === null) return [];
        const {umin, umax, vmin, vmax} = bounds;
        const W = umax - umin;
        const D = vmax - vmin;
        if (W < 4 || D < 4) return [];

        const inside = (polygon: Vector[]): boolean => polygon.every(p => PolygonUtil.insidePolygon(p, lot));

        const angle = (Math.random() - 0.5) * 2 * style.crookedness;
        const t = bounds.frame.t;
        const rt = new Vector(t.x * Math.cos(angle) - t.y * Math.sin(angle), t.x * Math.sin(angle) + t.y * Math.cos(angle));
        const centre = bounds.frame.toWorld((umin + umax) / 2, (vmin + vmax) / 2);

        // Houses take up roughly a quarter of the lot
        const w = W * (0.45 + 0.2 * Math.random());
        const d = D * (0.4 + 0.2 * Math.random());
        const cu = (Math.random() - 0.5) * (W - w) * style.wander;
        const cv = (Math.random() - 0.5) * (D - d) * style.wander;

        for (let attempt = 0; attempt < 4; attempt++) {
            const scale = 1 - 0.15 * attempt;
            const frame = new LocalFrame(centre, rt, new Vector(-rt.y, rt.x));
            const hw = w * scale / 2;
            const hd = d * scale / 2;
            const house = frame.rect(cu * scale - hw, cu * scale + hw, cv * scale - hd, cv * scale + hd);
            if (!inside(house)) continue;

            const out = [house];
            if (Math.random() < style.shedChance) {
                // Shed or garage in a corner away from the house
                const s = Math.min(W, D) * 0.14 + 1;
                const su = Math.sign(-cu || 1) * (W / 2 - s - 1.5);
                const sv = Math.sign(-cv || 1) * (D / 2 - s - 1.5);
                const shed = frame.rect(su - s / 2, su + s / 2, sv - s / 2, sv + s / 2);
                if (inside(shed) && !PolygonUtil.insidePolygon(PolygonUtil.averagePoint(shed), house)) out.push(shed);
            }
            return out;
        }
        return [];
    }
}
