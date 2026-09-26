import * as SimplexNoise from 'simplex-noise';
import Vector from '../vector';
import PolygonUtil from './polygon_util';
import {resampleEqual, smoothLine} from './hydrology';

export interface ParkLayout {
    paths: Vector[][];  // World space
    ponds: Vector[][];
    woods: Vector[][];  // Wooded areas
    pitches: Vector[][];  // Pitch markings, drawn like paths
}

/**
 * Footpaths laid out the way park designers do: a loop walk around the park, paths in from
 * entrances on the surrounding streets curving gently towards the middle, and in big parks a pond
 * with the paths going round it
 */
export default class ParkPaths {
    private static readonly ENTRANCE_SPACING = 110;  // Along the park edge, world units (1 unit = 2 m)
    private static readonly POND_MIN_AREA = 25000;  // 10 hectares

    static layout(park: Vector[]): ParkLayout {
        const out: ParkLayout = {paths: [], ponds: [], woods: [], pitches: []};
        if (park.length < 3) return out;
        const area = PolygonUtil.calcPolygonArea(park);
        const centroid = PolygonUtil.averagePoint(park);
        const inside = (p: Vector, margin: number): boolean =>
            PolygonUtil.insidePolygon(p, park) && PolygonUtil.distanceToPolyline(p, park.concat([park[0]])) > margin;

        // Small parks just get a couple of paths crossing them
        if (area < 4000) {
            const entrances = ParkPaths.entrances(park, 2);
            for (let i = 0; i + 1 < entrances.length; i += 2) {
                out.paths.push(ParkPaths.curve(entrances[i], centroid.clone().add(entrances[i + 1]).divideScalar(2), entrances[i + 1]));
            }
            return out;
        }

        // Loop walk set in from the edge
        const inset = Math.min(30, 0.12 * Math.sqrt(area));
        let loop = PolygonUtil.resizeGeometry(park, -inset);
        if (loop.length > 3 && loop[0].equals(loop[loop.length - 1])) loop.pop();
        if (loop.length >= 3) {
            // Round off the corners, park loops never have sharp turns
            loop = resampleEqual(loop.concat([loop[0]]), 8);
            for (let k = 0; k < 4; k++) loop = ParkPaths.smoothClosed(loop, 3);
            out.paths.push(loop.concat([loop[0]]));
        }

        // A pond, off centre, with an irregular smooth edge
        let pond: Vector[] = [];
        if (area > ParkPaths.POND_MIN_AREA && loop.length >= 3) {
            const noise = new SimplexNoise();
            const radius = 0.16 * Math.sqrt(area);
            const offset = new Vector(Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.3 * radius);
            const centre = centroid.clone().add(offset);
            pond = [];
            for (let i = 0; i < 40; i++) {
                const a = 2 * Math.PI * i / 40;
                const r = radius * (1 + 0.35 * noise.noise2D(Math.cos(a), Math.sin(a)));
                pond.push(new Vector(centre.x + Math.cos(a) * r, centre.y + Math.sin(a) * r));
            }
            pond = ParkPaths.smoothClosed(pond, 2);
            if (pond.every(p => PolygonUtil.insidePolygon(p, loop))) {
                out.ponds.push(pond);
                // Path around the pond
                const around = PolygonUtil.resizeGeometry(pond, 10);
                if (around.length > 3) out.paths.push(ParkPaths.smoothClosed(around, 2).concat([around[0]]));
            } else {
                pond = [];
            }
        }

        // Entrances on the edge, each joined to the nearest part of the loop
        const entrances = ParkPaths.entrances(park, Math.max(3, Math.round(PolygonUtil.calcPolygonArea(park) / 12000)));
        for (const e of entrances) {
            if (loop.length < 3) break;
            let nearest = loop[0];
            for (const p of loop) if (p.distanceToSquared(e) < nearest.distanceToSquared(e)) nearest = p;
            // Bend towards the middle of the park
            const control = e.clone().add(nearest).divideScalar(2).add(centroid.clone().sub(e).multiplyScalar(0.12));
            out.paths.push(ParkPaths.curve(e, control, nearest));
        }

        // One or two cross paths over the lawn, avoiding the pond
        if (loop.length >= 3) {
            const crossings = area > 15000 ? 2 : 1;
            for (let c = 0; c < crossings; c++) {
                const a = loop[Math.floor(Math.random() * loop.length)];
                // Roughly opposite point on the loop
                let b = loop[0];
                for (const p of loop) if (p.distanceToSquared(a) > b.distanceToSquared(a)) b = p;
                const control = centroid.clone().add(new Vector(Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.3 * Math.sqrt(area)));
                const path = ParkPaths.curve(a, control, b);
                if (pond.length === 0 || !path.some(p => PolygonUtil.insidePolygon(p, PolygonUtil.resizeGeometry(pond, 6)))) {
                    out.paths.push(path);
                }
            }
        }

        // Keep everything inside the park
        out.paths = out.paths.map(p => p.filter(v => inside(v, 1))).filter(p => p.length >= 2);

        if (area > 12000 && loop.length >= 3) {
            const pitch = ParkPaths.pitch(loop, out.paths, pond);
            if (pitch.length > 0) out.pitches.push(...pitch);
        }
        out.woods = ParkPaths.woods(park, out.paths, pond, out.pitches);
        return out;
    }

    /**
     * Football pitch, about 100 x 64 m, somewhere on the open lawn
     */
    private static pitch(loop: Vector[], paths: Vector[][], pond: Vector[]): Vector[][] {
        const L = 52;
        const W = 34;
        const centroid = PolygonUtil.averagePoint(loop);
        for (let attempt = 0; attempt < 30; attempt++) {
            const angle = Math.random() * Math.PI;
            const t = new Vector(Math.cos(angle), Math.sin(angle));
            const n = new Vector(-t.y, t.x);
            const c = centroid.clone().add(new Vector(Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.5 * Math.sqrt(PolygonUtil.calcPolygonArea(loop))));
            const at = (u: number, v: number): Vector => c.clone().add(t.clone().multiplyScalar(u)).add(n.clone().multiplyScalar(v));
            const outline = [at(-L / 2, -W / 2), at(L / 2, -W / 2), at(L / 2, W / 2), at(-L / 2, W / 2)];
            const clear = outline.every(p => PolygonUtil.insidePolygon(p, loop))
                && !paths.some(path => path.some(p => PolygonUtil.insidePolygon(p, PolygonUtil.resizeGeometry(outline, 4))))
                && (pond.length === 0 || !pond.some(p => PolygonUtil.insidePolygon(p, PolygonUtil.resizeGeometry(outline, 6))));
            if (!clear) continue;
            const circle = PolygonUtil.circle(c, 4.6, 20);
            return [
                outline.concat([outline[0]]),
                [at(0, -W / 2), at(0, W / 2)],
                circle.concat([circle[0]]),
            ];
        }
        return [];
    }

    /**
     * Woods in patches rather than evenly sprinkled trees, clear of paths, water and pitches.
     * Sampled on a grid, then merged into smooth outlines
     */
    static woods(park: Vector[], paths: Vector[][], pond: Vector[], pitches: Vector[][]): Vector[][] {
        const noise = new SimplexNoise();
        const box = PolygonUtil.boundingBox(park);
        const STEP = 6;
        const RADIUS = 5;
        const pathPoints: Vector[] = [];
        for (const p of paths.concat(pitches)) pathPoints.push(...resampleEqual(p, 3));
        const edge = park.concat([park[0]]);
        const pondEdge = pond.length > 0 ? pond.concat([pond[0]]) : [];
        const centres: Vector[] = [];
        for (let x = box[0]; x <= box[2]; x += STEP) {
            for (let y = box[1]; y <= box[3]; y += STEP) {
                const c = new Vector(x + (Math.random() - 0.5) * 2, y + (Math.random() - 0.5) * 2);
                if (noise.noise2D(c.x / 110, c.y / 110) < 0.1) continue;
                if (!PolygonUtil.insidePolygon(c, park)) continue;
                if (PolygonUtil.distanceToPolyline(c, edge) < RADIUS + 1) continue;
                if (pathPoints.some(p => p.distanceToSquared(c) < (RADIUS + 2.5) ** 2)) continue;
                if (pond.length > 0 && (PolygonUtil.insidePolygon(c, pond) || PolygonUtil.distanceToPolyline(c, pondEdge) < RADIUS + 3)) continue;
                // Keep off pitches, lakes and sand
                if (pitches.some(p => (p.length >= 3 && PolygonUtil.insidePolygon(c, p)) ||
                    PolygonUtil.distanceToPolyline(c, p) < RADIUS + 3)) continue;
                centres.push(c);
            }
        }
        return PolygonUtil.unionOfCircles(centres, RADIUS, 2);
    }

    /**
     * Points spread around the park edge: corners first, then along long sides
     */
    private static entrances(park: Vector[], count: number): Vector[] {
        const edge = resampleEqual(park.concat([park[0]]), 4);
        const out: Vector[] = [];
        // Corners, where people arrive from two streets
        for (let i = 0; i < park.length; i++) {
            const a = park[(i + park.length - 1) % park.length];
            const b = park[i];
            const c = park[(i + 1) % park.length];
            const u = b.clone().sub(a);
            const v = c.clone().sub(b);
            if (u.length() === 0 || v.length() === 0) continue;
            if (Math.abs(Vector.angleBetween(u, v)) > 0.6) out.push(b.clone());
        }
        // Along the sides
        let along = 0;
        for (let i = 1; i < edge.length; i++) {
            along += edge[i].distanceTo(edge[i - 1]);
            if (along > ParkPaths.ENTRANCE_SPACING) {
                out.push(edge[i].clone());
                along = 0;
            }
        }
        // Spread out, not too many
        const chosen: Vector[] = [];
        const minGap = 0.6 * ParkPaths.ENTRANCE_SPACING;
        for (const p of out) {
            if (chosen.every(c => c.distanceTo(p) > minGap)) chosen.push(p);
        }
        return chosen.slice(0, Math.max(count, 2) * 2);
    }

    private static curve(a: Vector, control: Vector, b: Vector): Vector[] {
        const out: Vector[] = [];
        for (let i = 0; i <= 16; i++) {
            const t = i / 16;
            const mt = 1 - t;
            out.push(new Vector(
                mt * mt * a.x + 2 * mt * t * control.x + t * t * b.x,
                mt * mt * a.y + 2 * mt * t * control.y + t * t * b.y));
        }
        return out;
    }

    private static smoothClosed(polygon: Vector[], radius: number): Vector[] {
        const n = polygon.length;
        return polygon.map((_, i) => {
            const sum = Vector.zeroVector();
            for (let k = -radius; k <= radius; k++) sum.add(polygon[(i + k + n) % n]);
            return sum.divideScalar(2 * radius + 1);
        });
    }

    /**
     * Promenade along the landward edge of a beach, clipped to the park
     */
    static promenade(park: Vector[], shore: Vector[], beachWidths: number[], landward: (i: number) => Vector): Vector[][] {
        const line = shore.map((p, i) => p.clone().add(landward(i).multiplyScalar((beachWidths[i] || 0) + 4)));
        const runs: Vector[][] = [];
        let current: Vector[] = [];
        for (const p of smoothLine(line, 2)) {
            if (PolygonUtil.insidePolygon(p, park)) {
                current.push(p);
            } else if (current.length > 0) {
                runs.push(current);
                current = [];
            }
        }
        if (current.length > 0) runs.push(current);
        return runs.filter(r => r.length >= 4);
    }
}
