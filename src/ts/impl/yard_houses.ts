import Vector from '../vector';
import PolygonUtil from './polygon_util';
import LocalFrame from './local_frame';

export interface YardHouses {
    houses: Vector[][];  // World space
    fences: Vector[][];  // Closed polylines around each lot
}

/**
 * Small detached houses, each sitting a little crookedly in its own fenced yard
 * Houses vary in size and position, some have a shed out back and a few lots stand empty
 */
export default class YardHouseLayout {
    private static readonly VACANT_CHANCE = 0.08;
    private static readonly SHED_CHANCE = 0.3;

    static layout(lots: Vector[][]): YardHouses {
        const out: YardHouses = {houses: [], fences: []};
        for (const lot of lots) {
            if (lot.length < 3) continue;
            const fence = lot.slice();
            fence.push(lot[0]);
            out.fences.push(fence);
            if (Math.random() < YardHouseLayout.VACANT_CHANCE) continue;
            out.houses.push(...YardHouseLayout.housesFor(lot));
        }
        return out;
    }

    private static housesFor(lot: Vector[]): Vector[][] {
        const bounds = LocalFrame.orientedBounds(lot);
        if (bounds === null) return [];
        const {umin, umax, vmin, vmax} = bounds;
        const W = umax - umin;
        const D = vmax - vmin;
        if (W < 4 || D < 4) return [];

        const inside = (polygon: Vector[]): boolean => polygon.every(p => PolygonUtil.insidePolygon(p, lot));

        // Slightly crooked frame centred on the lot
        const angle = (Math.random() - 0.5) * 0.25;
        const t = bounds.frame.t;
        const rt = new Vector(t.x * Math.cos(angle) - t.y * Math.sin(angle), t.x * Math.sin(angle) + t.y * Math.cos(angle));
        const centre = bounds.frame.toWorld((umin + umax) / 2, (vmin + vmax) / 2);

        const w = W * (0.45 + 0.2 * Math.random());
        const d = D * (0.4 + 0.2 * Math.random());
        const cu = (Math.random() - 0.5) * (W - w) * 0.6;
        const cv = (Math.random() - 0.5) * (D - d) * 0.6;

        for (let attempt = 0; attempt < 4; attempt++) {
            const scale = 1 - 0.15 * attempt;
            const frame = new LocalFrame(centre, rt, new Vector(-rt.y, rt.x));
            const hw = w * scale / 2;
            const hd = d * scale / 2;
            const house = frame.rect(cu * scale - hw, cu * scale + hw, cv * scale - hd, cv * scale + hd);
            if (!inside(house)) continue;

            const out = [house];
            if (Math.random() < YardHouseLayout.SHED_CHANCE) {
                // Shed in a back corner
                const s = Math.min(W, D) * 0.12 + 1;
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
