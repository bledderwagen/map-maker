import Vector from '../vector';
import PolygonUtil from './polygon_util';

export interface RailwayContext {
    origin: Vector;
    size: Vector;  // World area to cover
    onLand: (p: Vector) => boolean;
    industrial: (p: Vector) => boolean;
    highways: Vector[][];
    parks: Vector[][];
}

/**
 * A freight railway across the city. Railways are older than the street grid around them,
 * so they cut across it in long straights and gentle curves, and run through industry
 */
export default class Railway {
    private static readonly STEP = 10;
    private static readonly MAX_TURN = 0.012;  // Radians per step, a curve radius of about 1.6 km

    /**
     * Line from p heading in dir, bending slowly, until it leaves the area
     */
    private static trace(p: Vector, dir: number, bend: number, ctx: RailwayContext): Vector[] {
        const out: Vector[] = [p.clone()];
        let heading = dir;
        let turn = 0;
        const pos = p.clone();
        const min = ctx.origin;
        const max = ctx.origin.clone().add(ctx.size);
        for (let i = 0; i < 2000; i++) {
            // Long straights joined by gentle curves
            if (i % 60 === 0) turn = Math.random() < 0.5 ? 0 : bend * (Math.random() - 0.5) * 2;
            heading += Math.max(-Railway.MAX_TURN, Math.min(Railway.MAX_TURN, turn));
            pos.add(new Vector(Math.cos(heading), Math.sin(heading)).multiplyScalar(Railway.STEP));
            out.push(pos.clone());
            if (pos.x < min.x || pos.y < min.y || pos.x > max.x || pos.y > max.y) break;
        }
        return out;
    }

    /**
     * Longest stretch on land, railways stop at the shore
     */
    private static onLand(line: Vector[], ctx: RailwayContext): Vector[] {
        let best: Vector[] = [];
        let current: Vector[] = [];
        for (const p of line) {
            if (ctx.onLand(p)) {
                current.push(p);
            } else {
                if (current.length > best.length) best = current;
                current = [];
            }
        }
        return current.length > best.length ? current : best;
    }

    private static score(line: Vector[], ctx: RailwayContext): number {
        if (line.length < 2) return -Infinity;
        let score = line.length * 0.2;  // Prefer lines that cross the whole map
        for (let i = 0; i < line.length; i += 2) {
            const p = line[i];
            if (ctx.industrial(p)) score += 2;
            if (ctx.parks.some(park => PolygonUtil.insidePolygon(p, park))) score -= 3;
            // Running alongside a highway looks like a mistake, crossing one is fine
            for (const h of ctx.highways) {
                for (let j = 0; j < h.length - 1; j++) {
                    if (PolygonUtil.distanceToSegment(p, h[j], h[j + 1]) < 40) {
                        score -= 4;
                        break;
                    }
                }
            }
        }
        return score;
    }

    static plan(ctx: RailwayContext): Vector[] {
        let best: Vector[] = [];
        let bestScore = -Infinity;
        for (let attempt = 0; attempt < 40; attempt++) {
            const anchor = new Vector(ctx.origin.x + (0.2 + 0.6 * Math.random()) * ctx.size.x,
                ctx.origin.y + (0.2 + 0.6 * Math.random()) * ctx.size.y);
            if (!ctx.onLand(anchor)) continue;
            const dir = Math.random() * Math.PI;
            const bend = 0.004 + 0.008 * Math.random();
            const forward = Railway.trace(anchor, dir, bend, ctx);
            const back = Railway.trace(anchor, dir + Math.PI, bend, ctx);
            const line = Railway.onLand(back.reverse().concat(forward.slice(1)), ctx);
            const s = Railway.score(line, ctx);
            if (s > bestScore) {
                bestScore = s;
                best = line;
            }
        }
        // Too short to be worth drawing
        if (best.length * Railway.STEP < 0.4 * Math.min(ctx.size.x, ctx.size.y)) return [];
        return best;
    }
}
