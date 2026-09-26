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


export interface BuildingModel {
    height: number;
    lotWorld: Vector[]; // In world space
    lotScreen: Vector[]; // In screen space
    roof: Vector[]; // In screen space
    sides: Vector[][]; // In screen space
    zone: Zone;
}

/**
 * Building height range for each zone
 */
const HEIGHTS: {[zone: number]: {min: number; max: number}} = {
    // World units, 1 unit = 2 m
    [Zone.Residential]: {min: 3.5, max: 6},
    [Zone.LowIncome]: {min: 3, max: 4.5},
    [Zone.Industrial]: {min: 4.5, max: 7},
};

/**
 * Pseudo 3D buildings
 */
class BuildingModels {
    private static readonly HEIGHT_EXAGGERATION = 5;
    private domainController = DomainController.getInstance();
    private _buildingModels: BuildingModel[] = [];

    constructor(lots: Vector[][], zones: Zone[]) {  // Lots in world space
        for (let i = 0; i < lots.length; i++) {
            const range = HEIGHTS[zones[i]];
            this._buildingModels.push({
                height: Math.random() * (range.max - range.min) + range.min,
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
     * Recalculated when the camera moves
     */
    setBuildingProjections(): void {
        const d = 1000 / this.domainController.zoom;
        const cameraPos = this.domainController.getCameraPosition();
        for (const b of this._buildingModels) {
            b.lotScreen = b.lotWorld.map(v => this.domainController.worldToScreen(v.clone()));
            // Real heights look flat from this far up, exaggerate them for the pseudo 3D view
            b.roof = b.lotScreen.map(v => this.heightVectorToScreen(v, b.height * BuildingModels.HEIGHT_EXAGGERATION, d, cameraPos));
            b.sides = this.getBuildingSides(b);
        }
    }

    private heightVectorToScreen(v: Vector, h: number, d: number, camera: Vector): Vector {
        const scale = (d / (d - h)); // 0.1
        if (this.domainController.orthographic) {
            const diff = this.domainController.cameraDirection.multiplyScalar(-h * scale);
            return v.clone().add(diff);
        } else {
            return v.clone().sub(camera).multiplyScalar(scale).add(camera);
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
    private zoneBlocks: Vector[][][] = [[], [], []];  // Indexed by Zone, world space
    private industrialBuildings: Vector[][] = [];  // Warehouses, tanks and port buildings
    private industrialRoads: Vector[][] = [];  // Service roads through industrial blocks
    private portBuildings: Vector[][] = [];
    private residentialHouses: Vector[][] = [];
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

    get models(): BuildingModel[] {
        this._models.setBuildingProjections();
        return this._models.buildingModels;
    }

    setAllStreamlines(s: Vector[][]): void {
        this.allStreamlines = s;
    }

    reset(): void {
        for (const f of this.polygonFinders) f.reset();
        this.zoneBlocks = [[], [], []];
        this.industrialBuildings = [];
        this.industrialRoads = [];
        this.residentialHouses = [];
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
        this.polygonFinders = this.createPolygonFinders();
        for (const zone of [Zone.Residential, Zone.LowIncome]) {
            this.polygonFinders[zone].setPolygons(this.zoneBlocks[zone]);
        }

        await Promise.all(this.polygonFinders.map(f => f.shrink(animate)));
        await Promise.all(this.polygonFinders.map(f => f.divide(animate)));
        this.layoutIndustry();
        // Houses sit in rows of lots along each block, like a real street grid
        this.residentialHouses = YardHouseLayout.layoutBlocks(this.shrunkBlocks(Zone.Residential), YardHouseLayout.TIDY).houses;
        const yards = YardHouseLayout.layoutBlocks(this.shrunkBlocks(Zone.LowIncome), YardHouseLayout.RUN_DOWN);
        this.lowIncomeHouses = yards.houses;
        this.lowIncomeFences = yards.fences;
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
        this._models = new BuildingModels(lots, zones);

        this.postGenerateCallback();
    }

    /**
     * Cuts highway verges and interchanges out of blocks, then sorts blocks by zone
     */
    private zoneAndClipBlocks(blocks: Vector[][]): Vector[][][] {
        const out: Vector[][][] = [[], [], []];
        const zoned = this.zoning !== null && this.zoning.enabled;

        // Blocks are only tested for water at their centre, so cut away any water they overlap
        const exclusions = [this.tensorField.sea, this.tensorField.river].filter(w => w.length >= 3);
        if (zoned) exclusions.push(...this.zoning.exclusionAreas);
        const exclusionBoxes = exclusions.map(e => PolygonUtil.boundingBox(e));

        for (const block of blocks) {
            const box = PolygonUtil.boundingBox(block);
            const holes = exclusions.filter((e, i) => PolygonUtil.boundingBoxesOverlap(box, exclusionBoxes[i]));
            const pieces = holes.length === 0 ? [block] : PolygonUtil.subtractPolygons(block, holes, this.lowIncomeParams.minArea);
            for (const piece of pieces) {
                const zone = zoned ? this.zoning.zoneAt(PolygonUtil.averagePoint(piece)) : Zone.Residential;
                out[zone].push(piece);
            }
        }
        return out;
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

    setPreGenerateCallback(callback: () => any): void {
        this.preGenerateCallback = callback;
    }

    setPostGenerateCallback(callback: () => any): void {
        this.postGenerateCallback = callback;
    }
}
