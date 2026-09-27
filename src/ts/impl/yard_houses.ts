import Vector from '../vector';
import PolygonUtil from './polygon_util';
import LocalFrame from './local_frame';
import * as simplify from 'simplify-js';

export interface YardHouses {
    houses: Vector[][];  // World space
    fences: Vector[][];  // Closed polylines around each lot
    pools: Vector[][];
}

export interface YardStyle {
    crookedness: number;  // Maximum rotation of a house within its lot, radians
    wander: number;  // 0-1, how far houses stray from where they should be
    vacantChance: number;
    shedChance: number;
    fenceChance: number;  // Chance a block has chain link fences round its yards
    frontage: number;  // Typical lot width along the street, world units (1 unit = 2 m)
    maxDepth: number;  // Deepest a lot gets before the block is split into two rows
    houseWidth: number;  // Fraction of the lot width, give or take 0.1
    houseAspect: number;  // Depth over width, give or take a quarter
    setback: number;  // From the street
    wingChance: number;  // Chance of an L shaped house
    poolChance: number;
}

/**
 * Detached houses, each in its own yard
 */
export default class YardHouseLayout {
    // Houses sitting a little crookedly behind chain link fences, some lots empty
    static readonly RUN_DOWN: YardStyle = {
        crookedness: 0.25,
        wander: 0.6,
        vacantChance: 0.18,
        shedChance: 0.3,
        fenceChance: 1,
        frontage: 7.5,
        maxDepth: 25,
        houseWidth: 0.65,
        houseAspect: 1.65,
        setback: 3,
        wingChance: 0,
        poolChance: 0,
    };

    // Small, plain houses, kept up
    static readonly WORKING_CLASS: YardStyle = {
        crookedness: 0.1,
        wander: 0.4,
        vacantChance: 0.04,
        shedChance: 0.45,
        fenceChance: 0.4,
        frontage: 7,
        maxDepth: 24,
        houseWidth: 0.65,
        houseAspect: 1.65,
        setback: 3,
        wingChance: 0.05,
        poolChance: 0,
    };

    // Neat houses square to the street
    static readonly TIDY: YardStyle = {
        crookedness: 0.03,
        wander: 0.3,
        vacantChance: 0.01,
        shedChance: 0.5,
        fenceChance: 0,
        frontage: 7,  // 14 m, measured lots are 8-15 m wide
        maxDepth: 25,
        houseWidth: 0.65,
        houseAspect: 1.65,
        setback: 3.5,
        wingChance: 0.1,
        poolChance: 0.03,
    };

    // Wider lots, bigger houses further back, garages and a few pools
    static readonly COMFORTABLE: YardStyle = {
        crookedness: 0.02,
        wander: 0.3,
        vacantChance: 0.005,
        shedChance: 0.6,
        fenceChance: 0,
        frontage: 10,
        maxDepth: 30,
        houseWidth: 0.6,
        houseAspect: 1.3,
        setback: 5,
        wingChance: 0.3,
        poolChance: 0.2,
    };

    // Big houses well back from the street on deep lots, many with pools
    static readonly WEALTHY: YardStyle = {
        crookedness: 0.03,
        wander: 0.45,
        vacantChance: 0.01,
        shedChance: 0.45,
        fenceChance: 0,
        frontage: 15,  // 30 m
        maxDepth: 40,
        houseWidth: 0.52,
        houseAspect: 1.05,
        setback: 8,
        wingChance: 0.55,
        poolChance: 0.6,
    };

    /**
     * Housing along the income gradient, blended between the styles either side of income
     * @param income 0 poorest to 1 richest
     */
    static forIncome(income: number): YardStyle {
        const styles = [YardHouseLayout.RUN_DOWN, YardHouseLayout.WORKING_CLASS, YardHouseLayout.TIDY,
            YardHouseLayout.COMFORTABLE, YardHouseLayout.WEALTHY];
        // Styles sit in the middle of each income band
        const x = Math.max(0, Math.min(styles.length - 1, income * styles.length - 0.5));
        const i = Math.min(styles.length - 2, Math.floor(x));
        const t = x - i;
        const a = styles[i] as any;
        const b = styles[i + 1] as any;
        const out: any = {};
        for (const key of Object.keys(a)) out[key] = a[key] * (1 - t) + b[key] * t;
        return out as YardStyle;
    }

    /**
     * Lines each side of every block with lots facing the street, like a real street grid,
     * with back yards meeting in the middle, and puts a house near the front of each lot
     */
    static layoutBlocks(blocks: Vector[][], style: YardStyle, out: YardHouses = {houses: [], fences: [], pools: []}): YardHouses {
        for (const raw of blocks) {
            if (raw.length < 3) continue;
            const blockStyle = Object.assign({}, style, {fenceChance: Math.random() < style.fenceChance ? 1 : 0});
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
                if (length < 0.8 * blockStyle.frontage) continue;
                const t = b.clone().sub(a).divideScalar(length);
                const n = clockwise ? new Vector(t.y, -t.x) : new Vector(-t.y, t.x);  // Inwards
                const frame = new LocalFrame(a, t, n);

                const across = YardHouseLayout.distanceAcross(block, frame.toWorld(length / 2, 0.1), n);
                const depth = Math.min(blockStyle.maxDepth, across / 2);
                if (depth < 5) continue;

                // Lots of slightly varied width filling the edge exactly
                const widths: number[] = [];
                let total = 0;
                while (total < length - 0.5 * blockStyle.frontage) {
                    const w = blockStyle.frontage * (0.8 + 0.5 * Math.random());
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
                        const lot = YardHouseLayout.addLot(out, block, frame, u, u + w, depth, blockStyle, lots);
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
        if (style.fenceChance >= 1) {
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

        const houseWidth = W * (style.houseWidth - 0.1 + 0.2 * Math.random());
        // Houses on narrow lots are deep rather than wide, as in the measured neighbourhoods
        const houseDepth = Math.min(D * 0.6, houseWidth * style.houseAspect * (0.8 + 0.4 * Math.random()));
        const setback = Math.min(D * 0.25, style.setback * (0.7 + 0.6 * Math.random()) + style.wander * 3 * Math.random());
        const offset = (W - houseWidth) / 2 + (Math.random() - 0.5) * (W - houseWidth) * style.wander;

        for (let attempt = 0; attempt < 3; attempt++) {
            const scale = 1 - 0.15 * attempt;
            const a0 = offset + houseWidth * (1 - scale) / 2;
            const a1 = a0 + houseWidth * scale;
            const back = setback + houseDepth * scale;
            const house = rect(a0, a1, setback, back);
            if (!inside(house)) continue;
            out.houses.push(house);

            if (Math.random() < style.wingChance) {
                // A wing off the back half of one side, merged into an L shaped house later
                const onLeft = Math.random() < 0.5;
                const free = onLeft ? a0 : W - a1;
                const w = Math.min(houseWidth * scale * (0.35 + 0.2 * Math.random()), free - 1.2);
                if (w > 2) {
                    const d0 = setback + houseDepth * scale * (0.3 + 0.25 * Math.random());
                    const wing = onLeft ? rect(a0 - w, a0 + 0.3, d0, back) : rect(a1 - 0.3, a1 + w, d0, back);
                    if (inside(wing)) out.houses.push(wing);
                }
            }

            // The shed takes one back corner, a pool goes beside it if there is room
            let freeA0 = 1, freeA1 = W - 1;
            if (Math.random() < style.shedChance) {
                // Garage or shed at the back of the lot
                const s = Math.min(W * 0.45, 3 + Math.random() * 1.5);
                const onLeft = Math.random() < 0.5;
                const sa0 = onLeft ? 1 : W - 1 - s;
                const shed = rect(sa0, sa0 + s, D - 1.5 - s, D - 1.5);
                if (inside(shed)) {
                    out.houses.push(shed);
                    if (onLeft) freeA0 = sa0 + s + 1; else freeA1 = sa0 - 1;
                }
            }

            if (Math.random() < style.poolChance) {
                // Pools are about 4-6 x 8-11 m, set in the back yard
                const short = 2 + Math.random();
                const long = 4 + 1.5 * Math.random();
                const d0 = back + 1.5;
                const d1 = D - 1.5;
                const room = freeA1 - freeA0;
                let pool: Vector[] = null;
                if (room >= long && d1 - d0 >= short) {
                    const pa = freeA0 + (room - long) * Math.random();
                    const pd = d0 + (d1 - d0 - short) * (0.3 + 0.4 * Math.random());
                    pool = rect(pa, pa + long, pd, pd + short);
                } else if (room >= short && d1 - d0 >= long) {
                    const pa = freeA0 + (room - short) * Math.random();
                    const pd = d0 + (d1 - d0 - long) * 0.5;
                    pool = rect(pa, pa + short, pd, pd + long);
                }
                if (pool !== null && inside(pool)) out.pools.push(pool);
            }
            return;
        }
    }
}
