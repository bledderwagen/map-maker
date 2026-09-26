import Vector from '../vector';
import PolygonUtil from './polygon_util';
import LocalFrame from './local_frame';

export interface IndustrialParams {
    setback: number;  // Distance from the road centre to the front of a parcel
    parcelWidth: number;  // Typical frontage of a parcel
    parcelDepth: number;
}

export interface IndustrialBlockLayout {
    buildings: Vector[][];  // World space
    roads: Vector[][];  // Service roads through the block
}

/**
 * Lays out an industrial block as a grid of parcels along service roads
 *
 * The block is aligned to its longest side. Blocks deep enough for more than one row of parcels
 * get service roads along their length, and very long blocks a cross street, so every parcel
 * fronts a road. Parcels share a common depth but vary in width, and hold sheds of a few
 * different shapes, always set behind a yard at the front where lorries can turn.
 */
export default class IndustrialLayout {
    private static readonly GAP = 1.5;  // Half the gap between neighbouring parcels
    private static readonly FIT_ATTEMPTS = 5;  // Buildings that cross the block edge are shrunk this many times

    static layoutBlock(block: Vector[], params: IndustrialParams, tankFarmChance: number): IndustrialBlockLayout {
        const out: IndustrialBlockLayout = {buildings: [], roads: []};

        const inset = PolygonUtil.resizeGeometry(block, -params.setback);
        if (inset.length > 3 && inset[0].equals(inset[inset.length - 1])) inset.pop();
        if (inset.length < 3) return out;

        const bounds = LocalFrame.orientedBounds(inset);
        if (bounds === null) return out;
        const {frame, umin, umax, vmin, vmax} = bounds;
        const roadGap = 2 * params.setback;
        const extend = 4 * params.setback;  // Roads run past the inset edge to reach the block's road

        // Strips of parcels running along the block, separated by service roads
        const width = vmax - vmin;
        let numStrips = Math.max(1, Math.round((width + roadGap) / (2 * params.parcelDepth + roadGap)));
        if (numStrips === 1 && width > 1.6 * params.parcelDepth + roadGap) numStrips = 2;
        const stripWidth = (width - roadGap * (numStrips - 1)) / numStrips;
        if (stripWidth < 0.5 * params.parcelDepth) return out;

        for (let i = 0; i < numStrips - 1; i++) {
            const v = vmin + (i + 1) * stripWidth + i * roadGap + roadGap / 2;
            let u0 = umin - extend;
            let u1 = umax + extend;
            // Often a dead end court off one side rather than a through road
            if (Math.random() < 0.5) {
                const reach = (umax - umin) * (0.6 + 0.2 * Math.random());
                if (Math.random() < 0.5) {
                    u1 = umin + reach;
                } else {
                    u0 = umax - reach;
                }
            }
            const road = PolygonUtil.clipLineToPolygon(frame.line(u0, v, u1, v), block);
            if (road.length >= 2) out.roads.push(road);
        }

        // Long blocks are split by a cross street
        const length = umax - umin;
        const sections: number[][] = [];
        if (numStrips > 1 && length > 7 * params.parcelWidth) {
            const u = umin + length * (0.4 + 0.2 * Math.random());
            const road = PolygonUtil.clipLineToPolygon(frame.line(u, vmin - extend, u, vmax + extend), block);
            if (road.length >= 2) {
                out.roads.push(road);
                sections.push([umin, u - roadGap / 2], [u + roadGap / 2, umax]);
            }
        }
        if (sections.length === 0) sections.push([umin, umax]);

        const rows = stripWidth >= 1.4 * params.parcelDepth ? 2 : 1;
        const rowDepth = stripWidth / rows;

        for (let i = 0; i < numStrips; i++) {
            const stripStart = vmin + i * (stripWidth + roadGap);
            for (let r = 0; r < rows; r++) {
                const v0 = stripStart + r * rowDepth;
                // Face the service road where there is one, else the block's own road
                let frontLow = r === 0;
                if (rows === 1 && numStrips > 1) frontLow = i > 0;
                for (const [s0, s1] of sections) {
                    for (const [u0, u1] of IndustrialLayout.parcelWidths(s0, s1, params.parcelWidth)) {
                        const tankFarm = Math.random() < tankFarmChance;
                        IndustrialLayout.addParcel(out, frame, inset, u0, u1, v0, v0 + rowDepth, frontLow, tankFarm);
                    }
                }
            }
        }
        return out;
    }

    /**
     * Mostly standard width parcels, with some narrower and wider ones, scaled to fill the row exactly
     */
    private static parcelWidths(u0: number, u1: number, base: number): number[][] {
        const choices = [0.6, 1, 1, 1, 1.4, 2, 2.8];
        const widths: number[] = [];
        let total = 0;
        while (total < u1 - u0 - 0.5 * base) {
            const w = base * choices[Math.floor(Math.random() * choices.length)];
            widths.push(w);
            total += w;
        }
        if (widths.length === 0) return [];
        const scale = (u1 - u0) / total;
        const out: number[][] = [];
        let u = u0;
        for (const w of widths) {
            out.push([u, u + w * scale]);
            u += w * scale;
        }
        return out;
    }

    private static addParcel(out: IndustrialBlockLayout, frame: LocalFrame, inset: Vector[],
                             u0: number, u1: number, v0: number, v1: number,
                             frontLow: boolean, tankFarm: boolean): void {
        const gap = IndustrialLayout.GAP;
        u0 += gap; u1 -= gap; v0 += gap; v1 -= gap;
        const W = u1 - u0;
        const D = v1 - v0;
        if (W < 12 || D < 12) return;

        // Parcel coordinates: a along the frontage, d back from the front
        const mirror = Math.random() < 0.5;
        const toWorld = (a: number, d: number): Vector => frame.toWorld(
            mirror ? u1 - a : u0 + a,
            frontLow ? v0 + d : v1 - d);
        const polygon = (points: number[][]): Vector[] => points.map(([a, d]) => toWorld(a, d));
        const rect = (a0: number, a1: number, d0: number, d1: number): Vector[] =>
            polygon([[a0, d0], [a1, d0], [a1, d1], [a0, d1]]);

        if (!PolygonUtil.insidePolygon(toWorld(W / 2, D / 2), inset)) return;

        // Lorry yard at the front, space at the sides and back
        const side = Math.max(2, W * (0.04 + 0.03 * Math.random()));
        const back = 1.5 + 1.5 * Math.random();
        const yard = Math.max(7, D * (0.15 + 0.08 * Math.random()));
        const inside = (b: Vector[]): boolean => b.every(p => PolygonUtil.insidePolygon(p, inset));
        const r = Math.random();
        const lengthwise = 0.75 + 0.2 * Math.random();
        // Parcels cut off by a slanted block edge get a smaller building, shrunk towards the front
        for (let attempt = 0; attempt < IndustrialLayout.FIT_ATTEMPTS; attempt++) {
            const scale = 1 - 0.15 * attempt;
            const a0 = side + (W - 2 * side) * (1 - scale) / 2;
            const a1 = W - a0;
            const d0 = yard;
            const d1 = d0 + (D - back - yard) * scale;
            if (a1 - a0 < 8 || d1 - d0 < 8) return;
            const buildings = IndustrialLayout.buildingsFor(r, lengthwise, tankFarm, a0, a1, d0, d1, toWorld, polygon, rect);
            if (buildings.every(inside)) {
                out.buildings.push(...buildings);
                return;
            }
        }
    }

    private static buildingsFor(r: number, lengthwise: number, tankFarm: boolean,
                                a0: number, a1: number, d0: number, d1: number,
                                toWorld: (a: number, d: number) => Vector,
                                polygon: (points: number[][]) => Vector[],
                                rect: (a0: number, a1: number, d0: number, d1: number) => Vector[]): Vector[][] {
        const buildings: Vector[][] = [];
        if (tankFarm) {
            const radius = Math.min(a1 - a0, d1 - d0) / 6;
            for (const fa of [0.25, 0.75]) {
                for (const fd of [0.3, 0.75]) {
                    buildings.push(PolygonUtil.circle(toWorld(a0 + fa * (a1 - a0), d0 + fd * (d1 - d0)), radius, 16));
                }
            }
        } else if (r < 0.3) {
            // L shaped: shed at the back with a wing reaching forward down one side
            const neck = d0 + 0.45 * (d1 - d0);
            const wing = a0 + (lengthwise - 0.45) * (a1 - a0);
            buildings.push(polygon([[a0, d0], [wing, d0], [wing, neck], [a1, neck], [a1, d1], [a0, d1]]));
        } else if (r < 0.5) {
            // Shed with a small office block at the front
            const officeDepth = Math.min(8, 0.25 * (d1 - d0));
            buildings.push(rect(a0, a1, d0 + officeDepth, d1));
            const officeWidth = 0.3 * (a1 - a0);
            buildings.push(rect(a0, a0 + officeWidth, d0, d0 + officeDepth - 1));
        } else if (r < 0.65 && a1 - a0 > 35) {
            // Two sheds side by side with a lane between
            const middle = (a0 + a1) / 2;
            buildings.push(rect(a0, middle - 3, d0, d1));
            buildings.push(rect(middle + 3, a1, d0 + 0.2 * (d1 - d0), d1));
        } else {
            // Plain shed, not always the full width
            const narrow = lengthwise < 0.85 ? 0.2 * (a1 - a0) : 0;
            buildings.push(rect(a0, a1 - narrow, d0, d1));
        }
        return buildings;
    }
}
