import Vector from '../vector';
import PolygonUtil from './polygon_util';

/**
 * Kinds of road, from the input to Addressing.build
 * Highways and ramps get names but no buildings are numbered on them
 */
export type StreetKind = 'highway' | 'ramp' | 'main' | 'major' | 'minor' | 'coast' | 'riverside' | 'frontage' | 'service';

export interface Street {
    name: string;
    kind: StreetKind;
    line: Vector[];  // World space, the road's pieces joined end to end
    crossStreets: string[];  // Names of the streets it meets
}

export interface Address {
    number: number;
    street: string;
    address: string;  // e.g. "124 Maple Street"
}

export interface AddressBook {
    streets: Street[];
    // For each road kind, the name of each input line, in input order
    roadNames: {[kind: string]: string[]};
    // For each group of buildings, the address of each building in input order, or null if no street is near
    addresses: {[group: string]: Address[]};
}

// Industrial service roads aren't named by the map's street naming, so they're named here
const INDUSTRY = ['Commerce', 'Industrial', 'Enterprise', 'Foundry', 'Depot', 'Freight', 'Factory',
    'Warehouse', 'Terminal', 'Cargo', 'Steel', 'Iron', 'Copper', 'Granite', 'Quarry', 'Rail', 'Distribution',
    'Logistics', 'Trade', 'Supply', 'Forge', 'Mill', 'Canal', 'Wharf', 'Dock', 'Harbor', 'Pier'];
const SERVICE_SUFFIXES = ['Way', 'Drive', 'Court', 'Road'];

const JOIN_DISTANCE = 4;  // Road ends this close, pointing at each other, are one street
const CROSS_DISTANCE = 3;  // A road ending this close to another meets it
const MAX_ADDRESS_DISTANCE = 120;  // World units, buildings further than this from any street get no address
const MAX_SITE_ADDRESS_DISTANCE = 300;  // Malls and apartment complexes sit far back behind their car parks
const METRES_PER_UNIT = 2;
const METRES_PER_NUMBER = 5;  // House numbers go up by 2 about every 10 m along the street
const FIRST_NUMBER = 100;

/**
 * Grid of street segments for nearby lookups
 */
class SegmentIndex {
    private grid = new Map<string, {a: Vector; b: Vector; street: number; k: number}[]>();

    constructor(streets: Street[], private cell: number) {
        streets.forEach((s, street) => {
            for (let k = 0; k < s.line.length - 1; k++) {
                const a = s.line[k];
                const b = s.line[k + 1];
                const seg = {a, b, street, k};
                for (let x = Math.floor(Math.min(a.x, b.x) / cell); x <= Math.floor(Math.max(a.x, b.x) / cell); x++) {
                    for (let y = Math.floor(Math.min(a.y, b.y) / cell); y <= Math.floor(Math.max(a.y, b.y) / cell); y++) {
                        const key = `${x},${y}`;
                        if (!this.grid.has(key)) this.grid.set(key, []);
                        this.grid.get(key).push(seg);
                    }
                }
            }
        });
    }

    near(p: Vector, q: Vector, margin: number): {a: Vector; b: Vector; street: number; k: number}[] {
        const out = new Set<{a: Vector; b: Vector; street: number; k: number}>();
        for (let x = Math.floor((Math.min(p.x, q.x) - margin) / this.cell); x <= Math.floor((Math.max(p.x, q.x) + margin) / this.cell); x++) {
            for (let y = Math.floor((Math.min(p.y, q.y) - margin) / this.cell); y <= Math.floor((Math.max(p.y, q.y) + margin) / this.cell); y++) {
                for (const s of this.grid.get(`${x},${y}`) || []) out.add(s);
            }
        }
        return Array.from(out);
    }

    nearest(p: Vector, maxDistance: number): {street: number; k: number} {
        let best: {street: number; k: number} = null;
        let bestD = maxDistance;
        // Widen the search until the best found is closer than anything unsearched
        for (let r = this.cell; r <= maxDistance + this.cell; r += this.cell) {
            for (const s of this.near(p, p, r)) {
                const d = PolygonUtil.distanceToSegment(p, s.a, s.b);
                if (d < bestD) {
                    bestD = d;
                    best = {street: s.street, k: s.k};
                }
            }
            if (best !== null && bestD <= r) break;
        }
        return best;
    }
}

/**
 * Gives each building a street address, like a US city: numbers go up along the street,
 * odd on the left and even on the right.
 * Streets keep the names the map already gave them, so addresses match the street labels.
 * Roads the map leaves unnamed (ramps, industrial service roads) are named here, with a random
 * generator seeded from the road layout so the same map always gets the same names
 */
export default class Addressing {
    /**
     * @param roads world space lines of each kind
     * @param names the map's name for each line of a kind, in the same order. Kinds without names are named here
     * @param buildings world space footprints, by group
     * @param farGroups groups whose buildings can be further from their street
     */
    static build(roads: {[kind: string]: Vector[][]}, names: {[kind: string]: string[]},
                 buildings: {[group: string]: Vector[][]}, farGroups: string[] = []): AddressBook {
        const random = Addressing.seededRandom(roads);
        const used = new Set<string>();
        for (const kind in names) for (const n of names[kind]) if (n) used.add(n);
        const streets: Street[] = [];
        const roadNames: {[kind: string]: string[]} = {};

        const order: StreetKind[] = ['highway', 'main', 'major', 'coast', 'riverside', 'minor', 'service', 'frontage', 'ramp'];
        const highways: Street[] = [];
        for (const kind of order) {
            const lines = (roads[kind] || []).map(l => l.length >= 2 ? l : []);
            roadNames[kind] = lines.map(() => null);
            const given = names[kind];
            const kindStreets: {street: Street; members: number[]}[] = [];

            if (given) {
                // Pieces with the same name that join end to end are one street
                const byName = new Map<string, number[]>();
                lines.forEach((l, i) => {
                    if (l.length < 2 || !given[i]) return;
                    if (!byName.has(given[i])) byName.set(given[i], []);
                    byName.get(given[i]).push(i);
                });
                byName.forEach((members, name) => {
                    for (const c of Addressing.chain(members.map(i => lines[i]))) {
                        kindStreets.push({street: {name, kind, line: c.line, crossStreets: []}, members: c.members.map(m => members[m])});
                    }
                });
            } else {
                for (const c of Addressing.chain(lines)) {
                    kindStreets.push({street: {name: null, kind, line: c.line, crossStreets: []}, members: c.members});
                }
                for (const {street} of kindStreets) {
                    if (kind === 'ramp') {
                        const highway = Addressing.nearestStreet(highways, PolygonUtil.averagePoint(street.line));
                        street.name = `${highway ? highway.street.name : 'Highway'} Ramp`;
                    } else {
                        street.name = Addressing.pickName(INDUSTRY, SERVICE_SUFFIXES, used, random);
                    }
                }
            }

            for (const {street, members} of kindStreets) {
                for (const m of members) roadNames[kind][m] = street.name;
                streets.push(street);
                if (kind === 'highway') highways.push(street);
            }
        }

        Addressing.findCrossStreets(streets);

        // Frontage roads are numbered along their highway, so the pieces either side of an interchange carry on
        const reference = new Map<Street, Vector[]>();
        for (const s of streets) {
            if (s.kind !== 'frontage') continue;
            const highway = Addressing.nearestStreet(highways, PolygonUtil.averagePoint(s.line));
            if (highway) reference.set(s, highway.street.line);
        }

        const addressable = streets.filter(s => s.kind !== 'highway' && s.kind !== 'ramp');
        const addresses = Addressing.number(addressable, buildings, reference, farGroups);
        return {streets, roadNames, addresses};
    }

    /**
     * Joins road pieces whose ends meet and carry straight on, e.g. a side street either side of an underpass
     */
    private static chain(lines: Vector[][]): {line: Vector[]; members: number[]}[] {
        // Each end: [line, 0 for start or 1 for end]
        const partner = new Map<string, [number, number]>();
        const key = (i: number, e: number): string => `${i}:${e}`;
        const ends: {i: number; e: number; p: Vector; out: Vector}[] = [];
        lines.forEach((l, i) => {
            if (l.length < 2) return;
            const out0 = l[0].clone().sub(l[1]);
            const out1 = l[l.length - 1].clone().sub(l[l.length - 2]);
            if (out0.lengthSq() > 0) ends.push({i, e: 0, p: l[0], out: out0.normalize()});
            if (out1.lengthSq() > 0) ends.push({i, e: 1, p: l[l.length - 1], out: out1.normalize()});
        });
        const candidates: {a: number; b: number; d: number}[] = [];
        const grid = new Map<string, number[]>();
        const cell = (v: Vector): string => `${Math.floor(v.x / 10)},${Math.floor(v.y / 10)}`;
        ends.forEach((end, k) => {
            const c = cell(end.p);
            if (!grid.has(c)) grid.set(c, []);
            grid.get(c).push(k);
        });
        ends.forEach((end, a) => {
            const cx = Math.floor(end.p.x / 10);
            const cy = Math.floor(end.p.y / 10);
            for (let x = cx - 1; x <= cx + 1; x++) {
                for (let y = cy - 1; y <= cy + 1; y++) {
                    for (const b of grid.get(`${x},${y}`) || []) {
                        if (b <= a || ends[b].i === end.i) continue;
                        const d = end.p.distanceTo(ends[b].p);
                        if (d < JOIN_DISTANCE && end.out.dot(ends[b].out) < -0.8) candidates.push({a, b, d});
                    }
                }
            }
        });
        candidates.sort((x, y) => x.d - y.d);
        for (const c of candidates) {
            const a = ends[c.a];
            const b = ends[c.b];
            if (partner.has(key(a.i, a.e)) || partner.has(key(b.i, b.e))) continue;
            partner.set(key(a.i, a.e), [b.i, b.e]);
            partner.set(key(b.i, b.e), [a.i, a.e]);
        }

        // Walk each chain from a free end, or anywhere for a loop
        const used = new Set<number>();
        const out: {line: Vector[]; members: number[]}[] = [];
        const walk = (start: number, startEnd: number): void => {
            const line: Vector[] = [];
            const members: number[] = [];
            let i = start;
            let entry = startEnd;
            while (i !== undefined && !used.has(i)) {
                used.add(i);
                members.push(i);
                const piece = entry === 0 ? lines[i] : lines[i].slice().reverse();
                line.push(...(line.length > 0 ? piece.slice(1) : piece));
                const next = partner.get(key(i, 1 - entry));
                if (!next) break;
                [i, entry] = next;
            }
            out.push({line, members});
        };
        lines.forEach((l, i) => {
            if (l.length < 2 || used.has(i)) return;
            if (!partner.has(key(i, 0))) walk(i, 0);
            else if (!partner.has(key(i, 1))) walk(i, 1);
        });
        lines.forEach((l, i) => {
            if (l.length >= 2 && !used.has(i)) walk(i, 0);
        });
        return out;
    }

    private static findCrossStreets(streets: Street[]): void {
        const index = new SegmentIndex(streets, 40);
        const crosses = streets.map(() => new Set<number>());
        streets.forEach((s, si) => {
            for (let k = 0; k < s.line.length - 1; k++) {
                const a = s.line[k];
                const b = s.line[k + 1];
                for (const seg of index.near(a, b, CROSS_DISTANCE)) {
                    if (seg.street === si) continue;
                    const touching = PolygonUtil.segmentIntersection(a, b, seg.a, seg.b) !== null
                        || (k === 0 && PolygonUtil.distanceToSegment(a, seg.a, seg.b) < CROSS_DISTANCE)
                        || (k === s.line.length - 2 && PolygonUtil.distanceToSegment(b, seg.a, seg.b) < CROSS_DISTANCE);
                    if (touching) {
                        crosses[si].add(seg.street);
                        crosses[seg.street].add(si);
                    }
                }
            }
        });
        streets.forEach((s, si) => {
            const names = new Set<string>();
            crosses[si].forEach(o => {
                if (streets[o].name !== s.name) names.add(streets[o].name);
            });
            s.crossStreets = Array.from(names).sort();
        });
    }

    /**
     * Each building is numbered on the nearest street, by how far along the street it is
     */
    private static number(streets: Street[], buildings: {[group: string]: Vector[][]},
                          reference: Map<Street, Vector[]>, farGroups: string[]): {[group: string]: Address[]} {
        const index = new SegmentIndex(streets, 40);
        const lengths = streets.map(s => Addressing.cumulativeLengths(s.line));
        const refLengths = new Map<Vector[], number[]>();
        reference.forEach(line => {
            if (!refLengths.has(line)) refLengths.set(line, Addressing.cumulativeLengths(line));
        });

        // Placed per street and side, then numbered in order
        const placed: {group: string; i: number; street: number; along: number; left: boolean}[] = [];
        const out: {[group: string]: Address[]} = {};
        for (const group in buildings) {
            out[group] = buildings[group].map(() => null);
            const maxDistance = farGroups.indexOf(group) >= 0 ? MAX_SITE_ADDRESS_DISTANCE : MAX_ADDRESS_DISTANCE;
            buildings[group].forEach((polygon, i) => {
                if (polygon.length < 3) return;
                const centre = PolygonUtil.averagePoint(polygon);
                const nearest = index.nearest(centre, maxDistance);
                if (nearest === null) return;
                const s = streets[nearest.street];
                const a = s.line[nearest.k];
                const b = s.line[nearest.k + 1];
                const ab = b.clone().sub(a);
                const t = ab.lengthSq() === 0 ? 0 : Math.max(0, Math.min(1, centre.clone().sub(a).dot(ab) / ab.lengthSq()));
                let along = lengths[nearest.street][nearest.k] + t * ab.length();
                const left = ab.cross(centre.clone().sub(a)) < 0;  // Screen y points down
                const ref = reference.get(s);
                if (ref) along = Addressing.distanceAlong(ref, refLengths.get(ref), centre);
                placed.push({group, i, street: nearest.street, along, left});
            });
        }

        placed.sort((x, y) => x.along - y.along);
        const lastNumber = new Map<string, number>();  // Per street name and side
        const taken = new Set<string>();
        for (const p of placed) {
            const name = streets[p.street].name;
            const side = p.left ? 1 : 0;
            const sideKey = `${name}|${side}`;
            let n = FIRST_NUMBER + 2 * Math.floor(p.along * METRES_PER_UNIT / (2 * METRES_PER_NUMBER)) + side;
            if (lastNumber.has(sideKey)) n = Math.max(n, lastNumber.get(sideKey) + 2);
            while (taken.has(`${n} ${name}`)) n += 2;
            lastNumber.set(sideKey, n);
            taken.add(`${n} ${name}`);
            out[p.group][p.i] = {number: n, street: name, address: `${n} ${name}`};
        }
        return out;
    }

    private static cumulativeLengths(line: Vector[]): number[] {
        const out = [0];
        for (let k = 1; k < line.length; k++) out.push(out[k - 1] + line[k].distanceTo(line[k - 1]));
        return out;
    }

    private static distanceAlong(line: Vector[], lengths: number[], p: Vector): number {
        let best = Infinity;
        let along = 0;
        for (let k = 0; k < line.length - 1; k++) {
            const d = PolygonUtil.distanceToSegment(p, line[k], line[k + 1]);
            if (d < best) {
                best = d;
                const ab = line[k + 1].clone().sub(line[k]);
                const t = ab.lengthSq() === 0 ? 0 : Math.max(0, Math.min(1, p.clone().sub(line[k]).dot(ab) / ab.lengthSq()));
                along = lengths[k] + t * ab.length();
            }
        }
        return along;
    }

    private static nearestStreet(streets: Street[], p: Vector): {street: Street; point: Vector} {
        let best: {street: Street; point: Vector} = null;
        let bestD = Infinity;
        for (const s of streets) {
            for (let k = 0; k < s.line.length - 1; k++) {
                const a = s.line[k];
                const ab = s.line[k + 1].clone().sub(a);
                const t = ab.lengthSq() === 0 ? 0 : Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / ab.lengthSq()));
                const q = a.clone().add(ab.multiplyScalar(t));
                const d = q.distanceToSquared(p);
                if (d < bestD) {
                    bestD = d;
                    best = {street: s, point: q};
                }
            }
        }
        return best;
    }

    /**
     * A random name not used yet, which is then marked as used
     */
    private static pickName(pool: string[], suffixes: string[], used: Set<string>, random: () => number): string {
        const name = Addressing.freeName(pool, suffixes, used, random);
        used.add(name);
        return name;
    }

    private static freeName(pool: string[], suffixes: string[], used: Set<string>, random: () => number): string {
        for (let attempt = 0; attempt < 40; attempt++) {
            const name = `${pool[Math.floor(random() * pool.length)]} ${suffixes[Math.floor(random() * suffixes.length)]}`;
            if (!used.has(name)) return name;
        }
        // Pool nearly used up, take the first free combination
        for (const base of pool) {
            for (const suffix of suffixes) {
                if (!used.has(`${base} ${suffix}`)) return `${base} ${suffix}`;
            }
        }
        return Addressing.unique(`${pool[0]} ${suffixes[0]}`, used);
    }

    private static unique(name: string, used: Set<string>): string {
        if (!used.has(name)) return name;
        for (const prefix of ['North', 'South', 'East', 'West', 'Old', 'New']) {
            if (!used.has(`${prefix} ${name}`)) return `${prefix} ${name}`;
        }
        let n = 2;
        while (used.has(`${name} ${n}`)) n++;
        return `${name} ${n}`;
    }

    /**
     * Mulberry32, seeded from the road ends
     */
    private static seededRandom(roads: {[kind: string]: Vector[][]}): () => number {
        let h = 2166136261;
        for (const kind of Object.keys(roads).sort()) {
            for (const line of roads[kind]) {
                if (line.length === 0) continue;
                for (const v of [line[0], line[line.length - 1]]) {
                    h = Math.imul(h ^ Math.round(v.x * 10), 16777619);
                    h = Math.imul(h ^ Math.round(v.y * 10), 16777619);
                }
            }
        }
        let a = h >>> 0;
        return (): number => {
            a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }
}
