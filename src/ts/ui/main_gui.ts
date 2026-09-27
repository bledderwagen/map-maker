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
import ParkPaths from '../impl/park_paths';
import {polylineLength, resampleEqual} from '../impl/hydrology';

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
    private parkPaths: Vector[][] = [];  // World space
    private waterfrontPaths: Vector[][] = [];
    private ponds: Vector[][] = [];
    private trees: Vector[][] = [];
    private waterfrontTrees: Vector[][] = [];
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
        industrialSize: 220,
        lowIncomeAmount: 0.5,
        highwayBuffer: 12,
    };
    private mainParams: StreamlineParams;
    private majorParams: StreamlineParams;
    // Distances are in world units, 1 unit = 2 m, measured against OpenStreetMap
    // Typical US blocks are about 100 x 200 m, major roads about 500 m apart
    private minorParams: StreamlineParams = {
        dsep: 30,
        dtest: 22,
        dstep: 1,
        dlookahead: 90,
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
        this.majorParams.dsep = 200;
        this.majorParams.dtest = 60;
        this.majorParams.dlookahead = 300;
        this.majorParams.collideEarly = 0;

        this.highwayParams = Object.assign({
            numHighways: 2,
            frontageRoads: true,
            frontageDistance: 25,
            interchangeSize: 36,
        }, this.minorParams);
        this.highwayParams.dsep = 350;
        this.highwayParams.dtest = 150;
        this.highwayParams.simplifyTolerance = 4;
        this.highwayParams.seedTries = 100;

        this.mainParams = Object.assign({}, this.minorParams);
        this.mainParams.dsep = 600;
        this.mainParams.dtest = 300;
        this.mainParams.dlookahead = 700;
        this.mainParams.collideEarly = 0;

        // Side streets one way are twice as far apart as the other, giving oblong blocks
        this.minorParams.minorSpacingRatio = 2.3;

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
            // The water's edge closes off the blocks between the coast road and the sea
            allStreamlines.push(...this.coastline.waterEdges);

            // Half the drawn width of each kind of road, 1 world unit per pixel at zoom 1
            const widths = this.roadHalfWidths();
            const clearance: {line: Vector[]; halfWidth: number}[] = [];
            const add = (lines: Vector[][], halfWidth: number): void => {
                for (const line of lines) if (line.length >= 2) clearance.push({line, halfWidth});
            };
            add(this.minorRoads.allStreamlines, widths.minor);
            add(this.majorRoads.allStreamlines, widths.major);
            add(this.mainRoads.allStreamlines, widths.main);
            add(this.coastline.streamlinesWithSecondaryRoad, widths.main);
            add(this.highways.highwaysWorld, widths.highway);
            add(this.highways.frontageRoadsWorld, widths.minor);
            add(this.highways.rampsWorld, widths.ramp);
            this.buildings.setRoadClearance(clearance);
            this.buildings.setAllStreamlines(allStreamlines);
            this.buildings.setWaterfront(this.coastline.shoreDetailedWorld, this.coastline.shoreBeachWidths, this.coastline.beachesWorld);
        });
        this.buildings.setPostGenerateCallback(() => this.layoutWaterfrontParks());

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
            this.parkPaths = [];
            this.ponds = [];
            this.trees = [];
            this.buildings.reset();
            tensorField.parks = [];
            tensorField.sea = [];
            tensorField.river = [];
            tensorField.beaches = [];
        });

        this.highways.setPreGenerateCallback(() => {
            this.resetZoning();
            this.mainRoads.clearStreamlines();
            this.majorRoads.clearStreamlines();
            this.minorRoads.clearStreamlines();
            this.bigParks = [];
            this.smallParks = [];
            this.parkPaths = [];
            this.ponds = [];
            this.trees = [];
            this.buildings.reset();
            tensorField.parks = [];
        });

        this.mainRoads.setPreGenerateCallback(() => {
            this.resetZoning();
            this.majorRoads.clearStreamlines();
            this.minorRoads.clearStreamlines();
            this.bigParks = [];
            this.smallParks = [];
            this.parkPaths = [];
            this.ponds = [];
            this.trees = [];
            this.buildings.reset();
            tensorField.parks = [];
            tensorField.ignoreRiver = true;
        });

        this.mainRoads.setPostGenerateCallback(() => {
            tensorField.ignoreRiver = false;
            this.removeWanderingBridges(this.mainRoads);
            this.setupZoning();
        });

        this.majorRoads.setPreGenerateCallback(() => {
            this.minorRoads.clearStreamlines();
            this.bigParks = [];
            this.smallParks = [];
            this.parkPaths = [];
            this.ponds = [];
            this.trees = [];
            this.buildings.reset();
            tensorField.parks = [];
            tensorField.ignoreRiver = true;
        });

        this.majorRoads.setPostGenerateCallback(() => {
            tensorField.ignoreRiver = false;
            this.removeWanderingBridges(this.majorRoads);
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

    /**
     * Roads may bridge the river, but only straight across it, the way real bridges are built.
     * A stretch inside the riverside park that doesn't cross the water, or wanders about, is removed,
     * and a crossing that curves is replaced by a straight bridge between the two banks
     */
    private removeWanderingBridges(roads: RoadGUI): void {
        const park = this.coastline.floodplainWorld;
        const river = this.coastline.riverWorld;
        if (!park || park.length < 3) return;
        const out: Vector[][] = [];
        for (const line of roads.allStreamlines) {
            const fine = resampleEqual(line, 4);
            let current: Vector[] = [];
            let i = 0;
            while (i < fine.length) {
                if (!PolygonUtil.insidePolygon(fine[i], park)) {
                    current.push(fine[i]);
                    i++;
                    continue;
                }
                // A run inside the park
                let j = i;
                while (j < fine.length && PolygonUtil.insidePolygon(fine[j], park)) j++;
                const inside = fine.slice(i, j);
                const reachesOtherSide = i > 0 && j < fine.length;
                const a = fine[Math.max(0, i - 1)];
                const b = fine[Math.min(fine.length - 1, j)];
                const length = polylineLength([a].concat(inside, [b]));
                const direct = a.distanceTo(b);
                const crossesWater = inside.some(v => PolygonUtil.insidePolygon(v, river));
                if (reachesOtherSide && crossesWater && length < 1.3 * direct + 10) {
                    // Straight bridge: the road runs directly from a to b
                } else {
                    if (current.length >= 2) out.push(current);
                    current = [];
                }
                i = j;
            }
            if (current.length >= 2) out.push(current);
        }
        roads.replaceRoads(out.map(l => l.filter((_, k) => k % 3 === 0 || k === l.length - 1
            || !PolygonUtil.insidePolygon(l[k], park) !== !PolygonUtil.insidePolygon(l[Math.min(l.length - 1, k + 1)], park)
            || l[k].distanceTo(l[Math.min(l.length - 1, k + 1)]) > 6
            || l[k].distanceTo(l[Math.max(0, k - 1)]) > 6)));
    }

    private roadHalfWidths(): {minor: number; major: number; main: number; highway: number; ramp: number} {
        // Matches the defaults in style.ts
        return {minor: 2.25, major: 3.25, main: 4, highway: 9, ramp: 2.5};
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
        this.zoningParams.highwayBuffer = this.highwayParams.frontageRoads ? this.highwayParams.frontageDistance + 1 : 12;
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
                    pierLength: 100 + Math.random() * 50,  // All piers in a port share one length
                    pierWidth: 30,
                    slipWidth: 40,
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
        // Parks have footpaths, not streets
        if (this.bigParks.length > 0 && this.inBigPark(p)) return true;
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
    private inBigPark(p: Vector): boolean {
        return this.bigParks.some(park => PolygonUtil.insidePolygon(p, park));
    }

    private trimMinorRoads(): void {
        if (!this.zoning.enabled) {
            if (this.bigParks.length > 0) this.minorRoads.trimEnds(p => this.inBigPark(p), 1);
            return;
        }
        const trimDistance = this.highwayParams.frontageRoads ? this.highwayParams.frontageDistance : this.zoningParams.highwayBuffer + 3;
        // Overshoot so the end crosses the road it stops at, otherwise no junction is found there
        this.minorRoads.trimEnds(p => this.zoning.exactHighwayDistance(p) < trimDistance
            || this.zoning.inIndustrialDistrict(p)
            || this.zoning.inInterchange(p)
            || this.inBigPark(p), 1);
        this.addUnderpasses(trimDistance);
        this.pruneStubs();
    }

    /**
     * Side streets that were cut off by a highway, interchange or park can end in the middle of
     * nowhere a short way past their last junction. Cut those stubs back to the junction
     */
    private pruneStubs(): void {
        this.minorRoads.replaceRoads(this.pruneLines(this.minorRoads.allStreamlines,
            this.mainRoads.allStreamlines
                .concat(this.majorRoads.allStreamlines)
                .concat(this.coastline.streamlinesWithSecondaryRoad)
                .concat(this.highways.frontageRoadsWorld), 90));
        // Frontage roads cut off by a cloverleaf
        this.highways.replaceFrontageRoads(this.pruneLines(this.highways.frontageRoadsWorld,
            this.minorRoads.allStreamlines
                .concat(this.mainRoads.allStreamlines)
                .concat(this.majorRoads.allStreamlines)
                .concat(this.coastline.streamlinesWithSecondaryRoad), 250));
    }

    /**
     * Cuts dangling ends of lines back to their last crossing with another road
     * @param maxStub longer dead ends are kept as real dead end streets
     */
    private pruneLines(minor: Vector[][], others: Vector[][], maxStub: number): Vector[][] {
        const MAX_STUB = maxStub;
        const TOUCH = 3;

        // Segment grid over every road
        const cell = 40;
        const grid = new Map<string, {a: Vector; b: Vector; owner: number}[]>();
        const addLine = (line: Vector[], owner: number): void => {
            for (let i = 0; i < line.length - 1; i++) {
                const a = line[i];
                const b = line[i + 1];
                for (let x = Math.floor(Math.min(a.x, b.x) / cell); x <= Math.floor(Math.max(a.x, b.x) / cell); x++) {
                    for (let y = Math.floor(Math.min(a.y, b.y) / cell); y <= Math.floor(Math.max(a.y, b.y) / cell); y++) {
                        const key = `${x},${y}`;
                        if (!grid.has(key)) grid.set(key, []);
                        grid.get(key).push({a, b, owner});
                    }
                }
            }
        };
        minor.forEach((line, i) => addLine(line, i));
        others.forEach(line => addLine(line, -1));

        const nearby = (p: Vector, q: Vector, owner: number): {a: Vector; b: Vector}[] => {
            const out: {a: Vector; b: Vector}[] = [];
            for (let x = Math.floor((Math.min(p.x, q.x) - TOUCH) / cell); x <= Math.floor((Math.max(p.x, q.x) + TOUCH) / cell); x++) {
                for (let y = Math.floor((Math.min(p.y, q.y) - TOUCH) / cell); y <= Math.floor((Math.max(p.y, q.y) + TOUCH) / cell); y++) {
                    for (const s of grid.get(`${x},${y}`) || []) if (s.owner !== owner) out.push(s);
                }
            }
            return out;
        };
        const touching = (p: Vector, owner: number): boolean =>
            nearby(p, p, owner).some(s => PolygonUtil.distanceToSegment(p, s.a, s.b) < TOUCH);

        // Returns the line with a dangling end cut back, walking from the end at index 0
        const prune = (line: Vector[], owner: number): Vector[] => {
            if (line.length < 2 || touching(line[0], owner)) return line;
            let travelled = 0;
            for (let i = 0; i < line.length - 1; i++) {
                const a = line[i];
                const b = line[i + 1];
                let best: Vector = null;
                let bestT = Infinity;
                for (const s of nearby(a, b, owner)) {
                    const hit = PolygonUtil.segmentIntersection(a, b, s.a, s.b);
                    if (hit !== null && hit.t < bestT && hit.t * a.distanceTo(b) > 0.5) {
                        bestT = hit.t;
                        best = hit.point;
                    }
                }
                if (best !== null) {
                    if (travelled + a.distanceTo(best) > MAX_STUB) return line;
                    return [best].concat(line.slice(i + 1));
                }
                travelled += a.distanceTo(b);
                if (travelled > MAX_STUB) return line;
            }
            // Never meets another road, a short fragment on its own
            return travelled > MAX_STUB ? line : [];
        };

        return minor.map((line, i) => {
            const front = prune(line, i);
            if (front.length < 2) return front;
            return prune(front.slice().reverse(), i).reverse();
        }).filter(line => line.length >= 2);
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
            this.parkPaths = [];
            this.ponds = [];
            this.trees = [];
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
        this.layoutParks();
    }

    private layoutParks(): void {
        this.parkPaths = [];
        this.ponds = [];
        this.trees = [];
        for (const park of this.bigParks.concat(this.smallParks)) {
            const layout = ParkPaths.layout(park);
            this.parkPaths.push(...layout.paths, ...layout.pitches);
            this.ponds.push(...layout.ponds);
            this.trees.push(...layout.woods);
        }
    }

    /**
     * Waterfront parks get a promenade along the top of the beach, and paths like other parks
     */
    private layoutWaterfrontParks(): void {
        this.waterfrontPaths = [];
        this.waterfrontTrees = [];
        const shore = this.coastline.shoreDetailedWorld;
        const beach = this.coastline.shoreBeachWidths;
        const sea = this.coastline.seaPolygonWorld;
        const landward = (i: number): Vector => {
            const a = shore[Math.max(0, i - 1)];
            const b = shore[Math.min(shore.length - 1, i + 1)];
            const t = b.clone().sub(a).normalize();
            const n = new Vector(-t.y, t.x);
            // Point the normal away from the sea
            return PolygonUtil.insidePolygon(shore[i].clone().add(n.clone().multiplyScalar(4)), sea) ? n.multiplyScalar(-1) : n;
        };
        // Riverside woodland, clear of the channel and the bankside paths
        const floodplain = this.coastline.floodplainWorld;
        if (floodplain && floodplain.length >= 3) {
            this.waterfrontTrees.push(...ParkPaths.woods(floodplain, this.coastline.riversidePathsWorld,
                this.coastline.riverWorld, this.coastline.lakesWorld.concat(this.coastline.sandBarsWorld)));
        }
        for (const park of this.buildings.waterfrontParks) {
            this.waterfrontPaths.push(...ParkPaths.promenade(park, shore, beach, landward));
            if (PolygonUtil.calcPolygonArea(park) > 6000) {
                const layout = ParkPaths.layout(park);
                this.waterfrontPaths.push(...layout.paths);
                this.waterfrontTrees.push(...layout.woods);
            }
        }
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
        style.beaches = this.coastline.beaches;
        style.floodplain = this.coastline.floodplain || [];
        style.lakes = this.coastline.lakes.concat(this.toScreen(this.ponds));
        style.sandBars = this.coastline.sandBars;
        style.woods = this.toScreen(this.trees.concat(this.waterfrontTrees));
        style.paths = this.coastline.riversidePaths.concat(this.toScreen(this.parkPaths)).concat(this.toScreen(this.waterfrontPaths));
        style.lots = this.buildings.lots;
        style.lowIncomeLots = this.buildings.lowIncomeLots;
        style.fences = this.buildings.fenceLines;
        style.pools = this.buildings.swimmingPools;
        style.districts = this.zoning.districts.filter(d => !d.industrial).map(d => ({
            polygon: d.polygon.map(v => this.domainController.worldToScreen(v.clone())),
            income: d.income,
        }));
        style.industrialLots = this.buildings.industrialLots;
        style.lowIncomeAreas = this.buildings.lowIncomeBlocks;
        style.industrialAreas = this.buildings.industrialBlocks;

        if (style instanceof DefaultStyle && style.showBuildingModels || style instanceof RoughStyle) {
            style.buildingModels = this.buildings.models;    
        }

        style.parks = [];
        style.parks.push(...this.bigParks.map(p => p.map(v => this.domainController.worldToScreen(v.clone()))));
        style.parks.push(...this.smallParks.map(p => p.map(v => this.domainController.worldToScreen(v.clone()))));
        style.parks.push(...this.toScreen(this.buildings.waterfrontParks));
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
