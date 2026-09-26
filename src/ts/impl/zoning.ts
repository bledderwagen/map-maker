import * as log from 'loglevel';
import * as SimplexNoise from 'simplex-noise';
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
    lowIncomeAmount: number;  // 0-1, how far low income housing spreads from industry and highways
    highwayBuffer: number;  // Distance from highway centreline where building lots are cut off
}

/**
 * Decides land use across the map
 *
 * Industry is placed at highway interchanges and on the waterfront (ports)
 * Low income housing surrounds industry and lines the highways
 *
 * Zones are first picked per point, then snapped to whole districts (areas enclosed by main
 * and major roads) so that zone edges follow streets
 * Results are cached in a raster so lookups during road integration are cheap
 */
export default class Zoning {
    private readonly CELL_SIZE = 4;
    private readonly HIGHWAY_RANGE = 250;  // Beyond this distance to a highway we don't care

    private noise = new SimplexNoise();

    private origin = Vector.zeroVector();
    private cols = 0;
    private rows = 0;
    private zones: Uint8Array = new Uint8Array(0);
    private highwayDistance: Float32Array = new Float32Array(0);
    private interchangeCells: Uint8Array = new Uint8Array(0);

    private highways: Vector[][] = [];
    private interchangeAreas: Vector[][] = [];
    private industrialDistricts: Vector[][] = [];
    private industrialDistrictBoxes: number[][] = [];
    private districtBoxes: number[][] = [];
    private districts: Vector[][] = [];

    public industrialCentres: Vector[] = [];

    // Low income housing is kept to one side of this highway, the 'wrong side of the freeway'
    private divider: Vector[] = null;
    private dividerSide = 1;

    constructor(public params: ZoningParams, private tensorField: TensorField) {}

    get enabled(): boolean {
        return this.cols > 0;
    }

    reset(): void {
        this.cols = 0;
        this.rows = 0;
        this.highways = [];
        this.interchangeAreas = [];
        this.industrialCentres = [];
        this.districts = [];
        this.districtBoxes = [];
        this.industrialDistricts = [];
        this.industrialDistrictBoxes = [];
        this.divider = null;
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
        this.cols = Math.ceil(worldDimensions.x / this.CELL_SIZE) + 1;
        this.rows = Math.ceil(worldDimensions.y / this.CELL_SIZE) + 1;
        this.highways = highways;
        this.interchangeAreas = interchanges.map(i => i.area);

        this.computeHighwayDistances();
        this.computeInterchangeCells();
        this.pickIndustrialCentres(origin, worldDimensions, interchanges.map(i => i.centre), waterfront, portCentre);
        this.pickDivider();
        this.rasteriseZones([]);
    }

    /**
     * Called once main and major roads exist
     * Each district (polygon enclosed by larger roads) gets the zone at its centre
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
        for (let i = 0; i < this.districts.length; i++) {
            const box = this.districtBoxes[i];
            if (point.x < box[0] || point.y < box[1] || point.x > box[2] || point.y > box[3]) continue;
            if (PolygonUtil.insidePolygon(point, this.districts[i])) return true;
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

    /**
     * Industry wants highway access
     * Waterfront land is too valuable for anything but a port, so other industry keeps away from it
     */
    private pickIndustrialCentres(origin: Vector, worldDimensions: Vector,
                                  interchanges: Vector[], waterfront: Vector[][], portCentre: Vector): void {
        const R = this.params.industrialSize;
        const inner = (v: Vector): boolean => {
            const t = v.clone().sub(origin);
            return t.x > 0.1 * worldDimensions.x && t.x < 0.9 * worldDimensions.x &&
                t.y > 0.1 * worldDimensions.y && t.y < 0.9 * worldDimensions.y;
        };
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

    /**
     * Zone of a single point, before snapping to districts
     */
    private pointZone(p: Vector, highwayDistance: number): Zone {
        const R = this.params.industrialSize;
        const amount = this.params.lowIncomeAmount;
        const wobble = 1 + 0.35 * this.noise.noise2D(p.x / 180, p.y / 180);

        let nearestIndustry = Infinity;
        for (const c of this.industrialCentres) {
            nearestIndustry = Math.min(nearestIndustry, c.distanceTo(p) / (R * wobble));
        }
        if (nearestIndustry < 1) return Zone.Industrial;

        if (amount <= 0) return Zone.Residential;

        if (this.divider !== null) {
            // Only on one side of the freeway, where it forms a solid neighbourhood rather than patches
            if (this.sideOfDivider(p) !== this.dividerSide) return Zone.Residential;
            const patch = this.noise.noise2D(p.x / 300 + 50, p.y / 300 - 50);
            if (patch < -0.7 + 0.4 * (1 - amount)) return Zone.Residential;
            if (nearestIndustry < 1 + 2 * amount) return Zone.LowIncome;
            const band = 350 * amount * (1 + 0.3 * this.noise.noise2D(p.x / 150 - 20, p.y / 150 + 20));
            if (highwayDistance < band) return Zone.LowIncome;
            return Zone.Residential;
        }

        // Patchy rather than a perfect ring
        const patch = this.noise.noise2D(p.x / 260 + 50, p.y / 260 - 50);
        if (patch < -0.55 + 0.3 * (1 - amount)) return Zone.Residential;

        if (nearestIndustry < 1 + 1.3 * amount) return Zone.LowIncome;

        const band = 170 * amount * (1 + 0.5 * this.noise.noise2D(p.x / 120 - 20, p.y / 120 + 20));
        if (highwayDistance < band) return Zone.LowIncome;

        return Zone.Residential;
    }

    private rasteriseZones(districts: Vector[][]): void {
        this.zones = new Uint8Array(this.cols * this.rows);
        for (let y = 0; y < this.rows; y++) {
            for (let x = 0; x < this.cols; x++) {
                const i = y * this.cols + x;
                this.zones[i] = this.pointZone(this.cellCentre(x, y), this.highwayDistance[i]);
            }
        }

        this.districts = districts;
        this.districtBoxes = districts.map(d => PolygonUtil.boundingBox(d));
        this.industrialDistricts = [];
        this.industrialDistrictBoxes = [];

        for (const d of districts) {
            const centre = PolygonUtil.averagePoint(d);
            const centreIndex = this.cellIndex(centre);
            const zone = centreIndex < 0 ?
                this.pointZone(centre, Infinity) :
                this.pointZone(centre, this.highwayDistance[centreIndex]);

            this.forCellsInPolygon(d, 0, i => this.zones[i] = zone);
            if (zone === Zone.Industrial) {
                this.industrialDistricts.push(d);
                this.industrialDistrictBoxes.push(PolygonUtil.boundingBox(d));
            }
        }
        log.info(`Zoning: ${this.industrialCentres.length} industrial centres, ${this.industrialDistricts.length} industrial districts`);
    }
}
