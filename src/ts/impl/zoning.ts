import * as log from 'loglevel';
import * as SimplexNoise from 'simplex-noise';
import * as simplify from 'simplify-js';
import Vector from '../vector';
import PolygonUtil from './polygon_util';
import TensorField from './tensor_field';

export const enum Zone {
    Residential = 0,
    LowIncome = 1,
    Industrial = 2,
}

export interface ZoningParams {
    numIndustrialZones: number;
    industrialSize: number;  // Rough radius of an industrial zone
    lowIncomeAmount: number;  // 0-1, how much of the city is low income
    highwayBuffer: number;  // Distance from highway centreline where building lots are cut off
}

/**
 * An area enclosed by highways, main and major roads, the size of a real neighbourhood
 */
export interface District {
    polygon: Vector[];  // World space
    centre: Vector;
    industrial: boolean;
    income: number;  // 0 poorest to 1 richest, ranked across the city's districts
}

/**
 * Income bands along the 0-1 income scale, from low income to wealthy
 */
export const INCOME_BANDS = [
    {name: 'Low', max: 0.2},
    {name: 'Working class', max: 0.4},
    {name: 'Middle', max: 0.6},
    {name: 'Upper middle', max: 0.8},
    {name: 'Wealthy', max: 1},
];

/**
 * Decides land use across the map
 *
 * Industry is placed at highway interchanges and on the waterfront (ports)
 * Every district then gets an income level from how desirable its land is: industry, highways and
 * the wrong side of the freeway drag it down, the waterfront and the affluent side of town lift it
 * Income shades gradually from district to district, and low income housing is simply the bottom
 * of that gradient
 *
 * Zones are first picked per point, then snapped to whole districts so that zone edges follow streets
 * Results are cached in a raster so lookups during road integration are cheap
 */
export default class Zoning {
    private readonly CELL_SIZE = 4;
    private readonly HIGHWAY_RANGE = 250;  // Beyond this distance to a highway we don't care
    static readonly LOW_INCOME_LINE = INCOME_BANDS[0].max;

    private noise = new SimplexNoise();

    private origin = Vector.zeroVector();
    private worldDimensions = Vector.zeroVector();
    private cols = 0;
    private rows = 0;
    private zones: Uint8Array = new Uint8Array(0);
    private highwayDistance: Float32Array = new Float32Array(0);
    private interchangeCells: Uint8Array = new Uint8Array(0);
    private districtCells: Int32Array = new Int32Array(0);  // Index into _districts, or -1

    private highways: Vector[][] = [];
    private waterfront: Vector[][] = [];  // Simplified, only used for desirability
    private interchangeAreas: Vector[][] = [];
    private industrialDistricts: Vector[][] = [];
    private industrialDistrictBoxes: number[][] = [];
    private districtBoxes: number[][] = [];
    private _districts: District[] = [];
    // Sorted district desirability, and the share of residential land less desirable than each
    private rankedDesirability: number[] = [];
    private rankedShare: number[] = [];

    public industrialCentres: Vector[] = [];

    // Low income housing is kept to one side of this highway, the 'wrong side of the freeway'
    private divider: Vector[] = null;
    private dividerSide = 1;

    // The well off side of town, as far from industry as the city allows (Hoyt's sector model)
    private affluentCentre: Vector = null;

    constructor(public params: ZoningParams, private tensorField: TensorField) {}

    get enabled(): boolean {
        return this.cols > 0;
    }

    get districts(): District[] {
        return this._districts;
    }

    reset(): void {
        this.cols = 0;
        this.rows = 0;
        this.highways = [];
        this.waterfront = [];
        this.interchangeAreas = [];
        this.industrialCentres = [];
        this._districts = [];
        this.districtBoxes = [];
        this.industrialDistricts = [];
        this.industrialDistrictBoxes = [];
        this.rankedDesirability = [];
        this.rankedShare = [];
        this.divider = null;
        this.affluentCentre = null;
    }

    /**
     * Called once highways and interchanges exist
     * Picks where industry goes and prepares distance lookups
     * @param waterfront polylines along coast and river, other industry is kept away from them
     * @param portCentre where the port is, if there is one
     */
    setup(origin: Vector, worldDimensions: Vector,
          highways: Vector[][], interchanges: {centre: Vector; area: Vector[]}[],
          waterfront: Vector[][], portCentre: Vector): void {
        this.reset();
        this.noise = new SimplexNoise();
        this.origin = origin.clone();
        this.worldDimensions = worldDimensions.clone();
        this.cols = Math.ceil(worldDimensions.x / this.CELL_SIZE) + 1;
        this.rows = Math.ceil(worldDimensions.y / this.CELL_SIZE) + 1;
        this.highways = highways;
        this.interchangeAreas = interchanges.map(i => i.area);
        this.waterfront = waterfront.filter(w => w.length >= 2).map(w =>
            simplify(w.map(v => ({x: v.x, y: v.y})), 8).map((p: {x: number; y: number}) => new Vector(p.x, p.y)));

        this.computeHighwayDistances();
        this.computeInterchangeCells();
        this.pickIndustrialCentres(origin, worldDimensions, interchanges.map(i => i.centre), waterfront, portCentre);
        this.pickDivider();
        this.pickAffluentCentre();
        this.rasteriseZones([]);
    }

    /**
     * Called once main and major roads exist
     * Each district (polygon enclosed by larger roads) gets the zone at its centre and an income level
     */
    setDistricts(districts: Vector[][]): void {
        if (!this.enabled) return;
        this.rasteriseZones(districts);
    }

    zoneAt(point: Vector): Zone {
        const i = this.cellIndex(point);
        if (i < 0) return Zone.Residential;
        return this.zones[i];
    }

    /**
     * Income level of the housing at point, 0 poorest to 1 richest
     * Mostly the district's own level, shading towards the neighbours' near its edges
     */
    incomeAt(point: Vector): number {
        if (!this.enabled || this.rankedDesirability.length === 0) return 0.5;
        const local = this.toIncome(this.desirability(point));
        const i = this.cellIndex(point);
        const d = i < 0 ? -1 : this.districtCells[i];
        if (d < 0) return local;
        return Math.max(0, Math.min(1, 0.65 * this._districts[d].income + 0.35 * local));
    }

    /**
     * Only precise to CELL_SIZE, used during road integration
     */
    approxHighwayDistance(point: Vector): number {
        const i = this.cellIndex(point);
        if (i < 0) return Infinity;
        return this.highwayDistance[i];
    }

    exactHighwayDistance(point: Vector): number {
        if (this.approxHighwayDistance(point) > 2 * this.CELL_SIZE + 30) return Infinity;
        let min = Infinity;
        for (const h of this.highways) min = Math.min(min, PolygonUtil.distanceToPolyline(point, h));
        return min;
    }

    inInterchange(point: Vector): boolean {
        const i = this.cellIndex(point);
        if (i < 0 || this.interchangeCells[i] === 0) return false;
        return this.interchangeAreas.some(a => PolygonUtil.insidePolygon(point, a));
    }

    /**
     * Exact test against district polygons, for trimming streets at the zone edge
     */
    inIndustrialDistrict(point: Vector): boolean {
        if (!this.enabled) return false;
        for (let i = 0; i < this.industrialDistricts.length; i++) {
            const box = this.industrialDistrictBoxes[i];
            if (point.x < box[0] || point.y < box[1] || point.x > box[2] || point.y > box[3]) continue;
            if (PolygonUtil.insidePolygon(point, this.industrialDistricts[i])) return true;
        }
        // Points not covered by any district use the per-point zone
        return !this.inAnyDistrict(point) && this.zoneAt(point) === Zone.Industrial;
    }

    /**
     * Areas where building lots are not allowed: highway verges and interchanges
     */
    get exclusionAreas(): Vector[][] {
        const out: Vector[][] = this.interchangeAreas.slice();
        for (const h of this.highways) {
            // Split into chunks so that clipping only touches nearby geometry
            const CHUNK = 12;
            for (let i = 0; i < h.length - 1; i += CHUNK) {
                const chunk = h.slice(i, Math.min(h.length, i + CHUNK + 1));
                if (chunk.length < 2) continue;
                const buffered = PolygonUtil.resizeGeometry(chunk, this.params.highwayBuffer, false);
                if (buffered.length > 2) {
                    buffered.pop();
                    out.push(buffered);
                }
            }
        }
        return out;
    }

    private inAnyDistrict(point: Vector): boolean {
        for (let i = 0; i < this._districts.length; i++) {
            const box = this.districtBoxes[i];
            if (point.x < box[0] || point.y < box[1] || point.x > box[2] || point.y > box[3]) continue;
            if (PolygonUtil.insidePolygon(point, this._districts[i].polygon)) return true;
        }
        return false;
    }

    private cellIndex(point: Vector): number {
        if (this.cols === 0) return -1;
        const x = Math.floor((point.x - this.origin.x) / this.CELL_SIZE);
        const y = Math.floor((point.y - this.origin.y) / this.CELL_SIZE);
        if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return -1;
        return y * this.cols + x;
    }

    private cellCentre(x: number, y: number): Vector {
        return new Vector(
            this.origin.x + (x + 0.5) * this.CELL_SIZE,
            this.origin.y + (y + 0.5) * this.CELL_SIZE);
    }

    private computeHighwayDistances(): void {
        this.highwayDistance = new Float32Array(this.cols * this.rows).fill(Infinity);
        const range = this.HIGHWAY_RANGE;
        for (const h of this.highways) {
            for (let s = 0; s < h.length - 1; s++) {
                const a = h[s];
                const b = h[s + 1];
                const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - range - this.origin.x) / this.CELL_SIZE));
                const x1 = Math.min(this.cols - 1, Math.floor((Math.max(a.x, b.x) + range - this.origin.x) / this.CELL_SIZE));
                const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - range - this.origin.y) / this.CELL_SIZE));
                const y1 = Math.min(this.rows - 1, Math.floor((Math.max(a.y, b.y) + range - this.origin.y) / this.CELL_SIZE));
                for (let y = y0; y <= y1; y++) {
                    for (let x = x0; x <= x1; x++) {
                        const d = PolygonUtil.distanceToSegment(this.cellCentre(x, y), a, b);
                        const i = y * this.cols + x;
                        if (d < this.highwayDistance[i]) this.highwayDistance[i] = d;
                    }
                }
            }
        }
    }

    private computeInterchangeCells(): void {
        this.interchangeCells = new Uint8Array(this.cols * this.rows);
        for (const area of this.interchangeAreas) {
            this.forCellsInPolygon(area, 1, i => this.interchangeCells[i] = 1);
        }
    }

    /**
     * Calls fn for every cell whose centre is inside polygon
     * margin grows the bounding box, in cells
     */
    private forCellsInPolygon(polygon: Vector[], margin: number, fn: (i: number) => void): void {
        const box = PolygonUtil.boundingBox(polygon);
        const x0 = Math.max(0, Math.floor((box[0] - this.origin.x) / this.CELL_SIZE) - margin);
        const x1 = Math.min(this.cols - 1, Math.floor((box[2] - this.origin.x) / this.CELL_SIZE) + margin);
        const y0 = Math.max(0, Math.floor((box[1] - this.origin.y) / this.CELL_SIZE) - margin);
        const y1 = Math.min(this.rows - 1, Math.floor((box[3] - this.origin.y) / this.CELL_SIZE) + margin);
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                if (PolygonUtil.insidePolygon(this.cellCentre(x, y), polygon)) fn(y * this.cols + x);
            }
        }
    }

    private inner(v: Vector, margin: number): boolean {
        const t = v.clone().sub(this.origin);
        return t.x > margin * this.worldDimensions.x && t.x < (1 - margin) * this.worldDimensions.x &&
            t.y > margin * this.worldDimensions.y && t.y < (1 - margin) * this.worldDimensions.y;
    }

    /**
     * Industry wants highway access
     * Waterfront land is too valuable for anything but a port, so other industry keeps away from it
     */
    private pickIndustrialCentres(origin: Vector, worldDimensions: Vector,
                                  interchanges: Vector[], waterfront: Vector[][], portCentre: Vector): void {
        const R = this.params.industrialSize;
        const inner = (v: Vector): boolean => this.inner(v, 0.1);
        const farFromOthers = (v: Vector): boolean => this.industrialCentres.every(c => c.distanceTo(v) > 2.2 * R);
        const awayFromWater = (v: Vector): boolean => waterfront.every(w => w.length < 2 || PolygonUtil.distanceToPolyline(v, w) > 1.3 * R);
        const shuffle = <T>(arr: T[]): T[] => {
            const a = arr.slice();
            for (let i = a.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [a[i], a[j]] = [a[j], a[i]];
            }
            return a;
        };

        if (portCentre && this.params.numIndustrialZones > 0) this.industrialCentres.push(portCentre.clone());

        const candidates: Vector[] = [];
        candidates.push(...shuffle(interchanges.filter(inner)));
        candidates.push(...shuffle(([] as Vector[]).concat(...this.highways).filter(inner)).slice(0, 60));

        const accept = (c: Vector): boolean => this.tensorField.onLand(c) && farFromOthers(c) && awayFromWater(c);
        for (const c of candidates) {
            if (this.industrialCentres.length >= this.params.numIndustrialZones) break;
            if (accept(c)) this.industrialCentres.push(c);
        }

        // No highways, fall back to anywhere
        for (let i = 0; i < 100 && this.industrialCentres.length < this.params.numIndustrialZones; i++) {
            const c = new Vector(Math.random(), Math.random()).multiply(worldDimensions).add(origin);
            if (inner(c) && accept(c)) this.industrialCentres.push(c);
        }
    }

    /**
     * The longest highway divides the city, low income housing goes on the side with more industry
     */
    private pickDivider(): void {
        this.divider = null;
        let longest = 0;
        for (const h of this.highways) {
            let length = 0;
            for (let i = 0; i < h.length - 1; i++) length += h[i].distanceTo(h[i + 1]);
            if (length > longest) {
                longest = length;
                this.divider = h;
            }
        }
        if (this.divider === null) return;

        let balance = 0;
        for (const c of this.industrialCentres) balance += this.sideOfDivider(c);
        this.dividerSide = balance !== 0 ? Math.sign(balance) : (Math.random() < 0.5 ? 1 : -1);
    }

    /**
     * The well off end up as far from the smoke as they can get, preferably with a view of the water
     */
    private pickAffluentCentre(): void {
        const R = this.params.industrialSize;
        let best = -Infinity;
        for (let i = 0; i < 300; i++) {
            const c = new Vector(Math.random(), Math.random()).multiply(this.worldDimensions).add(this.origin);
            if (!this.inner(c, 0.1) || !this.tensorField.onLand(c)) continue;
            let score = 0;
            for (const ic of this.industrialCentres) score += Math.min(4, ic.distanceTo(c) / R);
            if (this.divider !== null && this.sideOfDivider(c) === this.dividerSide) score -= 2;
            score += 1.5 * Math.exp(-this.waterDistance(c) / 200);
            score += 0.5 * Math.random();
            if (score > best) {
                best = score;
                this.affluentCentre = c;
            }
        }
    }

    /**
     * 1 or -1 depending on which side of the divider point is
     */
    private sideOfDivider(p: Vector): number {
        const line = this.divider;
        let best = 0;
        let bestDistance = Infinity;
        for (let i = 0; i < line.length - 1; i++) {
            const d = PolygonUtil.distanceToSegment(p, line[i], line[i + 1]);
            if (d < bestDistance) {
                bestDistance = d;
                best = i;
            }
        }
        const a = line[best];
        const b = line[best + 1];
        return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= 0 ? 1 : -1;
    }

    private waterDistance(p: Vector): number {
        let min = Infinity;
        for (const w of this.waterfront) min = Math.min(min, PolygonUtil.distanceToPolyline(p, w));
        return min;
    }

    private nearestIndustry(p: Vector): number {
        const R = this.params.industrialSize;
        const wobble = 1 + 0.35 * this.noise.noise2D(p.x / 180, p.y / 180);
        let nearest = Infinity;
        for (const c of this.industrialCentres) {
            nearest = Math.min(nearest, c.distanceTo(p) / (R * wobble));
        }
        return nearest;
    }

    /**
     * How much people would pay to live at p, on no particular scale
     * Only the order matters, it is ranked across all districts to give income
     */
    private desirability(p: Vector): number {
        let score = 0;

        // Nobody who can afford not to lives next to industry
        const industry = this.nearestIndustry(p);
        if (industry < Infinity) score -= 1.3 * Math.exp(-Math.max(0, industry - 1) / 1.4);

        // Or next to the freeway
        const i = this.cellIndex(p);
        const highway = i < 0 ? Infinity : this.highwayDistance[i];
        if (highway < Infinity) score -= 0.5 * Math.exp(-highway / 120);

        // The freeway divides the city, and the side with the industry is the poorer one
        if (this.divider !== null) {
            const side = this.sideOfDivider(p) === this.dividerSide ? -1 : 1;
            score += 0.35 * side * Math.min(1, (0.3 + highway / 400));
        }

        // Water views
        score += 0.55 * Math.exp(-this.waterDistance(p) / 180);

        // The well off side of town
        if (this.affluentCentre !== null) {
            const size = Math.max(this.worldDimensions.x, this.worldDimensions.y);
            score += 0.8 * Math.exp(-this.affluentCentre.distanceTo(p) / (0.3 * size));
        }

        // Neighbourhoods that are just more or less fashionable
        score += 0.3 * this.noise.noise2D(p.x / 700 + 100, p.y / 700 - 100);
        return score;
    }

    /**
     * Ranks desirability against the city's residential land, then bends the ranking so that the
     * share of low income housing matches lowIncomeAmount
     */
    private toIncome(desirability: number): number {
        const ranked = this.rankedDesirability;
        const share = this.rankedShare;
        const n = ranked.length;
        if (n === 0) return 0.5;
        let rank: number;
        if (desirability <= ranked[0]) rank = share[0];
        else if (desirability >= ranked[n - 1]) rank = share[n - 1];
        else {
            let lo = 0, hi = n - 1;
            while (hi - lo > 1) {
                const mid = (lo + hi) >> 1;
                if (ranked[mid] <= desirability) lo = mid; else hi = mid;
            }
            const t = (desirability - ranked[lo]) / Math.max(1e-9, ranked[hi] - ranked[lo]);
            rank = share[lo] + t * (share[hi] - share[lo]);
        }

        const line = Zoning.LOW_INCOME_LINE;
        const lowShare = 0.6 * this.params.lowIncomeAmount;
        if (lowShare <= 0.005) return line + (1 - line) * rank;
        // rank ^ gamma falls below the line for exactly lowShare of the districts
        const gamma = Math.log(line) / Math.log(lowShare);
        return Math.pow(rank, gamma);
    }

    /**
     * Zone of a single point, before snapping to districts
     */
    private pointZone(p: Vector): Zone {
        return this.nearestIndustry(p) < 1 ? Zone.Industrial : Zone.Residential;
    }

    private rasteriseZones(districtPolygons: Vector[][]): void {
        this.zones = new Uint8Array(this.cols * this.rows);
        this.districtCells = new Int32Array(this.cols * this.rows).fill(-1);
        for (let y = 0; y < this.rows; y++) {
            for (let x = 0; x < this.cols; x++) {
                this.zones[y * this.cols + x] = this.pointZone(this.cellCentre(x, y));
            }
        }

        this._districts = districtPolygons.map(polygon => {
            const centre = PolygonUtil.averagePoint(polygon);
            return {polygon, centre, industrial: this.pointZone(centre) === Zone.Industrial, income: 0.5};
        });
        this.districtBoxes = districtPolygons.map(d => PolygonUtil.boundingBox(d));
        this.industrialDistricts = [];
        this.industrialDistrictBoxes = [];

        // Each district has its own character on top of the land it sits on
        const residential = this._districts.filter(d => !d.industrial);
        const desirability = residential.map(d => this.desirability(d.centre) + 0.25 * (Math.random() - 0.5));
        // Ranked by area, so that big districts count for more than small ones
        const order = residential.map((_, i) => i).sort((a, b) => desirability[a] - desirability[b]);
        const areas = residential.map(d => PolygonUtil.calcPolygonArea(d.polygon));
        const total = areas.reduce((a, b) => a + b, 0) || 1;
        let below = 0;
        this.rankedDesirability = [];
        this.rankedShare = [];
        for (const i of order) {
            this.rankedDesirability.push(desirability[i]);
            this.rankedShare.push((below + areas[i] / 2) / total);
            below += areas[i];
        }
        residential.forEach((d, i) => d.income = this.toIncome(desirability[i]));

        this._districts.forEach((d, k) => {
            const zone = d.industrial ? Zone.Industrial :
                d.income < Zoning.LOW_INCOME_LINE ? Zone.LowIncome : Zone.Residential;
            this.forCellsInPolygon(d.polygon, 0, i => {
                this.zones[i] = zone;
                this.districtCells[i] = k;
            });
            if (d.industrial) {
                this.industrialDistricts.push(d.polygon);
                this.industrialDistrictBoxes.push(this.districtBoxes[k]);
            }
        });

        const counts = INCOME_BANDS.map(() => 0);
        for (const d of residential) counts[INCOME_BANDS.findIndex(b => d.income <= b.max)]++;
        log.info(`Zoning: ${this.industrialCentres.length} industrial centres, ${this.industrialDistricts.length} industrial districts, ` +
            `residential districts by income ${INCOME_BANDS.map((b, i) => `${b.name} ${counts[i]}`).join(', ')}`);
    }
}
