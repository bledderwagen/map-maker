import * as log from 'loglevel';
import DomainController from './domain_controller';
import TensorField from '../impl/tensor_field';
import Graph from '../impl/graph';
import Vector from '../vector';
import PolygonFinder from '../impl/polygon_finder';
import {PolygonParams} from '../impl/polygon_finder';
import PolygonUtil from '../impl/polygon_util';
import Zoning, {Zone} from '../impl/zoning';
import IndustrialLayout, {IndustrialParams} from '../impl/industrial_layout';
import YardHouseLayout from '../impl/yard_houses';
import * as SimplexNoise from 'simplex-noise';
import BuildingCleanup, {RoadClearance} from '../impl/building_cleanup';
import CommercialLayout, {SiteBuildingKind, SiteLayout} from '../impl/commercial_layout';


export interface BuildingModel {
    height: number;
    lotWorld: Vector[]; // In world space
    lotScreen: Vector[]; // In screen space
    roof: Vector[]; // In screen space
    sides: Vector[][]; // In screen space
    zone: Zone;
}

/**
 * Fixed height ranges for buildings of a known kind, world units (1 unit = 2 m)
 */
const MALL_HEIGHT = {min: 5, max: 7};
const APARTMENT_HEIGHT = {min: 5.5, max: 6.8};  // Three storeys
const RETAIL_HEIGHT = {min: 2.8, max: 3.5};

/**
 * Real heights look flat from as high up as the pseudo 3D camera, so it draws them this much taller
 */
export const HEIGHT_EXAGGERATION = 2;

/**
 * Pseudo 3D buildings
 */
class BuildingModels {
    private static readonly STOREY = 1.5;  // World units, 1 unit = 2 m
    private static readonly ROOF = 0.75;
    private domainController = DomainController.getInstance();
    private _buildingModels: BuildingModel[] = [];
    // Some neighbourhoods are built up more than others
    private densityNoise = new SimplexNoise();

    /**
     * @param lots world space
     * @param ranges height range of each lot of a known kind, else picked by buildingHeight
     */
    constructor(lots: Vector[][], zones: Zone[], ranges: {min: number; max: number}[] = []) {
        for (let i = 0; i < lots.length; i++) {
            const range = ranges[i];
            this._buildingModels.push({
                height: range ? Math.random() * (range.max - range.min) + range.min : this.buildingHeight(lots[i], zones[i]),
                lotWorld: lots[i],
                lotScreen: [],
                roof: [],
                sides: [],
                zone: zones[i],
            });
        }
        this._buildingModels.sort((a, b) => a.height - b.height);
    }

    get buildingModels(): BuildingModel[] {
        return this._buildingModels;
    }

    /**
     * World space height from storeys: mostly one or two storey houses, built up more in denser
     * neighbourhoods and on bigger footprints, with the odd tall block. Sheds are a single tall storey.
     */
    private buildingHeight(lot: Vector[], zone: Zone): number {
        const area = PolygonUtil.calcPolygonArea(lot);
        const c = PolygonUtil.averagePoint(lot);
        const density = (this.densityNoise.noise2D(c.x / 700, c.y / 700) + 1) / 2;
        const storeys = (n: number): number => n * BuildingModels.STOREY + BuildingModels.ROOF * Math.random();

        if (zone === Zone.Industrial) {
            // Tanks and huts are low, big sheds a little taller
            if (area < 60) return 1.5 + 1.5 * Math.random();
            return 3 + Math.min(2, area / 500) + Math.random();
        }

        if (zone === Zone.LowIncome) return storeys(Math.random() < 0.75 ? 1 : 2);

        // Apartment blocks and the odd tower where the neighbourhood is dense
        // House footprints are mostly 20-60 units, merged neighbours up to about 100
        const dense = Math.max(0, density - 0.5) / 0.5;
        if (area > 40 && Math.random() < 0.04 * dense) return storeys(6 + Math.floor(Math.random() * 9));
        if (area > 55) return storeys(2 + Math.floor(Math.random() * (1 + 3 * density)));

        let n = Math.random() < 0.6 ? 2 : 1;
        if (Math.random() < density * density) n++;
        return storeys(n);
    }

    /**
     * Recalculated when the camera moves
     */
    setBuildingProjections(): void {
        for (const b of this._buildingModels) {
            b.lotScreen = b.lotWorld.map(v => this.domainController.worldToScreen(v.clone()));
            // Real heights look flat from this far up, exaggerate them for the pseudo 3D view
            b.roof = b.lotScreen.map(v => this.domainController.heightToScreen(v, b.height * HEIGHT_EXAGGERATION));
            b.sides = this.getBuildingSides(b);
        }
    }

    /**
     * Get sides of buildings by joining corresponding edges between the roof and ground
     */
    private getBuildingSides(b: BuildingModel): Vector[][] {
        const polygons: Vector[][] = [];
        for (let i = 0; i < b.lotScreen.length; i++) {
            const next = (i + 1) % b.lotScreen.length;
            polygons.push([b.lotScreen[i], b.lotScreen[next], b.roof[next], b.roof[i]]);
        }
        return polygons;
    }
}

/**
 * Finds building lots and optionally pseudo3D buildings
 * Each block is given a zone, which decides how it is divided up
 */
export default class Buildings {
    private readonly BLOCK_MAX_LENGTH = 1000;  // Blocks next to smoothed highways or with many side streets have many sides

    // One polygon finder per zone, indexed by Zone
    private polygonFinders: PolygonFinder[];
    private allStreamlines: Vector[][] = [];
    private domainController = DomainController.getInstance();
    private preGenerateCallback: () => any = () => {};
    private postGenerateCallback: () => any = () => {};
    private _models: BuildingModels = new BuildingModels([], []);
    private _blocks: Vector[][] = [];
    private zoneBlocks: Vector[][][] = [[], [], [], []];  // Indexed by Zone, world space
    private apartmentBlocks: Vector[][] = [];
    private sites: SiteLayout[] = [];  // Mall and apartment complexes
    private siteBuildings: {polygon: Vector[]; kind: SiteBuildingKind}[] = [];
    private arterials: Vector[][] = [];  // Main and major roads, apartments line them
    private industrialBuildings: Vector[][] = [];  // Warehouses, tanks and port buildings
    private industrialRoads: Vector[][] = [];  // Service roads through industrial blocks
    private portBuildings: Vector[][] = [];
    private residentialHouses: Vector[][] = [];
    private shore: Vector[] = [];
    private shoreBeach: number[] = [];
    private beaches: Vector[][] = [];
    private waterfrontNoise = new SimplexNoise();
    private roadClearance: RoadClearance[] = [];
    private _waterfrontParks: Vector[][] = [];
    private lowIncomeHouses: Vector[][] = [];
    private lowIncomeFences: Vector[][] = [];
    private zoning: Zoning = null;

    private buildingParams: PolygonParams = {
        maxLength: 20,
        minArea: 105,  // Lots of roughly 400-800 m2, 1 unit = 2 m
        shrinkSpacing: 4,
        chanceNoDivide: 0.05,
    };

    // Small houses, each in its own fenced yard
    private lowIncomeParams: PolygonParams = {
        maxLength: 20,
        minArea: 100,
        shrinkSpacing: 3,
        chanceNoDivide: 0,
    };

    private industrialParams: IndustrialParams = {
        setback: 9,
        parcelWidth: 38,
        parcelDepth: 32,
    };
    private readonly TANK_FARM_CHANCE = 0.05;

    constructor(private tensorField: TensorField,
                folder: dat.GUI,
                private redraw: () => void,
                private dstep: number,
                private _animate: boolean) {
        folder.add({'AddBuildings': () => this.generate(this._animate)}, 'AddBuildings');
        folder.add(this.buildingParams, 'minArea');
        folder.add(this.buildingParams, 'shrinkSpacing');
        folder.add(this.buildingParams, 'chanceNoDivide');
        folder.add(this.lowIncomeParams, 'minArea').name('lowIncomeLotArea');
        folder.add(this.industrialParams, 'parcelWidth').name('industrialParcelWidth');
        folder.add(this.industrialParams, 'setback').name('industrialSetback');
        this.polygonFinders = this.createPolygonFinders();
    }

    set animate(v: boolean) {
        this._animate = v;
    }

    setWaterfront(shore: Vector[], beachWidths: number[], beaches: Vector[][]): void {
        this.shore = shore;
        this.shoreBeach = beachWidths;
        this.beaches = beaches;
    }

    /**
     * Blocks by the sea kept as parks, world space
     */
    get waterfrontParks(): Vector[][] {
        return this._waterfrontParks;
    }

    /**
     * Roads and their widths, buildings touching them are removed
     */
    setRoadClearance(roads: RoadClearance[]): void {
        this.roadClearance = roads;
    }

    setZoning(zoning: Zoning): void {
        this.zoning = zoning;
    }

    get lots(): Vector[][] {
        // Until houses are placed, show the plain lots so animation still works
        if (this.residentialHouses.length === 0) return this.toScreen(this.polygonFinders[Zone.Residential].polygons);
        return this.toScreen(this.residentialHouses);
    }

    get lowIncomeLots(): Vector[][] {
        // Until the yards are laid out, show the plain lots so animation still works
        if (this.lowIncomeFences.length === 0) return this.toScreen(this.polygonFinders[Zone.LowIncome].polygons);
        return this.toScreen(this.lowIncomeHouses);
    }

    get lowIncomeFenceLines(): Vector[][] {
        return this.toScreen(this.lowIncomeFences);
    }

    get industrialLots(): Vector[][] {
        return this.toScreen(this.industrialBuildings);
    }

    get industrialServiceRoads(): Vector[][] {
        return this.toScreen(this.industrialRoads);
    }

    /**
     * World space service roads, for including in the road graph
     */
    get industrialServiceRoadsWorld(): Vector[][] {
        return this.industrialRoads;
    }

    /**
     * Port buildings are placed by zoning, but drawn and modelled with the rest
     */
    setPortBuildings(buildings: Vector[][]): void {
        this.portBuildings = buildings;
    }

    get lowIncomeBlocks(): Vector[][] {
        return this.toScreen(this.zoneBlocks[Zone.LowIncome]);
    }

    /**
     * All housing, low income included
     */
    get residentialBlocks(): Vector[][] {
        return this.toScreen(this.zoneBlocks[Zone.Residential].concat(this.zoneBlocks[Zone.LowIncome]));
    }

    get industrialBlocks(): Vector[][] {
        return this.toScreen(this.zoneBlocks[Zone.Industrial]);
    }

    private toScreen(polygons: Vector[][]): Vector[][] {
        return polygons.map(p => p.map(v => this.domainController.worldToScreen(v.clone())));
    }

    private createPolygonFinders(): PolygonFinder[] {
        const finders: PolygonFinder[] = [];
        finders[Zone.Residential] = new PolygonFinder([], this.buildingParams, this.tensorField);
        finders[Zone.LowIncome] = new PolygonFinder([], this.lowIncomeParams, this.tensorField);
        // Industrial blocks are laid out by IndustrialLayout instead
        finders[Zone.Industrial] = new PolygonFinder([], this.buildingParams, this.tensorField);
        return finders;
    }

    /**
     * Only used when creating the 3D model to 'fake' the roads
     */
    getBlocks(): Promise<Vector[][]> {
        const g = new Graph(this.allStreamlines, this.dstep, true);
        const blockParams = Object.assign({}, this.buildingParams);
        blockParams.shrinkSpacing = blockParams.shrinkSpacing/2;
        const polygonFinder = new PolygonFinder(g.nodes, blockParams, this.tensorField);
        polygonFinder.findPolygons();
        return polygonFinder.shrink(false).then(() => polygonFinder.polygons.map(p => p.map(v => this.domainController.worldToScreen(v.clone()))));
    }

    /**
     * Everything an exporter needs, in world space
     */
    get exportData(): {
        houses: Vector[][]; lowIncomeHouses: Vector[][]; industrial: Vector[][]; port: Set<Vector[]>;
        residentialBlocks: Vector[][]; lowIncomeBlocks: Vector[][]; industrialBlocks: Vector[][];
        heights: Map<Vector[], number>;  // World units
        siteBuildings: {polygon: Vector[]; kind: SiteBuildingKind}[]; sites: SiteLayout[];
        retailBlocks: Vector[][]; apartmentBlocks: Vector[][];
    } {
        const heights = new Map<Vector[], number>();
        for (const m of this._models.buildingModels) heights.set(m.lotWorld, m.height);
        return {
            houses: this.residentialHouses,
            lowIncomeHouses: this.lowIncomeHouses,
            industrial: this.industrialBuildings,
            port: new Set(this.portBuildings),
            residentialBlocks: this.zoneBlocks[Zone.Residential],
            lowIncomeBlocks: this.zoneBlocks[Zone.LowIncome],
            industrialBlocks: this.zoneBlocks[Zone.Industrial],
            heights,
            siteBuildings: this.siteBuildings,
            sites: this.sites,
            retailBlocks: this.zoneBlocks[Zone.Commercial],
            apartmentBlocks: this.apartmentBlocks,
        };
    }

    get models(): BuildingModel[] {
        this._models.setBuildingProjections();
        return this._models.buildingModels;
    }

    setAllStreamlines(s: Vector[][]): void {
        this.allStreamlines = s;
    }

    reset(): void {
        for (const f of this.polygonFinders) f.reset();
        this.zoneBlocks = [[], [], [], []];
        this.apartmentBlocks = [];
        this.sites = [];
        this.siteBuildings = [];
        this.industrialBuildings = [];
        this.industrialRoads = [];
        this.residentialHouses = [];
        this._waterfrontParks = [];
        this.waterfrontNoise = new SimplexNoise();
        this.lowIncomeHouses = [];
        this.lowIncomeFences = [];
        this._models = new BuildingModels([], []);
    }

    update(): boolean {
        let changed = false;
        for (const f of this.polygonFinders) {
            if (f.update()) changed = true;
        }
        return changed;
    }

    /**
     * Finds blocks, assigns each a zone, then shrinks and divides them to create building lots
     */
    async generate(animate: boolean): Promise<void> {
        this.preGenerateCallback();
        this.reset();
        const g = new Graph(this.allStreamlines, this.dstep, true);

        const blockParams = Object.assign({}, this.buildingParams);
        blockParams.maxLength = Math.max(blockParams.maxLength, this.BLOCK_MAX_LENGTH);
        const blockFinder = new PolygonFinder(g.nodes, blockParams, this.tensorField);
        blockFinder.findPolygons();

        this.zoneBlocks = this.zoneAndClipBlocks(blockFinder.polygons);
        this.pickApartmentBlocks();
        this.polygonFinders = this.createPolygonFinders();
        for (const zone of [Zone.Residential, Zone.LowIncome]) {
            this.polygonFinders[zone].setPolygons(this.zoneBlocks[zone]);
        }

        await Promise.all(this.polygonFinders.map(f => f.shrink(animate)));
        await Promise.all(this.polygonFinders.map(f => f.divide(animate)));
        this.layoutIndustry();
        this.layoutSites();
        // Houses sit in rows of lots along each block, like a real street grid
        this.residentialHouses = YardHouseLayout.layoutBlocks(this.shrunkBlocks(Zone.Residential), YardHouseLayout.TIDY).houses;
        const yards = YardHouseLayout.layoutBlocks(this.shrunkBlocks(Zone.LowIncome), YardHouseLayout.RUN_DOWN);
        this.lowIncomeHouses = yards.houses;
        this.lowIncomeFences = yards.fences;

        // Nothing on the roads, and overlapping buildings either merged or removed
        const roads = this.roadClearance.concat(this.industrialRoads.map(line => ({line, halfWidth: 2.25})));
        const tidy = (buildings: Vector[][]): Vector[][] =>
            BuildingCleanup.resolveOverlaps(BuildingCleanup.clearRoads(buildings, roads));
        this.residentialHouses = tidy(this.residentialHouses);
        this.lowIncomeHouses = tidy(this.lowIncomeHouses);
        const port = new Set(this.portBuildings);
        this.industrialBuildings = this.portBuildings.concat(
            tidy(this.industrialBuildings.filter(b => !port.has(b))));
        const kept = new Set(BuildingCleanup.clearRoads(this.siteBuildings.map(b => b.polygon), roads));
        this.siteBuildings = this.siteBuildings.filter(b => kept.has(b.polygon));
        this.redraw();

        const lots: Vector[][] = [];
        const zones: Zone[] = [];
        const addLots = (polygons: Vector[][], zone: Zone) => {
            lots.push(...polygons);
            for (let i = 0; i < polygons.length; i++) zones.push(zone);
        };
        addLots(this.residentialHouses, Zone.Residential);
        addLots(this.lowIncomeHouses, Zone.LowIncome);
        addLots(this.industrialBuildings, Zone.Industrial);
        const ranges: {min: number; max: number}[] = [];
        for (const b of this.siteBuildings) {
            ranges[lots.length] = b.kind === 'apartments' ? APARTMENT_HEIGHT : b.kind === 'retail' ? RETAIL_HEIGHT : MALL_HEIGHT;
            lots.push(b.polygon);
            zones.push(b.kind === 'apartments' ? Zone.Residential : Zone.Commercial);
        }
        this._models = new BuildingModels(lots, zones, ranges);

        this.postGenerateCallback();
    }

    /**
     * Cuts highway verges and interchanges out of blocks, then sorts blocks by zone
     */
    private zoneAndClipBlocks(blocks: Vector[][]): Vector[][][] {
        const out: Vector[][][] = [[], [], [], []];
        const zoned = this.zoning !== null && this.zoning.enabled;

        // Blocks are only tested for water at their centre, so cut away any water they overlap
        const exclusions = [this.tensorField.sea, this.tensorField.river].concat(this.beaches).filter(w => w.length >= 3);
        if (zoned) exclusions.push(...this.zoning.exclusionAreas);
        const exclusionBoxes = exclusions.map(e => PolygonUtil.boundingBox(e));

        for (const block of blocks) {
            const box = PolygonUtil.boundingBox(block);
            const holes = exclusions.filter((e, i) => PolygonUtil.boundingBoxesOverlap(box, exclusionBoxes[i]));
            const pieces = holes.length === 0 ? [block] : PolygonUtil.subtractPolygons(block, holes, this.lowIncomeParams.minArea);
            for (const piece of pieces) {
                const zone = zoned ? this.zoning.zoneAt(PolygonUtil.averagePoint(piece)) : Zone.Residential;
                if (zone !== Zone.Industrial && zone !== Zone.Commercial && this.becomesWaterfrontPark(piece)) {
                    this._waterfrontParks.push(piece);
                    continue;
                }
                out[zone].push(piece);
            }
        }
        return out;
    }

    /**
     * Blocks on the water's edge are often kept as parks, nearly always when they have a beach
     */
    private becomesWaterfrontPark(block: Vector[]): boolean {
        if (this.shore.length < 2) return false;
        const box = PolygonUtil.boundingBox(block);
        let touching = false;
        let beach = 0;
        for (let i = 0; i < this.shore.length; i++) {
            const p = this.shore[i];
            if (p.x < box[0] - 4 || p.x > box[2] + 4 || p.y < box[1] - 4 || p.y > box[3] + 4) continue;
            for (const v of block) {
                if (v.distanceToSquared(p) < 36) {
                    touching = true;
                    beach = Math.max(beach, this.shoreBeach[i] || 0);
                    break;
                }
            }
        }
        if (!touching) return false;
        // Decided in long stretches along the shore, not block by block
        const c = PolygonUtil.averagePoint(block);
        const stretch = this.waterfrontNoise.noise2D(c.x / 600, c.y / 600);
        return beach > 6 ? stretch > -0.4 : stretch > 0.35;
    }

    private shrunkBlocks(zone: Zone): Vector[][] {
        const out: Vector[][] = [];
        for (const block of this.zoneBlocks[zone]) {
            const shrunk = PolygonUtil.resizeGeometry(block, -this.buildingParams.shrinkSpacing);
            if (shrunk.length > 3 && shrunk[0].equals(shrunk[shrunk.length - 1])) shrunk.pop();
            if (shrunk.length >= 3) out.push(shrunk);
        }
        return out;
    }

    /**
     * Regular fenced parcels with service roads, plus the port if there is one
     */
    private layoutIndustry(): void {
        this.industrialBuildings = this.portBuildings.slice();
        this.industrialRoads = [];
        for (const block of this.zoneBlocks[Zone.Industrial]) {
            let layout = IndustrialLayout.layoutBlock(block, this.industrialParams, this.TANK_FARM_CHANCE);
            if (layout.buildings.length === 0) {
                // Small blocks can't afford the full setback, but shouldn't be left empty
                const tight = Object.assign({}, this.industrialParams, {setback: 0.6 * this.industrialParams.setback});
                layout = IndustrialLayout.layoutBlock(block, tight, this.TANK_FARM_CHANCE);
            }
            this.industrialBuildings.push(...layout.buildings);
            this.industrialRoads.push(...layout.roads);
        }
    }

    /**
     * Main and major roads, apartment complexes go along them
     */
    setArterials(lines: Vector[][]): void {
        this.arterials = lines;
    }

    /**
     * Some housing blocks become apartment complexes: most of those near the mall,
     * some along the main roads. Only blocks of a sensible size for one development
     */
    private pickApartmentBlocks(): void {
        const mall = this.zoning !== null && this.zoning.enabled ? this.zoning.commercialCentre : null;
        const keep: Vector[][] = [];
        for (const block of this.zoneBlocks[Zone.Residential]) {
            const area = PolygonUtil.calcPolygonArea(block);
            const c = PolygonUtil.averagePoint(block);
            let chance = 0;
            if (area > 1800 && area < 14000) {
                const nearMall = mall !== null && c.distanceTo(mall) < 520;
                const halfWidth = Math.sqrt(area) / 2;
                const onArterial = this.arterials.some(l => l.length >= 2 && PolygonUtil.distanceToPolyline(c, l) < halfWidth + 10);
                if (nearMall) chance = 0.35;
                else if (onArterial) chance = 0.08;
            }
            if (Math.random() < chance) this.apartmentBlocks.push(block);
            else keep.push(block);
        }
        this.zoneBlocks[Zone.Residential] = keep;
    }

    /**
     * The mall goes on the biggest commercial block, strip malls on any others
     */
    private layoutSites(): void {
        this.sites = [];
        const commercial = this.zoneBlocks[Zone.Commercial].slice()
            .sort((a, b) => PolygonUtil.calcPolygonArea(b) - PolygonUtil.calcPolygonArea(a));
        for (const block of commercial) this.sites.push(CommercialLayout.mall(block));
        for (const block of this.apartmentBlocks) this.sites.push(CommercialLayout.apartments(block));
        this.siteBuildings = [];
        for (const site of this.sites) this.siteBuildings.push(...site.buildings);
    }

    get siteLots(): Vector[][] {
        return this.toScreen(this.siteBuildings.map(b => b.polygon));
    }

    get parkingLots(): Vector[][] {
        return this.toScreen([].concat(...this.sites.map(s => s.parking)));
    }

    get parkingAisles(): Vector[][] {
        return this.toScreen([].concat(...this.sites.map(s => s.aisles)));
    }

    get pools(): Vector[][] {
        return this.toScreen([].concat(...this.sites.map(s => s.pools)));
    }

    get retailBlocks(): Vector[][] {
        return this.toScreen(this.zoneBlocks[Zone.Commercial]);
    }

    get apartmentAreas(): Vector[][] {
        return this.toScreen(this.apartmentBlocks);
    }

    /**
     * World space centre of each site and whether it's the mall, for names
     */
    get siteCentres(): {at: Vector; kind: SiteLayout['kind']}[] {
        // Only complexes big enough to be worth naming
        return this.sites.filter(s => s.kind === 'mall' || s.kind === 'strip_mall' || s.buildings.length >= 5)
            .map(s => ({at: s.centre, kind: s.kind}));
    }

    setPreGenerateCallback(callback: () => any): void {
        this.preGenerateCallback = callback;
    }

    setPostGenerateCallback(callback: () => any): void {
        this.postGenerateCallback = callback;
    }
}
