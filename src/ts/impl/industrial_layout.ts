import Vector from '../vector';
import PolygonUtil from './polygon_util';
import LocalFrame from './local_frame';

export interface IndustrialParams {
    setback: number;  // Fence line distance from the road centre
    parcelWidth: number;  // Frontage of each parcel
    parcelDepth: number;
}

export interface IndustrialBlockLayout {
    yards: Vector[][];  // Fenced parcels, world space
    buildings: Vector[][];
    roads: Vector[][];  // Service roads through the block
}

/**
 * Lays out an industrial block as a regular grid of fenced parcels
 *
 * The block is aligned to its longest side, then split into strips separated by service roads so
 * that every parcel fronts a road. Each strip holds one or two rows of equal parcels, each with a
 * single building set back behind a yard where lorries can turn.
 */
export default class IndustrialLayout {
    private static readonly FENCE_GAP = 1.5;  // Half the gap between neighbouring parcels
    private static readonly MIN_PARCEL_FILL = 0.75;  // Parcels cut down more than this by the block edge are left empty

    static layoutBlock(block: Vector[], params: IndustrialParams, tankFarm: boolean): IndustrialBlockLayout {
        const out: IndustrialBlockLayout = {yards: [], buildings: [], roads: []};

        const inset = PolygonUtil.resizeGeometry(block, -params.setback);
        if (inset.length > 3 && inset[0].equals(inset[inset.length - 1])) inset.pop();
        if (inset.length < 3) return out;

        const bounds = LocalFrame.orientedBounds(inset);
        if (bounds === null) return out;
        const {frame, umin, umax, vmin, vmax} = bounds;

        // Strips of parcels, separated by service roads
        const roadGap = 2 * params.setback;
        const width = vmax - vmin;
        const numStrips = Math.max(1, Math.round((width + roadGap) / (2 * params.parcelDepth + roadGap)));
        const stripWidth = (width - roadGap * (numStrips - 1)) / numStrips;
        if (stripWidth < 0.5 * params.parcelDepth) return out;

        for (let i = 0; i < numStrips - 1; i++) {
            const v = vmin + (i + 1) * stripWidth + i * roadGap + roadGap / 2;
            const road = PolygonUtil.clipLineToPolygon(frame.line(umin - 4 * params.setback, v, umax + 4 * params.setback, v), block);
            if (road.length >= 2) out.roads.push(road);
        }

        // Equal parcels along the strip
        const numParcels = Math.max(1, Math.round((umax - umin) / params.parcelWidth));
        const parcelWidth = (umax - umin) / numParcels;
        const rows = stripWidth >= 1.4 * params.parcelDepth ? 2 : 1;
        const rowDepth = stripWidth / rows;

        for (let i = 0; i < numStrips; i++) {
            const stripStart = vmin + i * (stripWidth + roadGap);
            for (let r = 0; r < rows; r++) {
                const v0 = stripStart + r * rowDepth;
                // The first row faces the road before the strip, the second the road after it
                const frontLow = r === 0;
                for (let j = 0; j < numParcels; j++) {
                    const u0 = umin + j * parcelWidth;
                    IndustrialLayout.addParcel(out, frame, inset, u0, u0 + parcelWidth, v0, v0 + rowDepth, frontLow, tankFarm);
                }
            }
        }
        return out;
    }

    private static addParcel(out: IndustrialBlockLayout, frame: LocalFrame, inset: Vector[],
                             u0: number, u1: number, v0: number, v1: number,
                             frontLow: boolean, tankFarm: boolean): void {
        const gap = IndustrialLayout.FENCE_GAP;
        u0 += gap; u1 -= gap; v0 += gap; v1 -= gap;
        if (u1 - u0 < 10 || v1 - v0 < 10) return;

        const rect = frame.rect(u0, u1, v0, v1);
        const yard = PolygonUtil.intersectPolygons(rect, inset);
        if (yard.length < 3) return;
        if (PolygonUtil.calcPolygonArea(yard) < IndustrialLayout.MIN_PARCEL_FILL * (u1 - u0) * (v1 - v0)) return;
        out.yards.push(yard);

        // Lorry yard at the front, gaps down the sides and at the back
        const sideGap = Math.max(4, 0.12 * (u1 - u0));
        const frontYard = 0.35 * (v1 - v0);
        const backGap = 4;
        const bu0 = u0 + sideGap;
        const bu1 = u1 - sideGap;
        const bv0 = frontLow ? v0 + frontYard : v0 + backGap;
        const bv1 = frontLow ? v1 - backGap : v1 - frontYard;
        if (bu1 - bu0 < 6 || bv1 - bv0 < 6) return;

        const inside = (polygon: Vector[]): boolean => polygon.every(p => PolygonUtil.insidePolygon(p, yard));

        if (tankFarm) {
            // Four equal tanks
            const radius = Math.min(bu1 - bu0, bv1 - bv0) / 6;
            const tanks: Vector[][] = [];
            for (const fu of [0.25, 0.75]) {
                for (const fv of [0.25, 0.75]) {
                    const centre = frame.toWorld(bu0 + fu * (bu1 - bu0), bv0 + fv * (bv1 - bv0));
                    tanks.push(PolygonUtil.circle(centre, radius, 16));
                }
            }
            if (tanks.every(inside)) out.buildings.push(...tanks);
            return;
        }

        const building = frame.rect(bu0, bu1, bv0, bv1);
        if (inside(building)) out.buildings.push(building);
    }
}
