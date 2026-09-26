import * as SimplexNoise from 'simplex-noise';
import Vector from '../vector';
import PolygonUtil from './polygon_util';

/**
 * Resamples a polyline so consecutive points are exactly spacing apart (the last segment may be shorter)
 */
export function resampleEqual(line: Vector[], spacing: number): Vector[] {
    if (line.length < 2) return line.slice();
    const out = [line[0].clone()];
    let carry = 0;
    for (let i = 0; i < line.length - 1; i++) {
        const a = line[i];
        const b = line[i + 1];
        const length = a.distanceTo(b);
        let d = spacing - carry;
        while (d <= length) {
            out.push(a.clone().add(b.clone().sub(a).multiplyScalar(d / length)));
            d += spacing;
        }
        carry = length - (d - spacing);
    }
    // Always keep the end point, otherwise repeated resampling slowly eats the line
    const last = line[line.length - 1];
    if (out.length > 1 && out[out.length - 1].distanceTo(last) < 0.25 * spacing) out.pop();
    out.push(last.clone());
    return out;
}

export function polylineLength(line: Vector[]): number {
    let length = 0;
    for (let i = 0; i < line.length - 1; i++) length += line[i].distanceTo(line[i + 1]);
    return length;
}

/**
 * Unit normals (left of the direction of travel), smoothed over neighbouring points
 */
export function normals(line: Vector[]): Vector[] {
    return line.map((_, i) => {
        const a = line[Math.max(0, i - 1)];
        const b = line[Math.min(line.length - 1, i + 1)];
        const t = b.clone().sub(a);
        if (t.lengthSq() === 0) return new Vector(0, 1);
        t.normalize();
        return new Vector(-t.y, t.x);
    });
}

/**
 * Moving average of a polyline, end points fixed
 */
export function smoothLine(line: Vector[], radius: number): Vector[] {
    const out: Vector[] = [];
    for (let i = 0; i < line.length; i++) {
        const r = Math.min(radius, i, line.length - 1 - i);
        const sum = Vector.zeroVector();
        for (let k = -r; k <= r; k++) sum.add(line[i + k]);
        out.push(sum.divideScalar(2 * r + 1));
    }
    return out;
}

export function smoothValues(values: number[], radius: number): number[] {
    return values.map((_, i) => {
        let sum = 0;
        let n = 0;
        for (let k = -radius; k <= radius; k++) {
            const j = i + k;
            if (j < 0 || j >= values.length) continue;
            sum += values[j];
            n++;
        }
        return sum / n;
    });
}

/**
 * Removes loops from a polyline: where two points far apart along the line are closer than
 * distance, the part in between is cut out. Returns the removed loops
 */
export function removeLoops(points: Vector[], distance: number, minGap: number): {line: Vector[]; loops: Vector[][]} {
    const loops: Vector[][] = [];
    let line = points;
    for (let pass = 0; pass < 50; pass++) {
        const cell = distance;
        const grid = new Map<string, number[]>();
        const key = (x: number, y: number): string => `${x},${y}`;
        for (let i = 0; i < line.length; i++) {
            const k = key(Math.floor(line[i].x / cell), Math.floor(line[i].y / cell));
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push(i);
        }
        let cut = false;
        for (let i = 0; i < line.length && !cut; i++) {
            const cx = Math.floor(line[i].x / cell);
            const cy = Math.floor(line[i].y / cell);
            let best = -1;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    for (const j of grid.get(key(cx + dx, cy + dy)) || []) {
                        if (j - i > minGap && j > best && line[i].distanceTo(line[j]) < distance) best = j;
                    }
                }
            }
            if (best > 0) {
                loops.push(line.slice(i, best + 1));
                line = line.slice(0, i + 1).concat(line.slice(best));
                cut = true;
            }
        }
        if (!cut) break;
    }
    return {line, loops};
}

/**
 * Relaxes corners sharper than maxAngle (radians) towards their neighbours, end points fixed
 */
export function despike(line: Vector[], maxAngle: number, passes: number): Vector[] {
    let out = line.map(p => p.clone());
    for (let pass = 0; pass < passes; pass++) {
        let changed = false;
        const next = out.map(p => p.clone());
        for (let i = 1; i < out.length - 1; i++) {
            const a = out[i].clone().sub(out[i - 1]);
            const b = out[i + 1].clone().sub(out[i]);
            const la = a.length();
            const lb = b.length();
            if (la === 0 || lb === 0) continue;
            const turn = Math.acos(Math.max(-1, Math.min(1, a.dot(b) / (la * lb))));
            if (turn > maxAngle) {
                // Pull this point and its neighbours in a little
                next[i] = out[i - 1].clone().add(out[i + 1]).divideScalar(2);
                if (i > 1) next[i - 1] = out[i - 2].clone().add(out[i - 1]).add(out[i]).divideScalar(3);
                if (i < out.length - 2) next[i + 1] = out[i].clone().add(out[i + 1]).add(out[i + 2]).divideScalar(3);
                changed = true;
            }
        }
        out = next;
        if (!changed) break;
    }
    return out;
}

export interface MeanderParams {
    width: number;  // Channel width upstream, world units
    widthDownstream: number;  // Channel width at the mouth
    sinuosity: number;  // Stop when the channel is this much longer than it started
    maxIterations: number;
    fixed?: (p: Vector) => boolean;  // Points that don't move, e.g. out at sea
}

export interface MeanderResult {
    centreline: Vector[];  // Upstream to downstream
    widths: number[];  // Channel width at each centreline point
    oxbows: Vector[][];  // Cut off loops, as centrelines
    pointBars: Vector[][];  // Sand on the inside of tight bends
    channel: Vector[];  // Water polygon
}

/**
 * Meandering river, after the Howard & Knutson (1984) bend migration model
 *
 * Each step, every point on the centreline moves sideways at a rate set by the local curvature
 * plus a weighted sum of the curvature upstream. The upstream term makes the outer bank of a
 * bend erode fastest a little way past the apex, so bends grow and drift downstream. When a
 * loop's neck gets narrower than the channel the loop is cut off and left as an oxbow lake.
 */
export class MeanderSimulator {
    private static readonly OMEGA = -1;  // Local curvature coefficient
    private static readonly GAMMA = 2.5;  // Upstream curvature coefficient
    private static readonly PINNED = 4;  // Points at each end that stay put so the river still leaves the map

    static simulate(line: Vector[], params: MeanderParams): MeanderResult {
        const w = params.width;
        const ds = w / 2;
        // Distance over which upstream curvature still matters. Bends grow when their wavelength is longer
        // than about 5 times this, so it sets the meander wavelength
        const decay = 1.0 * w;
        const kernel: number[] = [];
        for (let k = 1; k * ds < 4 * decay; k++) kernel.push(Math.exp(-k * ds / decay));
        const kernelSum = kernel.reduce((a, b) => a + b, 0);

        // Wiggles much shorter than a meander would just be smoothed away by the model, drop them now
        let points = resampleEqual(smoothLine(resampleEqual(line, ds), 3), ds);
        // Small bends at about the natural meander wavelength, 10 to 14 channel widths, for the model to grow
        {
            const seed = new SimplexNoise();
            const norms = normals(points);
            points = points.map((p, i) => i < MeanderSimulator.PINNED || i >= points.length - MeanderSimulator.PINNED ? p :
                p.clone().add(norms[i].clone().multiplyScalar(0.8 * w * seed.noise2D(i * ds / (2.2 * w), 0.5))));
        }
        const startLength = polylineLength(points);
        const oxbows: Vector[][] = [];
        const noise = new SimplexNoise();

        for (let iteration = 0; iteration < params.maxIterations; iteration++) {
            if (polylineLength(points) > params.sinuosity * startLength) break;
            const n = points.length;
            if (n < 2 * MeanderSimulator.PINNED + 3) break;

            // Signed curvature, positive turning left
            const curvature = new Array(n).fill(0);
            for (let i = 1; i < n - 1; i++) {
                const a = points[i].clone().sub(points[i - 1]);
                const b = points[i + 1].clone().sub(points[i]);
                curvature[i] = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y) / ds;
            }

            // Migration rate
            const rate = new Array(n).fill(0);
            for (let i = 1; i < n - 1; i++) {
                let upstream = 0;
                for (let k = 0; k < kernel.length && i - k - 1 >= 0; k++) upstream += curvature[i - k - 1] * kernel[k];
                rate[i] = MeanderSimulator.OMEGA * curvature[i] + MeanderSimulator.GAMMA * upstream / kernelSum;
            }
            // Scale steps by a high percentile rather than the maximum, which is often a kink by the pinned ends
            const sorted = rate.slice(MeanderSimulator.PINNED + 2, n - MeanderSimulator.PINNED - 2).map(Math.abs).sort((a, b) => a - b);
            const maxRate = Math.max(1e-9, sorted[Math.floor(0.95 * (sorted.length - 1))] || 0);

            // A positive rate moves the bank outwards, away from the centre of the bend.
            // Steps are normalised so the fastest bank moves a small fraction of the width
            const step = 0.03 * w / maxRate;
            const norms = normals(points);
            const moved = points.map((p, i) => {
                if (i < MeanderSimulator.PINNED || i >= n - MeanderSimulator.PINNED) return p.clone();
                if (params.fixed && params.fixed(p)) return p.clone();
                // Ease in next to the pinned ends
                const ease = Math.min(1, Math.min(i - MeanderSimulator.PINNED, n - 1 - MeanderSimulator.PINNED - i) / 6);
                // A little noise keeps straight reaches from staying perfectly straight
                const jitter = 0.004 * w * noise.noise2D(i * 0.15, iteration * 0.01);
                const move = Math.max(-0.05 * w, Math.min(0.05 * w, -rate[i] * step));
                return p.clone().add(norms[i].clone().multiplyScalar(ease * (move + jitter)));
            });

            // No smoothing here: at this spacing even light smoothing straightens the river faster than it meanders
            points = resampleEqual(moved, ds);
            // Neck cutoff: the river breaks through where a loop's neck is narrower than the channel
            const cut = removeLoops(points, 1.1 * w, Math.ceil(6 * Math.PI));
            points = cut.line;
            oxbows.push(...cut.loops);
        }

        const widths = MeanderSimulator.widths(points, params);
        return {
            centreline: points,
            widths,
            oxbows,
            pointBars: MeanderSimulator.pointBars(points, widths),
            channel: MeanderSimulator.channelPolygon(points, widths),
        };
    }

    private static widths(points: Vector[], params: MeanderParams): number[] {
        const total = polylineLength(points);
        let along = 0;
        return points.map((p, i) => {
            if (i > 0) along += p.distanceTo(points[i - 1]);
            const t = total > 0 ? along / total : 0;
            return params.width + (params.widthDownstream - params.width) * t * t;
        });
    }

    static channelPolygon(points: Vector[], widths: number[]): Vector[] {
        const norms = normals(points);
        const left = points.map((p, i) => p.clone().add(norms[i].clone().multiplyScalar(widths[i] / 2)));
        const right = points.map((p, i) => p.clone().sub(norms[i].clone().multiplyScalar(widths[i] / 2)));
        return PolygonUtil.cleanPolygon(left.concat(right.reverse()));
    }

    /**
     * Sand deposited on the inside of bends tighter than a few channel widths
     */
    private static pointBars(points: Vector[], widths: number[]): Vector[][] {
        const n = points.length;
        const curvature = new Array(n).fill(0);
        for (let i = 1; i < n - 1; i++) {
            const a = points[i].clone().sub(points[i - 1]);
            const b = points[i + 1].clone().sub(points[i]);
            curvature[i] = Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y) / a.length();
        }
        const smooth = smoothValues(curvature, 3);
        const norms = normals(points);
        const bars: Vector[][] = [];
        let i = 0;
        while (i < n) {
            const tight = (j: number): boolean => Math.abs(smooth[j]) * widths[j] > 0.3;
            if (!tight(i)) { i++; continue; }
            const sign = Math.sign(smooth[i]);
            let j = i;
            while (j < n && tight(j) && Math.sign(smooth[j]) === sign) j++;
            if (j - i >= 4) {
                // Crescent against the inner bank, thickest at the apex
                const inner: Vector[] = [];
                const outer: Vector[] = [];
                for (let k = i; k < j; k++) {
                    const t = (k - i) / (j - i - 1);
                    const thickness = 0.4 * widths[k] * Math.sin(Math.PI * t);
                    const bank = points[k].clone().add(norms[k].clone().multiplyScalar(sign * widths[k] / 2));
                    inner.push(bank);
                    outer.push(bank.clone().sub(norms[k].clone().multiplyScalar(sign * thickness)));
                }
                bars.push(inner.concat(outer.reverse()));
            }
            i = j;
        }
        return bars;
    }
}

export interface ShoreParams {
    spacing: number;
    iterations: number;
    headlandAmplitude: number;  // Size of the initial bumps in the coast
    erosionRate: number;  // How far exposed soft coast retreats each iteration
    maxBeachWidth: number;
}

export interface ShoreResult {
    shore: Vector[];
    beachWidths: number[];  // Width of sand at each shore point, 0 on rocky coast
    hardness: number[];
}

/**
 * Coastline shaped by waves, after the one-line (CERC) shoreline model
 *
 * Waves arriving at an angle to the shore move sand along it at a rate proportional to
 * sin(2 * angle). Where that rate changes along the coast the shore builds out or erodes.
 * Soft stretches erode into smooth curved bays facing the waves, hard rock survives as
 * headlands, and sand collects as beaches in the bays.
 */
export class ShorelineSimulator {
    /**
     * @param seaward 1 if the sea is to the left of the direction of travel, -1 if right
     */
    static evolve(line: Vector[], seaward: number, params: ShoreParams): ShoreResult {
        const noise = new SimplexNoise();
        const ds = params.spacing;
        // Carry on well past the map edges, so the ends can stay put while the rest moves
        const extension = 400;
        const startDir = line[0].clone().sub(line[Math.min(5, line.length - 1)]).normalize();
        const endDir = line[line.length - 1].clone().sub(line[Math.max(0, line.length - 6)]).normalize();
        let shore = resampleEqual([line[0].clone().add(startDir.multiplyScalar(extension))]
            .concat(line)
            .concat([line[line.length - 1].clone().add(endDir.multiplyScalar(extension))]), ds);
        const total = polylineLength(shore);
        // 0 at the far ends, 1 once inside the map
        const fixedness = (s: number): number => Math.max(0, Math.min(1, (Math.min(s, total - s) - 0.5 * extension) / (0.5 * extension)));

        // Headlands and bays, and bands of harder rock
        const n0 = normals(shore);
        let along = 0;
        shore = shore.map((p, i) => {
            if (i > 0) along += p.distanceTo(shore[i - 1]);
            const bump = params.headlandAmplitude * (0.7 * noise.noise2D(along / 900, 3.1) + 0.3 * noise.noise2D(along / 300, 7.7));
            return p.clone().add(n0[i].clone().multiplyScalar(seaward * bump * fixedness(along)));
        });
        const endStart = shore[0].clone();
        const endEnd = shore[shore.length - 1].clone();
        let alongPos: number[] = [];
        const measure = (): void => {
            alongPos = [];
            let a = 0;
            for (let i = 0; i < shore.length; i++) {
                if (i > 0) a += shore[i].distanceTo(shore[i - 1]);
                alongPos.push(a);
            }
        };
        measure();
        // Hardness belongs to the rock, so it depends on position, not distance along the shore
        const hardnessAt = (p: Vector): number => {
            const v = noise.noise2D(p.x / 500, p.y / 500);
            return Math.max(0, Math.min(1, (v - 0.1) * 1.4));
        };

        // Waves come from the open sea, somewhat off the general direction of the coast
        const chord = shore[shore.length - 1].clone().sub(shore[0]).normalize();
        const seaNormal = new Vector(-chord.y * seaward, chord.x * seaward);
        const angle = (Math.random() - 0.5) * 1.0;
        const towardsLand = seaNormal.clone().multiplyScalar(-1);
        const waves = new Vector(
            towardsLand.x * Math.cos(angle) - towardsLand.y * Math.sin(angle),
            towardsLand.x * Math.sin(angle) + towardsLand.y * Math.cos(angle));

        const K = 0.2 * ds * ds;  // Transport coefficient times time step, stable for the explicit scheme
        let accretion: number[] = new Array(shore.length).fill(0);

        for (let it = 0; it < params.iterations; it++) {
            const n = shore.length;
            // Transport on each segment
            const Q = new Array(n - 1).fill(0);
            const exposure = new Array(n - 1).fill(0);
            for (let i = 0; i < n - 1; i++) {
                const t = shore[i + 1].clone().sub(shore[i]);
                const length = t.length();
                if (length === 0) continue;
                t.divideScalar(length);
                const normalOut = new Vector(-t.y * seaward, t.x * seaward);
                const cosA = -waves.dot(normalOut);
                if (cosA <= 0) continue;  // Shore faces away from the waves
                const sinA = waves.dot(t);
                // Above 45 degrees sin(2a) falls with angle and the model becomes unstable (the high angle
                // wave instability behind cuspate capes), which at this resolution only makes sawteeth
                const a = Math.max(-0.7, Math.min(0.7, Math.atan2(sinA, cosA)));
                Q[i] = Math.sin(2 * a) * Math.min(1, cosA / 0.3);
                exposure[i] = cosA;
            }
            const norms = normals(shore);
            const next = shore.map((p, i) => {
                if (i === 0 || i === n - 1) return p;
                const h = hardnessAt(p);
                // Longshore drift moves sand from where transport speeds up to where it slows down
                let drift = -(Q[i] - Q[i - 1]) * K / ds / ds;
                if (drift < 0) drift *= (1 - 0.85 * h);  // Rock resists erosion, but not completely
                accretion[i] += drift;
                // Waves attack soft rock directly, cutting bays between the hard headlands
                const attack = params.erosionRate * (1 - 0.9 * h) * 0.5 * (exposure[i] + exposure[i - 1]);
                const dy = fixedness(alongPos[i] * total / alongPos[n - 1]) * Math.max(-0.3 * ds, Math.min(0.3 * ds, drift - attack));
                return p.clone().add(norms[i].clone().multiplyScalar(seaward * dy));
            });
            shore = next;

            if (it % 25 === 24) {
                // Keep points evenly spaced, carrying accretion along
                const resampled = despike(removeLoops(resampleEqual(shore, ds), 0.8 * ds, 4).line, Math.PI / 3, 20);
                accretion = resampled.map(p => accretion[ShorelineSimulator.nearest(shore, p)]);
                shore = resampled;
                shore[0] = endStart.clone();
                shore[shore.length - 1] = endEnd.clone();
                measure();
            }
        }

        shore = despike(removeLoops(resampleEqual(smoothLine(shore, 2), ds), 0.8 * ds, 4).line, Math.PI / 3, 50);
        shore[0] = endStart.clone();
        shore[shore.length - 1] = endEnd.clone();
        accretion = shore.map((p, i) => accretion[Math.min(i, accretion.length - 1)]);
        const hardness = shore.map(hardnessAt);
        // Rocky coast gets a rougher edge
        const nf = normals(shore);
        shore = shore.map((p, i) => i === 0 || i === shore.length - 1 ? p :
            p.clone().add(nf[i].clone().multiplyScalar(seaward * 2.5 * hardness[i] * noise.noise2D(i * 0.25, 2.3))));

        const beach = shore.map((_, i) => {
            if (hardness[i] > 0.55) return 0;
            const sheltered = Math.max(0, accretion[i]);
            return Math.min(params.maxBeachWidth, (1 - hardness[i]) * (8 + 0.8 * sheltered));
        });
        return {shore, beachWidths: smoothValues(beach, 4), hardness};
    }

    private static nearest(line: Vector[], p: Vector): number {
        let best = 0;
        let bestDistance = Infinity;
        for (let i = 0; i < line.length; i++) {
            const d = line[i].distanceToSquared(p);
            if (d < bestDistance) {
                bestDistance = d;
                best = i;
            }
        }
        return best;
    }
}
