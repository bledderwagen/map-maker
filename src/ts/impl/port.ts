import Vector from '../vector';
import PolygonUtil from './polygon_util';
import LocalFrame from './local_frame';

export interface Port {
    centre: Vector;
    land: Vector[][];  // Reclaimed quay and piers, world space
    water: Vector[][];  // Slips cut back into the quay
    buildings: Vector[][];  // Transit sheds and container stacks
    roads: Vector[][];
}

export interface PortParams {
    halfSpan: number;  // Half the length of waterfront the port takes up
    pierLength: number;
    pierWidth: number;
    slipWidth: number;  // Water between piers
}

/**
 * Builds a port out into the sea from a straight-ish stretch of coast
 *
 * Layout, looking out to sea (v increases seawards):
 *   coast road, quay road, container yard, slips cut into the quay between the pier roots,
 *   then piers of equal length reaching out into the sea, each with a road and a transit shed
 */
export default class PortPlanner {
    private static readonly MAX_SHORE_SPREAD = 45;  // Coast must be this straight
    private static readonly QUAY_DEPTH = 80;  // From the most seaward point of the shore to the quay wall
    private static readonly SLIP_DEPTH = 40;  // How far slips cut back into the quay

    /**
     * Tries a number of places along the coast and returns the port on the straightest stretch
     * Returns null if nowhere is suitable
     */
    static plan(coastRoad: Vector[], sea: Vector[], river: Vector[],
                params: PortParams, allowed: (v: Vector) => boolean): Port {
        if (coastRoad.length < 2 || sea.length < 3) return null;
        const samples = PolygonUtil.resamplePolyline(coastRoad, 4);

        const candidates: number[] = [];
        for (let i = 0; i < samples.points.length; i++) {
            if (allowed(samples.points[i])) candidates.push(i);
        }

        let best: Port = null;
        let bestSpread = Infinity;
        for (let t = 0; t < 20 && candidates.length > 0; t++) {
            const i = candidates[Math.floor(Math.random() * candidates.length)];
            const result = PortPlanner.build(samples.points, samples.distances, i, sea, river, params);
            if (result !== null && result.spread < bestSpread) {
                bestSpread = result.spread;
                best = result.port;
            }
        }
        return best;
    }

    private static build(points: Vector[], distances: number[], centreIndex: number,
                         sea: Vector[], river: Vector[], params: PortParams): {port: Port; spread: number} {
        const centreDistance = distances[centreIndex];
        const shore = points.filter((p, i) => Math.abs(distances[i] - centreDistance) <= params.halfSpan);
        if (shore.length < 2) return null;
        const p0 = shore[0];
        const p1 = shore[shore.length - 1];
        const L = p0.distanceTo(p1);
        if (L < 1.6 * params.halfSpan) return null;  // Too close to the end of the coast

        const t = p1.clone().sub(p0).normalize();
        let frame = new LocalFrame(p0, t, new Vector(-t.y, t.x));
        const middle = frame.toWorld(L / 2, 40);
        if (!PolygonUtil.insidePolygon(middle, sea)) {
            frame = new LocalFrame(p0, t, new Vector(t.y, -t.x));
            if (!PolygonUtil.insidePolygon(frame.toWorld(L / 2, 40), sea)) return null;
        }

        const offsets = shore.map(p => frame.toLocal(p).v);
        const minShore = Math.min(...offsets);
        const maxShore = Math.max(...offsets);
        const spread = maxShore - minShore;
        if (spread > PortPlanner.MAX_SHORE_SPREAD) return null;

        const quayWall = maxShore + PortPlanner.QUAY_DEPTH;
        const slipBack = quayWall - PortPlanner.SLIP_DEPTH;
        const pierEnd = quayWall + params.pierLength;
        const {pierWidth, slipWidth} = params;

        // Piers evenly spaced and centred along the quay
        const numPiers = Math.floor((L - 30 + slipWidth) / (pierWidth + slipWidth));
        if (numPiers < 2) return null;
        const total = numPiers * pierWidth + (numPiers - 1) * slipWidth;
        const start = (L - total) / 2;
        const pierStarts: number[] = [];
        for (let k = 0; k < numPiers; k++) pierStarts.push(start + k * (pierWidth + slipWidth));

        // Everything has to be built out into open sea, clear of the river
        const inWater = (u: number, v: number): boolean => {
            const p = frame.toWorld(u, v);
            return PolygonUtil.insidePolygon(p, sea) && !PolygonUtil.insidePolygon(p, river);
        };
        for (const u0 of pierStarts) {
            if (!inWater(u0, pierEnd + 10) || !inWater(u0 + pierWidth, pierEnd + 10) ||
                !inWater(u0 + pierWidth / 2, quayWall + 1)) return null;
        }
        if (!inWater(0, quayWall) || !inWater(L, quayWall)) return null;
        // Keep well clear of the river, which is drawn over the top of the port
        for (let u = -20; u <= L + 20; u += 8) {
            for (let v = minShore - 20; v <= pierEnd + 20; v += 8) {
                if (PolygonUtil.insidePolygon(frame.toWorld(u, v), river)) return null;
            }
        }

        const land: Vector[][] = [];
        const water: Vector[][] = [];
        const buildings: Vector[][] = [];
        const roads: Vector[][] = [];

        // Only the part of the platform that was sea is new land
        const platform = PolygonUtil.intersectPolygons(frame.rect(0, L, minShore - 2, quayWall), sea);
        if (platform.length < 3) return null;
        land.push(platform);

        const quayRoad = maxShore + 12;
        const yardStart = quayRoad + 6;
        const yardEnd = slipBack - 4;

        for (let k = 0; k < numPiers; k++) {
            const u0 = pierStarts[k];
            const u1 = u0 + pierWidth;
            land.push(frame.rect(u0, u1, quayWall - 1, pierEnd));
            if (k < numPiers - 1) {
                water.push(frame.rect(u1, u1 + slipWidth, slipBack, quayWall + 1));
            }

            // Road down one side of the pier, transit shed along the other
            roads.push(frame.line(u0 + 5, quayRoad, u0 + 5, pierEnd - 4));
            buildings.push(frame.rect(u0 + 10, u1 - 3, slipBack + 5, pierEnd - 6));
        }

        // Quay road, joined to the coast road at both ends
        const ends = [6, L - 6];
        roads.push(frame.line(ends[0], quayRoad, ends[1], quayRoad));
        for (const u of ends) {
            const shoreHere = PortPlanner.shoreOffsetAt(frame, shore, u);
            roads.push(frame.line(u, quayRoad, u, shoreHere - 1));
        }

        // Container stacks in rows, leaving gaps where pier roads cross the yard
        const STACK_LENGTH = 12;
        const STACK_WIDTH = 4;
        const pierRoads = pierStarts.map(u0 => u0 + 5);
        for (let v = yardStart; v + STACK_WIDTH <= yardEnd; v += STACK_WIDTH + 3) {
            for (let u = ends[0] + 6; u + STACK_LENGTH <= ends[1] - 6; u += STACK_LENGTH + 2) {
                if (pierRoads.some(r => r > u - 5 && r < u + STACK_LENGTH + 5)) continue;
                buildings.push(frame.rect(u, u + STACK_LENGTH, v, v + STACK_WIDTH));
            }
        }

        return {
            port: {centre: points[centreIndex].clone(), land, water, buildings, roads},
            spread,
        };
    }

    private static shoreOffsetAt(frame: LocalFrame, shore: Vector[], u: number): number {
        let best = shore[0];
        let bestDistance = Infinity;
        for (const p of shore) {
            const d = Math.abs(frame.toLocal(p).u - u);
            if (d < bestDistance) {
                bestDistance = d;
                best = p;
            }
        }
        return frame.toLocal(best).v;
    }
}
