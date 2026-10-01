import * as isect from 'isect';
import Vector from '../vector';

/**
 * A road to build the network from. Roads are polylines in world space
 */
export interface NetworkRoad {
    line: Vector[];
    cls: string;
    halfWidth: number;  // World units. Roads ending at its kerb rather than its centreline still join it
}

export interface NetworkNode {
    at: Vector;
    edges: number[];  // Indices into the edge list
}

export interface NetworkEdge {
    road: number;  // Index of the road it is part of
    line: Vector[];  // Starts at its from node and ends at its to node
    from: number;  // Node indices
    to: number;
    length: number;  // World units
}

interface Segment {
    from: Vector;
    to: Vector;
}

interface Split {
    seg: number;  // Segment index along the road
    t: number;  // 0-1 along that segment
    node: number;
}

type Grade = 'surface' | 'link' | 'motorway';

/**
 * Turns road centrelines into a graph to find routes on: nodes where roads meet, edges along
 * the roads between them.
 *
 * Roads meet where they cross or where one ends on another, except that motorways and their ramps
 * are grade separated: they pass over anything that crosses them, and only join other roads
 * where a ramp ends. So a route can't step off a motorway onto the street underneath it.
 */
export default class RoadNetwork {
    private static readonly SNAP = 2;  // An end this close to the edge of another road joins it, world units
    private static readonly RAMP_REACH = 4;  // Ramps merge into the outer lane, further from the motorway's edge
    private static readonly MAX_DRIVEWAY = 40;  // Longest driveway added to reach a car park cut off from the streets
    private static readonly MERGE = 0.3;  // Nodes this close together are one node

    private nodePositions: Vector[] = [];
    private nodeGrades: Set<Grade>[] = [];
    private splits: Split[][];
    private parent: number[] = [];

    private constructor(private roads: NetworkRoad[]) {
        this.splits = roads.map(() => []);
    }

    /**
     * Car parks the generator left without a way in get a driveway to the nearest street.
     * Edges whose road index is past the end of `roads` are on those driveways
     */
    static build(roads: NetworkRoad[]): {nodes: NetworkNode[]; edges: NetworkEdge[]; driveways: Vector[][]} {
        const first = new RoadNetwork(roads).run();
        const driveways = RoadNetwork.driveways(roads, first.nodes, first.edges);
        if (driveways.length === 0) return Object.assign(first, {driveways});
        const withDriveways = roads.concat(driveways.map(line => ({line, cls: 'service', halfWidth: RoadNetwork.DRIVEWAY_HALF_WIDTH})));
        return Object.assign(new RoadNetwork(withDriveways).run(), {driveways});
    }

    static readonly DRIVEWAY_HALF_WIDTH = 1.5;

    /**
     * For each group of car park aisles not joined to any other road, the shortest link to a surface road
     */
    private static driveways(roads: NetworkRoad[], nodes: NetworkNode[], edges: NetworkEdge[]): Vector[][] {
        // Connected components
        const component = nodes.map(() => -1);
        let count = 0;
        nodes.forEach((_, start) => {
            if (component[start] >= 0) return;
            const stack = [start];
            component[start] = count;
            while (stack.length > 0) {
                const n = stack.pop();
                for (const e of nodes[n].edges) {
                    for (const m of [edges[e].from, edges[e].to]) {
                        if (component[m] < 0) {
                            component[m] = count;
                            stack.push(m);
                        }
                    }
                }
            }
            count++;
        });
        const onlyAisles = new Array(count).fill(true);
        for (const e of edges) {
            if (roads[e.road].cls !== 'parking_aisle') onlyAisles[component[e.from]] = false;
        }

        const targets = edges.filter(e => !onlyAisles[component[e.from]] && RoadNetwork.grade(roads[e.road].cls) === 'surface');
        const best: {d: number; from: Vector; to: Vector}[] = new Array(count).fill(null);
        nodes.forEach((n, i) => {
            const c = component[i];
            if (!onlyAisles[c]) return;
            for (const e of targets) {
                for (let k = 0; k < e.line.length - 1; k++) {
                    const at = RoadNetwork.closestOnSegment(n.at, e.line[k], e.line[k + 1]);
                    const d = at.distanceTo(n.at) - roads[e.road].halfWidth;
                    if (d <= RoadNetwork.MAX_DRIVEWAY && (best[c] === null || d < best[c].d)) best[c] = {d, from: n.at, to: at};
                }
            }
        });
        return best.filter(b => b !== null).map(b => [b.from.clone(), b.to.clone()]);
    }

    private static grade(cls: string): Grade {
        if (cls === 'motorway') return 'motorway';
        if (cls === 'motorway_link') return 'link';
        return 'surface';
    }

    /**
     * Whether a road crossing another in the middle meets it
     */
    private static meetCrossing(a: Grade, b: Grade): boolean {
        return a === 'surface' && b === 'surface';
    }

    /**
     * Whether the end of a road of grade a joins a road of grade b it ends on
     */
    private static meetAtEnd(a: Grade, b: Grade): boolean {
        if (a === 'surface') return b !== 'motorway';
        if (a === 'link') return true;
        return b !== 'surface';  // A motorway end continues as motorway or a ramp
    }

    private addNode(at: Vector, grades: Grade[]): number {
        this.nodePositions.push(at.clone());
        this.nodeGrades.push(new Set(grades));
        this.parent.push(this.parent.length);
        return this.nodePositions.length - 1;
    }

    private find(n: number): number {
        while (this.parent[n] !== n) {
            this.parent[n] = this.parent[this.parent[n]];
            n = this.parent[n];
        }
        return n;
    }

    private union(a: number, b: number): void {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra === rb) return;
        this.parent[rb] = ra;
        for (const g of this.nodeGrades[rb]) this.nodeGrades[ra].add(g);
    }

    private run(): {nodes: NetworkNode[]; edges: NetworkEdge[]} {
        this.splitAtCrossings();
        this.splitAtEnds();
        this.joinRampLoops();
        this.mergeCloseNodes();
        return this.buildGraph();
    }

    private splitAtCrossings(): void {
        const segments: Segment[] = [];
        const owner = new Map<Segment, {road: number; seg: number}>();
        this.roads.forEach((r, ri) => {
            for (let i = 0; i < r.line.length - 1; i++) {
                if (r.line[i].distanceToSquared(r.line[i + 1]) < 1e-8) continue;
                const s = {from: r.line[i], to: r.line[i + 1]};
                segments.push(s);
                owner.set(s, {road: ri, seg: i});
            }
        });

        for (const crossing of isect.bush(segments).run()) {
            const at = new Vector(crossing.point.x, crossing.point.y);
            const on = (crossing.segments as Segment[]).map(s => owner.get(s)).filter(o => o !== undefined);
            const roads = Array.from(new Set(on.map(o => o.road)));
            const grades = roads.map(r => RoadNetwork.grade(this.roads[r].cls));
            // Only surface roads meet where they cross
            const meeting = roads.filter((r, i) => grades.some((g, j) => j !== i && RoadNetwork.meetCrossing(grades[i], g)));
            if (meeting.length < 2) continue;
            const node = this.addNode(at, meeting.map(r => RoadNetwork.grade(this.roads[r].cls)));
            for (const o of on) {
                if (meeting.indexOf(o.road) < 0) continue;
                this.splits[o.road].push({seg: o.seg, t: RoadNetwork.param(this.roads[o.road].line, o.seg, at), node});
            }
        }
    }

    /**
     * Joins the end of each road to whatever road it stops on, or gives it a node of its own
     */
    private static readonly CELL = 8;

    private static key(p: Vector): string {
        return `${Math.floor(p.x / RoadNetwork.CELL)},${Math.floor(p.y / RoadNetwork.CELL)}`;
    }

    /**
     * Road segments by grid cell, each in every cell within snapping reach of it
     */
    private segmentGrid(): Map<string, {road: number; seg: number}[]> {
        const CELL = RoadNetwork.CELL;
        const reach = RoadNetwork.SNAP + RoadNetwork.RAMP_REACH + Math.max(0, ...this.roads.map(r => r.halfWidth));
        const grid = new Map<string, {road: number; seg: number}[]>();
        const key = (x: number, y: number): string => `${x},${y}`;
        this.roads.forEach((r, ri) => {
            for (let i = 0; i < r.line.length - 1; i++) {
                const a = r.line[i];
                const b = r.line[i + 1];
                for (let x = Math.floor((Math.min(a.x, b.x) - reach) / CELL); x <= Math.floor((Math.max(a.x, b.x) + reach) / CELL); x++) {
                    for (let y = Math.floor((Math.min(a.y, b.y) - reach) / CELL); y <= Math.floor((Math.max(a.y, b.y) + reach) / CELL); y++) {
                        const k = key(x, y);
                        if (!grid.has(k)) grid.set(k, []);
                        grid.get(k).push({road: ri, seg: i});
                    }
                }
            }
        });
        return grid;
    }

    private splitAtEnds(): void {
        const grid = this.segmentGrid();
        this.roads.forEach((r, ri) => {
            if (r.line.length < 2) return;
            const grade = RoadNetwork.grade(r.cls);
            const last = r.line.length - 2;
            for (const [end, seg, t] of [[r.line[0], 0, 0], [r.line[r.line.length - 1], last, 1]] as [Vector, number, number][]) {
                let best: {road: number; seg: number; at: Vector; d: number} = null;
                for (const c of grid.get(RoadNetwork.key(end)) || []) {
                    // A road's own end only counts at the other end of a closed loop
                    if (c.road === ri && Math.abs(c.seg - seg) <= 1) continue;
                    if (!RoadNetwork.meetAtEnd(grade, RoadNetwork.grade(this.roads[c.road].cls))) continue;
                    const line = this.roads[c.road].line;
                    const at = RoadNetwork.closestOnSegment(end, line[c.seg], line[c.seg + 1]);
                    // Measured from the road's edge, so the nearest road wins even beside a wide one
                    const otherGrade = RoadNetwork.grade(this.roads[c.road].cls);
                    const d = at.distanceTo(end) - this.roads[c.road].halfWidth;
                    const snap = RoadNetwork.SNAP + (grade === 'link' && otherGrade === 'motorway' ? RoadNetwork.RAMP_REACH : 0);
                    if (d <= snap && (best === null || d < best.d)) best = {road: c.road, seg: c.seg, at, d};
                }

                const grades: Grade[] = [grade];
                if (best !== null) grades.push(RoadNetwork.grade(this.roads[best.road].cls));
                const node = this.addNode(best === null ? end : best.at, grades);
                this.splits[ri].push({seg, t, node});
                if (best !== null) {
                    this.splits[best.road].push({seg: best.seg, t: RoadNetwork.param(this.roads[best.road].line, best.seg, best.at), node});
                }
            }
        });
    }

    /**
     * Cloverleaf loops are drawn as whole circles touching the motorways and ramps they link.
     * They join each of those where they come closest to it
     */
    private joinRampLoops(): void {
        const grid = this.segmentGrid();
        this.roads.forEach((r, ri) => {
            const line = r.line;
            if (RoadNetwork.grade(r.cls) !== 'link' || line.length < 4 || line[0].distanceTo(line[line.length - 1]) > RoadNetwork.MERGE) return;
            const best = new Map<number, {seg: number; at: Vector; vertex: number; d: number}>();
            for (let i = 0; i < line.length - 1; i++) {
                for (const c of grid.get(RoadNetwork.key(line[i])) || []) {
                    if (c.road === ri || RoadNetwork.grade(this.roads[c.road].cls) === 'surface') continue;
                    const other = this.roads[c.road].line;
                    const at = RoadNetwork.closestOnSegment(line[i], other[c.seg], other[c.seg + 1]);
                    const d = at.distanceTo(line[i]) - this.roads[c.road].halfWidth;
                    const b = best.get(c.road);
                    if (d <= RoadNetwork.SNAP + RoadNetwork.RAMP_REACH && (b === undefined || d < b.d)) {
                        best.set(c.road, {seg: c.seg, at, vertex: i, d});
                    }
                }
            }
            best.forEach((b, road) => {
                const node = this.addNode(b.at, ['link', RoadNetwork.grade(this.roads[road].cls)]);
                this.splits[ri].push({seg: b.vertex, t: 0, node});
                this.splits[road].push({seg: b.seg, t: RoadNetwork.param(this.roads[road].line, b.seg, b.at), node});
            });
        });
    }

    /**
     * Nodes found more than once (a crossing at a road's end, two roads ending at the same point)
     * become one, unless one is only on motorways and the other only on surface roads
     */
    private mergeCloseNodes(): void {
        const CELL = 1;
        const grid = new Map<string, number[]>();
        const key = (x: number, y: number): string => `${x},${y}`;
        this.nodePositions.forEach((p, n) => {
            const cx = Math.floor(p.x / CELL);
            const cy = Math.floor(p.y / CELL);
            for (let x = cx - 1; x <= cx + 1; x++) {
                for (let y = cy - 1; y <= cy + 1; y++) {
                    for (const m of grid.get(key(x, y)) || []) {
                        if (this.nodePositions[m].distanceTo(p) > RoadNetwork.MERGE) continue;
                        const a = this.nodeGrades[this.find(m)];
                        const b = this.nodeGrades[n];
                        const onlyMotorway = (g: Set<Grade>): boolean => !g.has('surface') && !g.has('link');
                        const onlySurface = (g: Set<Grade>): boolean => !g.has('motorway') && !g.has('link');
                        if ((onlyMotorway(a) && onlySurface(b)) || (onlySurface(a) && onlyMotorway(b))) continue;
                        this.union(m, n);
                    }
                }
            }
            const k = key(cx, cy);
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push(n);
        });
    }

    private buildGraph(): {nodes: NetworkNode[]; edges: NetworkEdge[]} {
        // Renumber the merged nodes, each at the average of the nodes merged into it
        const index = new Map<number, number>();
        const sums: Vector[] = [];
        const counts: number[] = [];
        this.nodePositions.forEach((p, n) => {
            const root = this.find(n);
            if (!index.has(root)) {
                index.set(root, sums.length);
                sums.push(Vector.zeroVector());
                counts.push(0);
            }
            sums[index.get(root)].add(p);
            counts[index.get(root)]++;
        });
        const nodes: NetworkNode[] = sums.map((s, i) => ({at: s.divideScalar(counts[i]), edges: []}));
        const nodeOf = (n: number): number => index.get(this.find(n));

        const edges: NetworkEdge[] = [];
        this.roads.forEach((r, ri) => {
            const splits = this.splits[ri].slice().sort((a, b) => a.seg - b.seg || a.t - b.t);
            for (let k = 0; k < splits.length - 1; k++) {
                const a = splits[k];
                const b = splits[k + 1];
                const from = nodeOf(a.node);
                const to = nodeOf(b.node);
                const line = [nodes[from].at.clone()];
                for (let i = a.seg + 1; i <= b.seg; i++) line.push(r.line[i].clone());
                line.push(nodes[to].at.clone());
                const clean = line.filter((v, i) => i === 0 || v.distanceToSquared(line[i - 1]) > 1e-6);
                let length = 0;
                for (let i = 1; i < clean.length; i++) length += clean[i].distanceTo(clean[i - 1]);
                if (clean.length < 2 || length < 0.01 || (from === to && length < 2 * RoadNetwork.SNAP + 2 * r.halfWidth)) continue;
                nodes[from].edges.push(edges.length);
                if (to !== from) nodes[to].edges.push(edges.length);
                edges.push({road: ri, line: clean, from, to, length});
            }
        });

        // Drop nodes no edge uses, keeping the edges' node indices in step
        const used = nodes.map(n => n.edges.length > 0);
        const renumber: number[] = [];
        let next = 0;
        used.forEach((u, i) => renumber[i] = u ? next++ : -1);
        for (const e of edges) {
            e.from = renumber[e.from];
            e.to = renumber[e.to];
        }
        return {nodes: nodes.filter((_, i) => used[i]), edges};
    }

    /**
     * Position of a point along a segment, 0 at its start and 1 at its end
     */
    private static param(line: Vector[], seg: number, p: Vector): number {
        const a = line[seg];
        const ab = line[seg + 1].clone().sub(a);
        const len2 = ab.lengthSq();
        if (len2 === 0) return 0;
        return Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / len2));
    }

    private static closestOnSegment(p: Vector, a: Vector, b: Vector): Vector {
        const ab = b.clone().sub(a);
        const len2 = ab.lengthSq();
        if (len2 === 0) return a.clone();
        const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / len2));
        return a.clone().add(ab.multiplyScalar(t));
    }
}
