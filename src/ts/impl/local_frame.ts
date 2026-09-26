import Vector from '../vector';

/**
 * A rotated coordinate system for laying out rectangles
 * u runs along t, v runs along n
 */
export default class LocalFrame {
    constructor(public origin: Vector, public t: Vector, public n: Vector) {}

    toWorld(u: number, v: number): Vector {
        return new Vector(
            this.origin.x + this.t.x * u + this.n.x * v,
            this.origin.y + this.t.y * u + this.n.y * v);
    }

    toLocal(p: Vector): {u: number; v: number} {
        const dx = p.x - this.origin.x;
        const dy = p.y - this.origin.y;
        return {u: dx * this.t.x + dy * this.t.y, v: dx * this.n.x + dy * this.n.y};
    }

    rect(u0: number, u1: number, v0: number, v1: number): Vector[] {
        return [this.toWorld(u0, v0), this.toWorld(u1, v0), this.toWorld(u1, v1), this.toWorld(u0, v1)];
    }

    line(u0: number, v0: number, u1: number, v1: number): Vector[] {
        return [this.toWorld(u0, v0), this.toWorld(u1, v1)];
    }

    /**
     * Minimum area bounding rectangle of polygon, with u along the longer side
     */
    static orientedBounds(polygon: Vector[]): {frame: LocalFrame; umin: number; umax: number; vmin: number; vmax: number} {
        let best: {frame: LocalFrame; umin: number; umax: number; vmin: number; vmax: number} = null;
        let bestArea = Infinity;
        for (let i = 0; i < polygon.length; i++) {
            const edge = polygon[(i + 1) % polygon.length].clone().sub(polygon[i]);
            if (edge.length() < 1) continue;
            edge.normalize();
            const frame = new LocalFrame(polygon[0].clone(), edge, new Vector(-edge.y, edge.x));
            let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
            for (const p of polygon) {
                const l = frame.toLocal(p);
                umin = Math.min(umin, l.u); umax = Math.max(umax, l.u);
                vmin = Math.min(vmin, l.v); vmax = Math.max(vmax, l.v);
            }
            const area = (umax - umin) * (vmax - vmin);
            if (area < bestArea) {
                bestArea = area;
                best = {frame, umin, umax, vmin, vmax};
            }
        }

        if (best !== null && best.vmax - best.vmin > best.umax - best.umin) {
            // Swap axes so u is the long side
            const f = best.frame;
            const frame = new LocalFrame(f.origin, f.n.clone(), f.t.clone().multiplyScalar(-1));
            best = {frame, umin: best.vmin, umax: best.vmax, vmin: -best.umax, vmax: -best.umin};
        }
        return best;
    }
}
