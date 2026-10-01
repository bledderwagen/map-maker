import Vector from '../vector';
import PolygonUtil from './polygon_util';

/**
 * Picks a sprinkling of places of worship and car parks. Chosen by a hash of the block index so
 * the map, redrawn every frame, and an export pick the same ones
 */
export default class PointsOfInterest {
    private static hash(i: number, salt: number): number {
        let h = Math.imul(i + 1, 2654435761) ^ Math.imul(salt, 40503);
        h = Math.imul(h ^ (h >>> 15), 2246822507);
        return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
    }

    /**
     * @param houses buildings a church can be chosen from
     * @param maxDistance furthest a church may be from the middle of its block, same units as the inputs
     * @return church buildings, and car park positions
     */
    static select(residentialBlocks: Vector[][], houses: Vector[][], industrialBlocks: Vector[][],
                  maxDistance: number): {churches: Vector[][]; parking: Vector[]} {
        const churches: Vector[][] = [];
        residentialBlocks.forEach((block, i) => {
            if (PointsOfInterest.hash(i, 1) > 0.045 || block.length < 3) return;
            const c = PolygonUtil.averagePoint(block);
            let best: Vector[] = null;
            let bestD = Infinity;
            for (const b of houses) {
                if (b.length === 0) continue;
                const d = b[0].distanceToSquared(c);
                if (d < bestD) {
                    bestD = d;
                    best = b;
                }
            }
            if (best !== null && bestD <= maxDistance * maxDistance) churches.push(best);
        });

        const parking: Vector[] = [];
        industrialBlocks.forEach((block, i) => {
            if (PointsOfInterest.hash(i, 2) > 0.45 || block.length < 3) return;
            const c = PolygonUtil.averagePoint(block);
            if (PolygonUtil.insidePolygon(c, block)) parking.push(c);
        });
        return {churches, parking};
    }
}
