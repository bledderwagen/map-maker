import * as log from 'loglevel';
import DomainController from './domain_controller';
import TensorField from '../impl/tensor_field';
import {RK4Integrator} from '../impl/integrator';
import FieldIntegrator from '../impl/integrator';
import {StreamlineParams} from '../impl/streamlines';
import {WaterParams} from '../impl/water_generator';
import Graph from '../impl/graph';
import RoadGUI from './road_gui';
import WaterGUI from './water_gui';
import Vector from '../vector';
import PolygonFinder from '../impl/polygon_finder';
import {PolygonParams} from '../impl/polygon_finder';
import StreamlineGenerator from '../impl/streamlines';
import WaterGenerator from '../impl/water_generator';
import Style from './style';
import {DefaultStyle, RoughStyle} from './style';
import CanvasWrapper from './canvas_wrapper';
import Buildings, {BuildingModel} from './buildings';
import PolygonUtil from '../impl/polygon_util';
import Util from '../util';
import HighwayGUI from './highway_gui';
import {HighwayParams} from '../impl/highway_generator';
import Zoning, {Zone, ZoningParams} from '../impl/zoning';
import PortPlanner, {Port} from '../impl/port';

/**
 * Handles Map folder, glues together impl
 */
export default class MainGUI {
    private numBigParks: number = 2;
    private numSmallParks: number = 0;
    private clusterBigParks: boolean = false;

    private domainController = DomainController.getInstance();
    private intersections: Vector[] = [];
    private bigParks: Vector[][] = [];
    private smallParks: Vector[][] = [];
    private animate: boolean = true;
    private animationSpeed: number = 30;

    private coastline: WaterGUI;
    private highways: HighwayGUI;
    private mainRoads: RoadGUI;
    private majorRoads: RoadGUI;
    private minorRoads: RoadGUI;
    private buildings: Buildings;
    private zoning: Zoning;
    private port: Port = null;
    private portChance = 0.5;  // Chance that a map with a coast gets a port

    // Params
    private coastlineParams: WaterParams;
    private highwayParams: HighwayParams;
    private zoningParams: ZoningParams = {
        numIndustrialZones: 2,
        industrialSize: 160,
        lowIncomeAmount: 0.5,
        highwayBuffer: 8,
    };
    private mainParams: StreamlineParams;
    private majorParams: StreamlineParams;
    private minorParams: StreamlineParams = {
        dsep: 20,
        dtest: 15,
        dstep: 1,
        dlookahead: 40,
        dcirclejoin: 5,
        joinangle: 0.1,  // approx 30deg
        pathIterations: 1000,
        seedTries: 300,
        simplifyTolerance: 0.5,
        collideEarly: 0,
    };

    private redraw: boolean = true;

    constructor(private guiFolder: dat.GUI, private tensorField: TensorField, private closeTensorFolder: () => void) {
        guiFolder.add(this, 'generateEverything');
        // guiFolder.add(this, 'simpleBenchMark');
        const animateController = guiFolder.add(this, 'animate');
        guiFolder.add(this, 'animationSpeed');

        this.coastlineParams = Object.assign({
            coastNoise: {
                noiseEnabled: true,
                noiseSize: 30,
                noiseAngle: 20,
            },
            riverNoise: {
                noiseEnabled: true,
                noiseSize: 30,
                noiseAngle: 20,
            },
            riverBankSize: 10,
            riverSize: 30,
        }, this.minorParams);
        this.coastlineParams.pathIterations = 10000;
        this.coastlineParams.simplifyTolerance = 10;

        this.majorParams = Object.assign({}, this.minorParams);
        this.majorParams.dsep = 100;
        this.majorParams.dtest = 30;
        this.majorParams.dlookahead = 200;
        this.majorParams.collideEarly = 0;

        this.highwayParams = Object.assign({
            numHighways: 2,
            frontageRoads: true,
            frontageDistance: 13,
            interchangeSize: 22,
        }, this.minorParams);
        this.highwayParams.dsep = 350;
        this.highwayParams.dtest = 150;
        this.highwayParams.simplifyTolerance = 4;
        this.highwayParams.seedTries = 100;

        this.mainParams = Object.assign({}, this.minorParams);
        this.mainParams.dsep = 400;
        this.mainParams.dtest = 200;
        this.mainParams.dlookahead = 500;
        this.mainParams.collideEarly = 0;

        const integrator = new RK4Integrator(tensorField, this.minorParams);
        const redraw = () => this.redraw = true;

        this.coastline = new WaterGUI(tensorField, this.coastlineParams, integrator,
            this.guiFolder, closeTensorFolder, 'Water', redraw).initFolder();
        this.highways = new HighwayGUI(tensorField, this.highwayParams, integrator,
            this.guiFolder, closeTensorFolder, 'Highways', redraw).initFolder();
        this.mainRoads = new RoadGUI(this.mainParams, integrator, this.guiFolder, closeTensorFolder, 'Main', redraw).initFolder();
        this.majorRoads = new RoadGUI(this.majorParams, integrator, this.guiFolder, closeTensorFolder, 'Major', redraw, this.animate).initFolder();
        this.minorRoads = new RoadGUI(this.minorParams, integrator, this.guiFolder, closeTensorFolder, 'Minor', redraw, this.animate).initFolder();
        
        const parks = guiFolder.addFolder('Parks');
        parks.add({Generate: () => {
            this.buildings.reset();
            this.addParks();
            this.redraw = true;
        }}, 'Generate');
        parks.add(this, 'clusterBigParks');
        parks.add(this, 'numBigParks');
        parks.add(this, 'numSmallParks');

        this.zoning = new Zoning(this.zoningParams, tensorField);
        const zoningFolder = guiFolder.addFolder('Zoning');
        zoningFolder.add({Regenerate: () => this.regenerateZoning()}, 'Regenerate');
        zoningFolder.add(this.zoningParams, 'numIndustrialZones', 0, 6).step(1);
        zoningFolder.add(this.zoningParams, 'industrialSize', 40, 400);
        zoningFolder.add(this.zoningParams, 'lowIncomeAmount', 0, 1);
        zoningFolder.add(this, 'portChance', 0, 1);

        const buildingsFolder = guiFolder.addFolder('Buildings');
        this.buildings = new Buildings(tensorField, buildingsFolder, redraw, this.minorParams.dstep, this.animate);
        this.buildings.setZoning(this.zoning);
        this.buildings.setPreGenerateCallback(() => {
            const allStreamlines = [];
            allStreamlines.push(...this.highways.allStreamlines);
            allStreamlines.push(...this.mainRoads.allStreamlines);
            allStreamlines.push(...this.majorRoads.allStreamlines);
            allStreamlines.push(...this.minorRoads.allStreamlines);
            allStreamlines.push(...this.coastline.streamlinesWithSecondaryRoad);
            this.buildings.setAllStreamlines(allStreamlines);
        });

        animateController.onChange((b: boolean) => {
            this.majorRoads.animate = b;
            this.minorRoads.animate = b;
            this.buildings.animate = b;
        });

        this.minorRoads.setExistingStreamlines([this.coastline, this.highways, this.mainRoads, this.majorRoads]);
        this.majorRoads.setExistingStreamlines([this.coastline, this.highways, this.mainRoads]);
        this.mainRoads.setExistingStreamlines([this.coastline, this.highways]);

        // Side streets don't cross highways, get cut off by interchanges, and leave industry to the larger roads
        this.minorRoads.setBlocked(p => this.blockedForMinorRoads(p));

        this.coastline.setPreGenerateCallback(() => {
            this.highways.clearStreamlines();
            this.resetZoning();
            this.mainRoads.clearStreamlines();
            this.majorRoads.clearStreamlines();
            this.minorRoads.clearStreamlines();
            this.bigParks = [];
            this.smallParks = [];
            this.buildings.reset();
            tensorField.parks = [];
            tensorField.sea = [];
            tensorField.river = [];
        });

        this.highways.setPreGenerateCallback(() => {
            this.resetZoning();
            this.mainRoads.clearStreamlines();
            this.majorRoads.clearStreamlines();
            this.minorRoads.clearStreamlines();
            this.bigParks = [];
            this.smallParks = [];
            this.buildings.reset();
            tensorField.parks = [];
        });

        this.mainRoads.setPreGenerateCallback(() => {
            this.resetZoning();
            this.majorRoads.clearStreamlines();
            this.minorRoads.clearStreamlines();
            this.bigParks = [];
            this.smallParks = [];
            this.buildings.reset();
            tensorField.parks = [];
            tensorField.ignoreRiver = true;
        });

        this.mainRoads.setPostGenerateCallback(() => {
            tensorField.ignoreRiver = false;
            this.setupZoning();
        });

        this.majorRoads.setPreGenerateCallback(() => {
            this.minorRoads.clearStreamlines();
            this.bigParks = [];
            this.smallParks = [];
            this.buildings.reset();
            tensorField.parks = [];
            tensorField.ignoreRiver = true;
        });

        this.majorRoads.setPostGenerateCallback(() => {
            tensorField.ignoreRiver = false;
            this.setDistricts();
            this.addParks();
            this.redraw = true;
        });

        this.minorRoads.setPreGenerateCallback(() => {
            this.buildings.reset();
            this.smallParks = [];
            tensorField.parks = this.bigParks;
        });

        this.minorRoads.setPostGenerateCallback(() => {
            this.trimMinorRoads();
            this.addParks();
        });
    }

    private resetZoning(): void {
        this.zoning.reset();
        this.port = null;
        this.buildings.setPortBuildings([]);
    }

    /**
     * Interchanges and industrial sites depend on where main roads meet highways
     */
    private setupZoning(): void {
        this.highways.createInterchanges(this.mainRoads.allStreamlines
            .concat(this.coastline.streamlinesWithSecondaryRoad));

        this.domainController.zoom = this.domainController.zoom / Util.DRAW_INFLATE_AMOUNT;
        const origin = this.domainController.origin;
        const worldDimensions = this.domainController.worldDimensions;
        this.domainController.zoom = this.domainController.zoom * Util.DRAW_INFLATE_AMOUNT;

        // No building lots between a highway and its frontage roads
        this.zoningParams.highwayBuffer = this.highwayParams.frontageRoads ? this.highwayParams.frontageDistance + 1 : 8;
        this.port = null;
        if (this.zoningParams.numIndustrialZones > 0 && Math.random() < this.portChance) {
            const inner = (v: Vector): boolean => {
                const t = v.clone().sub(origin);
                return t.x > 0.15 * worldDimensions.x && t.x < 0.85 * worldDimensions.x &&
                    t.y > 0.15 * worldDimensions.y && t.y < 0.85 * worldDimensions.y;
            };
            this.port = PortPlanner.plan(this.coastline.coastRoadWorld, this.coastline.seaPolygonWorld,
                this.tensorField.river, {
                    halfSpan: (0.6 + 0.4 * Math.random()) * this.zoningParams.industrialSize,
                    pierLength: 55 + Math.random() * 30,  // All piers in a port share one length
                    pierWidth: 34,
                    slipWidth: 28,
                }, inner);
        }
        this.buildings.setPortBuildings(this.port ? this.port.buildings : []);

        this.zoning.setup(origin, worldDimensions,
            this.highways.highwaysWorld, this.highways.interchanges,
            this.coastline.allStreamlines, this.port ? this.port.centre : null);
    }

    /**
     * Snap zones to the areas enclosed by highways, main and major roads
     */
    private setDistricts(): void {
        if (!this.zoning.enabled) return;
        const g = new Graph(this.highways.allStreamlines
            .concat(this.mainRoads.allStreamlines)
            .concat(this.majorRoads.allStreamlines)
            .concat(this.coastline.streamlinesWithSecondaryRoad), this.minorParams.dstep, true);
        const p = new PolygonFinder(g.nodes, {
                maxLength: 1000,  // Districts next to smoothed highways have many sides
                minArea: 80,
                shrinkSpacing: 4,
                chanceNoDivide: 1,
            }, this.tensorField);
        p.findPolygons();
        this.zoning.setDistricts(p.polygons);
    }

    private blockedForMinorRoads(p: Vector): boolean {
        if (!this.zoning.enabled) return false;
        const trimDistance = this.highwayParams.frontageRoads ? this.highwayParams.frontageDistance : this.zoningParams.highwayBuffer + 3;
        return this.zoning.approxHighwayDistance(p) < trimDistance - 6
            || this.zoning.zoneAt(p) === Zone.Industrial
            || this.zoning.inInterchange(p);
    }

    /**
     * Minor roads stop a little way past zone edges, cut them back so they end exactly on the
     * frontage road or on the road bounding an industrial district
     */
    private trimMinorRoads(): void {
        if (!this.zoning.enabled) return;
        const trimDistance = this.highwayParams.frontageRoads ? this.highwayParams.frontageDistance : this.zoningParams.highwayBuffer + 3;
        // Overshoot so the end crosses the road it stops at, otherwise no junction is found there
        this.minorRoads.trimEnds(p => this.zoning.exactHighwayDistance(p) < trimDistance
            || this.zoning.inIndustrialDistrict(p)
            || this.zoning.inInterchange(p), 1);
        this.addUnderpasses(trimDistance);
    }

    /**
     * In real cities the street grid usually carries on under a freeway
     * Where side streets stop either side of a highway roughly in line, join some of them up
     */
    private addUnderpasses(trimDistance: number): void {
        const SPACING = 70;  // Minimum distance between underpasses
        const CHANCE = 0.6;
        const ends: {point: Vector; dir: Vector}[] = [];
        for (const s of this.minorRoads.allStreamlines) {
            if (s.length < 2) continue;
            for (const [end, previous] of [[s[s.length - 1], s[s.length - 2]], [s[0], s[1]]]) {
                const d = this.zoning.exactHighwayDistance(end);
                if (d > trimDistance + 3) continue;
                if (this.zoning.inInterchange(end) || this.zoning.inIndustrialDistrict(end)) continue;
                const dir = end.clone().sub(previous);
                if (dir.lengthSq() === 0) continue;
                ends.push({point: end, dir: dir.normalize()});
            }
        }

        const used = new Set<number>();
        const underpasses: Vector[][] = [];
        const maxSpan = 2 * trimDistance + 12;
        for (let i = 0; i < ends.length; i++) {
            if (used.has(i)) continue;
            let best = -1;
            let bestScore = Infinity;
            for (let j = 0; j < ends.length; j++) {
                if (j === i || used.has(j)) continue;
                const gap = ends[j].point.clone().sub(ends[i].point);
                const length = gap.length();
                if (length < trimDistance || length > maxSpan) continue;
                const across = gap.clone().divideScalar(length);
                // Both ends must point at each other, across the highway
                if (across.dot(ends[i].dir) < 0.9 || across.dot(ends[j].dir) > -0.9) continue;
                const score = length * (2 - across.dot(ends[i].dir));
                if (score < bestScore) {
                    bestScore = score;
                    best = j;
                }
            }
            if (best < 0) continue;
            used.add(i);
            used.add(best);

            const a = ends[i].point;
            const b = ends[best].point;
            const middle = a.clone().add(b).divideScalar(2);
            if (Math.random() > CHANCE) continue;
            if (underpasses.some(u => u[0].clone().add(u[1]).divideScalar(2).distanceTo(middle) < SPACING)) continue;
            if (!this.tensorField.onLand(middle)) continue;
            underpasses.push([a.clone(), b.clone()]);
        }
        this.minorRoads.addRoads(underpasses);
    }

    /**
     * Pick new industrial sites and rebuild everything that depends on them
     */
    async regenerateZoning(): Promise<void> {
        if (this.highways.roadsEmpty() && this.mainRoads.roadsEmpty()) return;
        this.setupZoning();
        this.setDistricts();
        await this.minorRoads.generateRoads(this.animate);
        this.redraw = true;
        await this.buildings.generate(this.animate);
        this.redraw = true;
    }

    addParks(): void {
        const g = new Graph(this.majorRoads.allStreamlines
            .concat(this.highways.allStreamlines)
            .concat(this.mainRoads.allStreamlines)
            .concat(this.minorRoads.allStreamlines), this.minorParams.dstep);
        this.intersections = g.intersections;

        const p = new PolygonFinder(g.nodes, {
                maxLength: 20,
                minArea: 80,
                shrinkSpacing: 4,
                chanceNoDivide: 1,
            }, this.tensorField);
        p.findPolygons();
        // Nobody builds a park in the middle of an industrial estate
        const polygons = p.polygons.filter(poly => this.zoning.zoneAt(PolygonUtil.averagePoint(poly)) !== Zone.Industrial);

        if (this.minorRoads.allStreamlines.length === 0) {
            // Big parks
            this.bigParks = [];
            this.smallParks = [];
            if (polygons.length > this.numBigParks) {
                if (this.clusterBigParks) {
                    // Group in adjacent polygons 
                    const parkIndex = Math.floor(Math.random() * (polygons.length - this.numBigParks));
                    for (let i = parkIndex; i < parkIndex + this.numBigParks; i++) {
                        this.bigParks.push(polygons[i]);    
                    }
                } else {
                    for (let i = 0; i < this.numBigParks; i++) {
                        const parkIndex = Math.floor(Math.random() * polygons.length);
                        this.bigParks.push(polygons[parkIndex]);
                    }
                }
            } else {
                this.bigParks.push(...polygons);
            }
        } else {
            // Small parks
            this.smallParks = [];
            for (let i = 0; i < this.numSmallParks; i++) {
                const parkIndex = Math.floor(Math.random() * polygons.length);
                this.smallParks.push(polygons[parkIndex]);
            }
        }

        this.tensorField.parks = [];
        this.tensorField.parks.push(...this.bigParks);
        this.tensorField.parks.push(...this.smallParks);
    }

    async generateEverything() {
        this.coastline.generateRoads();
        await this.highways.generateRoads();
        await this.mainRoads.generateRoads();
        await this.majorRoads.generateRoads(this.animate);
        await this.minorRoads.generateRoads(this.animate);
        this.redraw = true;
        await this.buildings.generate(this.animate);
    }

    update() {
        let continueUpdate = true;
        const start = performance.now();
        while (continueUpdate && performance.now() - start < this.animationSpeed) {
            const minorChanged = this.minorRoads.update();
            const majorChanged = this.majorRoads.update();
            const mainChanged = this.mainRoads.update();
            const buildingsChanged = this.buildings.update();
            continueUpdate = minorChanged || majorChanged || mainChanged || buildingsChanged;
        }
        
        this.redraw = this.redraw || continueUpdate;
    }

    draw(style: Style, forceDraw=false, customCanvas?: CanvasWrapper): void {
        if (!style.needsUpdate && !forceDraw && !this.redraw && !this.domainController.moved) {
            return;
        }

        style.needsUpdate = false;
        this.domainController.moved = false;
        this.redraw = false;

        style.seaPolygon = this.coastline.seaPolygon;
        style.coastline = this.coastline.coastline;
        style.river = this.coastline.river;
        style.lots = this.buildings.lots;
        style.lowIncomeLots = this.buildings.lowIncomeLots;
        style.fences = this.buildings.lowIncomeFenceLines;
        style.industrialLots = this.buildings.industrialLots;
        style.lowIncomeAreas = this.buildings.lowIncomeBlocks;
        style.industrialAreas = this.buildings.industrialBlocks;

        if (style instanceof DefaultStyle && style.showBuildingModels || style instanceof RoughStyle) {
            style.buildingModels = this.buildings.models;    
        }

        style.parks = [];
        style.parks.push(...this.bigParks.map(p => p.map(v => this.domainController.worldToScreen(v.clone()))));
        style.parks.push(...this.smallParks.map(p => p.map(v => this.domainController.worldToScreen(v.clone()))));
        style.minorRoads = this.minorRoads.roads;
        style.majorRoads = this.majorRoads.roads;
        style.mainRoads = this.mainRoads.roads;
        style.coastlineRoads = this.coastline.roads;
        style.highways = this.highways.roads;
        style.industrialRoads = this.buildings.industrialServiceRoads.concat(this.toScreen(this.port ? this.port.roads : []));
        style.portLand = this.toScreen(this.port ? this.port.land : []);
        style.portWater = this.toScreen(this.port ? this.port.water : []);
        style.frontageRoads = this.highways.frontageRoads;
        style.ramps = this.highways.ramps;
        style.secondaryRiver = this.coastline.secondaryRiver;
        style.draw(customCanvas);

        // Drawing an export shouldn't stop the screen from catching up
        if (customCanvas) this.redraw = true;
    }

    private toScreen(polygons: Vector[][]): Vector[][] {
        return polygons.map(p => p.map(v => this.domainController.worldToScreen(v.clone())));
    }

    roadsEmpty(): boolean {
        return this.majorRoads.roadsEmpty()
            && this.highways.roadsEmpty()
            && this.minorRoads.roadsEmpty()
            && this.mainRoads.roadsEmpty()
            && this.coastline.roadsEmpty();
    }

    // OBJ Export methods

    public get seaPolygon(): Vector[] {
        return this.coastline.seaPolygon;
    }

    public get riverPolygon(): Vector[] {
        return this.coastline.river;
    }

    public get buildingModels(): BuildingModel[] {
        return this.buildings.models;
    }

    public getBlocks(): Promise<Vector[][]> {
        return this.buildings.getBlocks();
    }

    public get minorRoadPolygons(): Vector[][] {
        return this.minorRoads.roads.concat(this.highways.frontageRoads)
            .concat(this.buildings.industrialServiceRoads)
            .concat(this.toScreen(this.port ? this.port.roads : [])).map(r => PolygonUtil.resizeGeometry(r, 1 * this.domainController.zoom, false));
    }

    public get majorRoadPolygons(): Vector[][] {
        return this.majorRoads.roads.concat([this.coastline.secondaryRiver]).map(r => PolygonUtil.resizeGeometry(r, 2 * this.domainController.zoom, false));
    }

    public get mainRoadPolygons(): Vector[][] {
        return this.mainRoads.roads.concat(this.coastline.roads).map(r => PolygonUtil.resizeGeometry(r, 2.5 * this.domainController.zoom, false))
            .concat(this.highways.roads.map(r => PolygonUtil.resizeGeometry(r, 4 * this.domainController.zoom, false)))
            .concat(this.highways.ramps.map(r => PolygonUtil.resizeGeometry(r, 1.5 * this.domainController.zoom, false)));
    }

    public get coastlinePolygon(): Vector[] {
        return PolygonUtil.resizeGeometry(this.coastline.coastline, 15 * this.domainController.zoom, false);
    }
}
