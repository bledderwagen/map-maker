import * as log from 'loglevel';
import * as dat from 'dat.gui';
import TensorFieldGUI from './tensor_field_gui';
import {NoiseParams} from '../impl/tensor_field';
import CanvasWrapper from './canvas_wrapper';
import {DefaultCanvasWrapper, RoughCanvasWrapper} from './canvas_wrapper';
import Util from '../util';
import PolygonUtil from '../impl/polygon_util';
import DragController from './drag_controller';
import DomainController from './domain_controller';
import Vector from '../vector';
import {BuildingModel} from './buildings';
import {Zone} from '../impl/zoning';
import {StreetNameSets} from '../impl/place_names';
import Labeller, {LabelStyle} from './labeller';
import PointsOfInterest from '../impl/points_of_interest';

export interface ColourScheme {
    bgColour: string;
    bgColourIn?: string;
    buildingColour?: string;
    buildingSideColour?: string;
    buildingStroke?: string;
    seaColour: string;
    grassColour?: string;
    minorRoadColour: string;
    minorRoadOutline?: string;
    majorRoadColour?: string;
    majorRoadOutline?: string;
    mainRoadColour?: string;
    mainRoadOutline?: string;
    outlineSize?: number;
    minorWidth?: number;
    majorWidth?: number;
    mainWidth?: number;
    zoomBuildings?: boolean;
    buildingModels?: boolean;
    frameColour?: string;
    frameTextColour?: string;
    highwayColour?: string;
    highwayOutline?: string;
    highwayWidth?: number;
    rampWidth?: number;
    industrialColour?: string;  // Land use tint
    industrialBuildingColour?: string;
    lowIncomeColour?: string;  // Land use tint
    lowIncomeBuildingColour?: string;
    sandColour?: string;  // Beaches and sand bars
    pathColour?: string;  // Footpaths in parks
    treeColour?: string;
    // Used by the OpenStreetMap style
    residentialColour?: string;  // Land use under houses
    tertiaryRoadColour?: string;
    tertiaryRoadOutline?: string;
    serviceRoadColour?: string;
    serviceRoadOutline?: string;
    footwayColour?: string;
    pitchColour?: string;
    pitchOutline?: string;
    bridgeOutline?: string;
    labelColour?: string;
    waterLabelColour?: string;
    parkLabelColour?: string;
    placeLabelColour?: string;
    shieldColour?: string;
    shieldOutline?: string;
    fontFamily?: string;
    floatingLabels?: boolean;  // Place names hovering over the pseudo 3D city
    labelStemColour?: string;
    retailColour?: string;
    retailOutline?: string;
    parkingColour?: string;
    parkingOutline?: string;
    poolOutline?: string;
    shopLabelColour?: string;
}

export type PlaceKind = 'neighbourhood' | 'park' | 'mall' | 'apartments' | 'river';

export interface PlaceLabel {
    text: string;
    at: Vector;  // Screen space
    kind: PlaceKind;
}

/**
 * How high floating labels hover, in world units as the pseudo 3D view draws them.
 * Clear of the tallest buildings, and the more important the place the higher
 */
export const FLOATING_LABEL_HEIGHT: {[kind in PlaceKind]: number} = {
    neighbourhood: 75,
    mall: 55,
    river: 50,
    park: 45,
    apartments: 45,
};

/**
 * Controls how screen-space data is drawn
 */
export default abstract class Style {
    protected canvas: CanvasWrapper;
    protected domainController: DomainController = DomainController.getInstance();
    public abstract createCanvasWrapper(c: HTMLCanvasElement, scale: number, resizeToWindow: boolean): CanvasWrapper;
    public abstract draw(canvas?: CanvasWrapper): void;

    public update(): void {}

    // Polygons
    public seaPolygon: Vector[] = [];
    public lots: Vector[][] = [];
    public buildingModels: BuildingModel[] = [];
    public parks: Vector[][] = [];
    public beaches: Vector[][] = [];
    public floodplain: Vector[] = [];
    public lakes: Vector[][] = [];  // Oxbow lakes and ponds
    public sandBars: Vector[][] = [];
    public paths: Vector[][] = [];
    public woods: Vector[][] = [];
    private woodTile: HTMLCanvasElement = null;
    public lowIncomeLots: Vector[][] = [];
    public fences: Vector[][] = [];  // Thin lines around yards
    public industrialLots: Vector[][] = [];
    public lowIncomeAreas: Vector[][] = [];
    public industrialAreas: Vector[][] = [];
    public portLand: Vector[][] = [];
    public portWater: Vector[][] = [];
    public residentialAreas: Vector[][] = [];
    public pitches: Vector[][] = [];  // Closed outlines of sports pitches
    public pitchMarkings: Vector[][] = [];  // Pitch lines, drawn like paths
    public railways: Vector[][] = [];
    public corridors: Vector[][] = [];  // Highway verges and interchanges
    public retailAreas: Vector[][] = [];
    public parkingLots: Vector[][] = [];
    public parkingAisles: Vector[][] = [];
    public pools: Vector[][] = [];
    public largeBuildings: Vector[][] = [];  // Malls, shops and apartment blocks

    // Names, only drawn by styles that label the map
    public names: StreetNameSets = null;
    public riverCentreline: Vector[] = [];
    public riverName = '';
    public seaName = '';
    public placeLabels: PlaceLabel[] = [];

    // Polylines
    public coastline: Vector[] = [];
    public river: Vector[] = [];
    public secondaryRiver: Vector[] = [];
    public minorRoads: Vector[][] = [];
    public majorRoads: Vector[][] = [];
    public mainRoads: Vector[][] = [];
    public coastlineRoads: Vector[][] = [];
    public highways: Vector[][] = [];
    public frontageRoads: Vector[][] = [];
    public ramps: Vector[][] = [];
    public industrialRoads: Vector[][] = [];
    public showFrame: boolean;
    public showZones = true;

    constructor(protected dragController: DragController, protected colourScheme: ColourScheme) {
        if (!colourScheme.bgColour) log.error("ColourScheme Error - bgColour not defined");
        if (!colourScheme.seaColour) log.error("ColourScheme Error - seaColour not defined");
        if (!colourScheme.minorRoadColour) log.error("ColourScheme Error - minorRoadColour not defined");

        // Default colourscheme cascade
        if (!colourScheme.bgColourIn) colourScheme.bgColourIn = colourScheme.bgColour;
        if (!colourScheme.buildingColour) colourScheme.buildingColour = colourScheme.bgColour;
        if (!colourScheme.buildingStroke) colourScheme.buildingStroke = colourScheme.bgColour;
        if (!colourScheme.grassColour) colourScheme.grassColour = colourScheme.bgColour;
        if (!colourScheme.minorRoadOutline) colourScheme.minorRoadOutline = colourScheme.minorRoadColour;
        if (!colourScheme.majorRoadColour) colourScheme.majorRoadColour = colourScheme.minorRoadColour;
        if (!colourScheme.majorRoadOutline) colourScheme.majorRoadOutline = colourScheme.minorRoadOutline;
        if (!colourScheme.mainRoadColour) colourScheme.mainRoadColour = colourScheme.majorRoadColour;
        if (!colourScheme.mainRoadOutline) colourScheme.mainRoadOutline = colourScheme.majorRoadOutline;
        if (!colourScheme.outlineSize) colourScheme.outlineSize = 1;
        if (!colourScheme.zoomBuildings) colourScheme.zoomBuildings = false;
        if (!colourScheme.buildingModels) colourScheme.buildingModels = false;
        if (!colourScheme.minorWidth) colourScheme.minorWidth = 4.5;
        if (!colourScheme.majorWidth) colourScheme.majorWidth = 6.5;
        if (!colourScheme.mainWidth) colourScheme.mainWidth = 8;
        if (!colourScheme.frameColour) colourScheme.frameColour = colourScheme.bgColour;
        if (!colourScheme.frameTextColour) colourScheme.frameTextColour = colourScheme.minorRoadOutline;

        if (!colourScheme.highwayColour) colourScheme.highwayColour = colourScheme.mainRoadColour;
        if (!colourScheme.highwayOutline) colourScheme.highwayOutline = colourScheme.mainRoadOutline;
        if (!colourScheme.highwayWidth) colourScheme.highwayWidth = colourScheme.mainWidth * 2;
        if (!colourScheme.rampWidth) colourScheme.rampWidth = colourScheme.majorWidth * 0.7;
        if (!colourScheme.industrialColour) colourScheme.industrialColour = Util.mixColours(colourScheme.bgColour, 'rgb(150,110,180)', 0.18);
        if (!colourScheme.lowIncomeColour) colourScheme.lowIncomeColour = Util.mixColours(colourScheme.bgColour, 'rgb(200,140,90)', 0.12);
        if (!colourScheme.industrialBuildingColour) colourScheme.industrialBuildingColour = colourScheme.buildingColour;
        if (!colourScheme.lowIncomeBuildingColour) colourScheme.lowIncomeBuildingColour = colourScheme.buildingColour;
        if (!colourScheme.sandColour) colourScheme.sandColour = Util.mixColours(colourScheme.bgColour, 'rgb(245,215,140)', 0.4);
        if (!colourScheme.pathColour) colourScheme.pathColour = colourScheme.minorRoadColour;
        if (!colourScheme.treeColour) colourScheme.treeColour = Util.mixColours(colourScheme.grassColour, 'rgb(60,110,60)', 0.22);


        if (!colourScheme.buildingSideColour) {
            const parsedRgb = Util.parseCSSColor(colourScheme.buildingColour).map(v => Math.max(0, v - 40));
            if (parsedRgb) {
                colourScheme.buildingSideColour = `rgb(${parsedRgb[0]},${parsedRgb[1]},${parsedRgb[2]})`;
            } else {
                colourScheme.buildingSideColour = colourScheme.buildingColour;
            }
        }
    }

    /**
     * Tile of tree symbols over the wood colour, scattered irregularly so no grid shows
     */
    protected woodPattern(): HTMLCanvasElement {
        if (this.woodTile !== null) return this.woodTile;
        const size = 36;
        const tile = document.createElement('canvas');
        tile.width = size;
        tile.height = size;
        const ctx = tile.getContext('2d');
        ctx.fillStyle = this.colourScheme.treeColour;
        ctx.fillRect(0, 0, size, size);
        const symbol = Util.mixColours(this.colourScheme.treeColour, 'rgb(40,80,40)', 0.45);
        ctx.fillStyle = symbol;
        ctx.strokeStyle = symbol;
        ctx.lineWidth = 1;
        // Positions chosen so neighbouring tiles don't line up into rows
        const trees = [[6, 7], [24, 4], [15, 18], [31, 22], [5, 29], [22, 32]];
        for (const [x, y] of trees) {
            for (const dx of [-size, 0, size]) {
                for (const dy of [-size, 0, size]) {
                    // Round crown on a short trunk
                    ctx.beginPath();
                    ctx.arc(x + dx, y + dy - 1.5, 2.3, 0, 2 * Math.PI);
                    ctx.fill();
                    ctx.beginPath();
                    ctx.moveTo(x + dx, y + dy);
                    ctx.lineTo(x + dx, y + dy + 2.5);
                    ctx.stroke();
                }
            }
        }
        this.woodTile = tile;
        return tile;
    }

    protected roofColour(zone: Zone): string {
        if (zone === Zone.Industrial) return this.colourScheme.industrialBuildingColour;
        if (zone === Zone.LowIncome) return this.colourScheme.lowIncomeBuildingColour;
        return this.colourScheme.buildingColour;
    }

    public set zoomBuildings(b: boolean) {
        this.colourScheme.zoomBuildings = b;
    }

    public set floatingLabels(b: boolean) {
        this.colourScheme.floatingLabels = b;
    }

    public set showBuildingModels(b: boolean) {
        this.colourScheme.buildingModels = b;
    }

    public get showBuildingModels(): boolean {
        return this.colourScheme.buildingModels;
    }

    public set canvasScale(scale: number) {
        this.canvas.canvasScale = scale;
    }

    public get needsUpdate(): boolean {
        return this.canvas.needsUpdate;
    }

    public set needsUpdate(n: boolean) {
        this.canvas.needsUpdate = n;
    }
}

/**
 * Place names hovering over the city on stems, projected with the same camera as the
 * pseudo 3D buildings so they lean and drift with them as the view moves
 */
function drawFloatingLabelsOn(canvas: DefaultCanvasWrapper, labels: PlaceLabel[], cs: ColourScheme,
                              domainController: DomainController): void {
    const screen = domainController.screenDimensions;
    const labeller = new Labeller(canvas, screen.x, screen.y);
    const fontFamily = cs.fontFamily || '"Noto Sans", "DejaVu Sans", "Helvetica Neue", Arial, sans-serif';
    const halo = 'rgba(255,255,255,0.85)';
    const looks: {[kind in PlaceKind]: {size: number; fill: string; extra: string; wrap: number}} = {
        neighbourhood: {size: 16, fill: cs.placeLabelColour || '#4a4a4a', extra: 'bold', wrap: 14},
        mall: {size: 13, fill: cs.shopLabelColour || '#ac39ac', extra: 'bold', wrap: 16},
        river: {size: 13, fill: cs.waterLabelColour || '#4d80b3', extra: 'italic', wrap: 30},
        park: {size: 12.5, fill: cs.parkLabelColour || '#3c7a43', extra: '', wrap: 14},
        apartments: {size: 11.5, fill: '#555555', extra: '', wrap: 16},
    };
    const order: PlaceKind[] = ['neighbourhood', 'mall', 'river', 'park', 'apartments'];

    // Room is claimed most important first; stems are drawn under every label
    const placed: {ground: Vector; top: Vector; draw: () => void}[] = [];
    for (const kind of order) {
        const look = looks[kind];
        const labelStyle: LabelStyle = {font: `${look.extra} ${look.size}px ${fontFamily}`.trim(), size: look.size,
            fill: look.fill, halo, haloWidth: 3};
        for (const l of labels) {
            if (l.kind !== kind) continue;
            const top = domainController.heightToScreen(l.at, FLOATING_LABEL_HEIGHT[kind]);
            // The text sits just above the top of its stem
            const at = new Vector(top.x, top.y - look.size);
            const draw = labeller.placePoint(at, l.text, labelStyle, look.wrap);
            if (draw !== null) placed.push({ground: l.at, top, draw});
        }
    }

    canvas.setStrokeStyle(cs.labelStemColour || 'rgba(70,70,70,0.45)');
    canvas.setLineWidth(1);
    for (const p of placed) canvas.drawPolyline([p.ground, p.top]);
    canvas.setFillStyle(cs.labelStemColour || 'rgba(70,70,70,0.45)');
    for (const p of placed) canvas.drawSquare(p.ground, 3);
    for (const p of placed) p.draw();
}

export class DefaultStyle extends Style {
    constructor(c: HTMLCanvasElement, dragController: DragController, colourScheme: ColourScheme, private heightmap=false) {
        super(dragController, colourScheme);
        this.canvas = this.createCanvasWrapper(c, 1, true);
    }

    public createCanvasWrapper(c: HTMLCanvasElement, scale=1, resizeToWindow=true): CanvasWrapper {
        return new DefaultCanvasWrapper(c, scale, resizeToWindow);
    }

    protected drawFloatingLabels(canvas: DefaultCanvasWrapper): void {
        drawFloatingLabelsOn(canvas, this.placeLabels, this.colourScheme, this.domainController);
    }

    public draw(canvas=this.canvas as DefaultCanvasWrapper): void {
        let bgColour;
        if (this.colourScheme.zoomBuildings) {
            bgColour = this.domainController.zoom >= 2 ? this.colourScheme.bgColourIn : this.colourScheme.bgColour;
        } else {
            bgColour = this.colourScheme.bgColour;
        }
        

        canvas.setFillStyle(bgColour);
        canvas.clearCanvas();

        // Sea
        canvas.setFillStyle(this.colourScheme.seaColour);
        canvas.setStrokeStyle(this.colourScheme.seaColour);
        canvas.setLineWidth(0.1);
        canvas.drawPolygon(this.seaPolygon);

        canvas.setLineWidth(1);

        // Riverside park
        canvas.setFillStyle(this.colourScheme.grassColour);
        canvas.setStrokeStyle(this.colourScheme.grassColour);
        canvas.drawPolygon(this.floodplain);

        // Port, built out over the sea
        canvas.setFillStyle(bgColour);
        canvas.setStrokeStyle(bgColour);
        canvas.setLineWidth(1);
        for (const p of this.portLand) canvas.drawPolygon(p);
        canvas.setFillStyle(this.colourScheme.seaColour);
        canvas.setStrokeStyle(this.colourScheme.seaColour);
        for (const p of this.portWater) canvas.drawPolygon(p);

        // Parks
        canvas.setLineWidth(1);
        canvas.setFillStyle(this.colourScheme.grassColour);
        for (const p of this.parks) canvas.drawPolygon(p);

        // Beaches, over any park that reaches the water
        if (!this.heightmap) {
            canvas.setFillStyle(this.colourScheme.sandColour);
            canvas.setStrokeStyle(this.colourScheme.sandColour);
            for (const b of this.beaches) canvas.drawPolygon(b);
        }

        // River
        canvas.setFillStyle(this.colourScheme.seaColour);
        canvas.setStrokeStyle(this.colourScheme.seaColour);
        canvas.setLineWidth(1);
        canvas.drawPolygon(this.river);
        for (const l of this.lakes) canvas.drawPolygon(l);
        if (!this.heightmap) {
            // Woods: a green fill scattered with little tree symbols, as OpenStreetMap draws forest
            canvas.setFillPattern(this.woodPattern());
            canvas.setStrokeStyle(this.colourScheme.treeColour);
            for (const w of this.woods) canvas.drawPolygon(w);

            canvas.setFillStyle(this.colourScheme.sandColour);
            canvas.setStrokeStyle(this.colourScheme.sandColour);
            for (const b of this.sandBars) canvas.drawPolygon(b);

            // Footpaths
            canvas.setStrokeStyle(this.colourScheme.pathColour);
            canvas.setLineWidth(Math.max(0.6, 1.3 * this.domainController.zoom));
            for (const p of this.paths) canvas.drawPolyline(p);
            for (const p of this.pitchMarkings) canvas.drawPolyline(p);
            canvas.setLineWidth(1);
        }

        // Land use
        if (this.showZones && !this.heightmap) {
            canvas.setFillStyle(this.colourScheme.lowIncomeColour);
            canvas.setStrokeStyle(this.colourScheme.lowIncomeColour);
            for (const p of this.lowIncomeAreas) canvas.drawPolygon(p);
            canvas.setFillStyle(this.colourScheme.industrialColour);
            canvas.setStrokeStyle(this.colourScheme.industrialColour);
            for (const p of this.industrialAreas) canvas.drawPolygon(p);
        }

        // Road outline
        canvas.setStrokeStyle(this.colourScheme.minorRoadOutline);
        canvas.setLineWidth(this.colourScheme.outlineSize + this.colourScheme.minorWidth * this.domainController.zoom);
        for (const s of this.minorRoads) canvas.drawPolyline(s);
        for (const s of this.frontageRoads) canvas.drawPolyline(s);
        for (const s of this.industrialRoads) canvas.drawPolyline(s);

        canvas.setStrokeStyle(this.colourScheme.majorRoadOutline);
        canvas.setLineWidth(this.colourScheme.outlineSize + this.colourScheme.majorWidth * this.domainController.zoom);
        for (const s of this.majorRoads) canvas.drawPolyline(s);
        canvas.drawPolyline(this.secondaryRiver);

        canvas.setStrokeStyle(this.colourScheme.mainRoadOutline);
        canvas.setLineWidth(this.colourScheme.outlineSize + this.colourScheme.mainWidth * this.domainController.zoom);
        for (const s of this.mainRoads) canvas.drawPolyline(s);
        for (const s of this.coastlineRoads) canvas.drawPolyline(s);

        // Road inline
        canvas.setStrokeStyle(this.colourScheme.minorRoadColour);
        canvas.setLineWidth(this.colourScheme.minorWidth * this.domainController.zoom);
        for (const s of this.minorRoads) canvas.drawPolyline(s);
        for (const s of this.frontageRoads) canvas.drawPolyline(s);
        for (const s of this.industrialRoads) canvas.drawPolyline(s);
        canvas.setLineWidth(0.4 * this.colourScheme.minorWidth * this.domainController.zoom);
        for (const s of this.parkingAisles) canvas.drawPolyline(s);

        canvas.setStrokeStyle(this.colourScheme.majorRoadColour);
        canvas.setLineWidth(this.colourScheme.majorWidth * this.domainController.zoom);
        for (const s of this.majorRoads) canvas.drawPolyline(s);
        canvas.drawPolyline(this.secondaryRiver);

        canvas.setStrokeStyle(this.colourScheme.mainRoadColour);
        canvas.setLineWidth(this.colourScheme.mainWidth * this.domainController.zoom);
        for (const s of this.mainRoads) canvas.drawPolyline(s);
        for (const s of this.coastlineRoads) canvas.drawPolyline(s);

        // Railways
        canvas.setStrokeStyle(this.colourScheme.minorRoadOutline);
        canvas.setLineWidth(1.5 * this.domainController.zoom);
        for (const r of this.railways) canvas.drawPolyline(r);

        // Highways go over everything else
        const zoom = this.domainController.zoom;
        canvas.setStrokeStyle(this.colourScheme.highwayOutline);
        canvas.setLineWidth(this.colourScheme.outlineSize + this.colourScheme.rampWidth * zoom);
        for (const s of this.ramps) canvas.drawPolyline(s);
        canvas.setStrokeStyle(this.colourScheme.highwayColour);
        canvas.setLineWidth(this.colourScheme.rampWidth * zoom);
        for (const s of this.ramps) canvas.drawPolyline(s);

        canvas.setStrokeStyle(this.colourScheme.highwayOutline);
        canvas.setLineWidth(2 * this.colourScheme.outlineSize + this.colourScheme.highwayWidth * zoom);
        for (const s of this.highways) canvas.drawPolyline(s);
        canvas.setStrokeStyle(this.colourScheme.highwayColour);
        canvas.setLineWidth(this.colourScheme.highwayWidth * zoom);
        for (const s of this.highways) canvas.drawPolyline(s);
        // Central reservation of a dual carriageway
        canvas.setStrokeStyle(this.colourScheme.highwayOutline);
        canvas.setLineWidth(Math.max(0.5, 0.12 * this.colourScheme.highwayWidth * zoom));
        for (const s of this.highways) canvas.drawPolyline(s);

        canvas.setLineWidth(1);

        if (this.heightmap) {
            for (const b of this.buildingModels) {
                // Colour based on height

                const parsedRgb = Util.parseCSSColor(this.colourScheme.bgColour).map(v => Math.min(255, v + (b.height * 18)));
                canvas.setFillStyle(`rgb(${parsedRgb[0]},${parsedRgb[1]},${parsedRgb[2]})`);
                canvas.setStrokeStyle(`rgb(${parsedRgb[0]},${parsedRgb[1]},${parsedRgb[2]})`);
                canvas.drawPolygon(b.lotScreen);
            }
        } else {
            // Buildings
            if (!this.colourScheme.zoomBuildings || this.domainController.zoom >= 2) {
                canvas.setFillStyle(this.colourScheme.buildingColour);
                canvas.setStrokeStyle(this.colourScheme.buildingStroke);
                for (const b of this.lots) canvas.drawPolygon(b);
                for (const b of this.largeBuildings) canvas.drawPolygon(b);
                canvas.setLineWidth(Math.max(0.3, 0.25 * this.domainController.zoom));
                for (const f of this.fences) canvas.drawPolyline(f);
                canvas.setLineWidth(1);
                canvas.setFillStyle(this.colourScheme.lowIncomeBuildingColour);
                for (const b of this.lowIncomeLots) canvas.drawPolygon(b);
                canvas.setFillStyle(this.colourScheme.industrialBuildingColour);
                for (const b of this.industrialLots) canvas.drawPolygon(b);
            }

            // Pseudo-3D
            if (this.colourScheme.buildingModels && (!this.colourScheme.zoomBuildings || this.domainController.zoom >= 2.5)) {
                canvas.setFillStyle(this.colourScheme.buildingSideColour);
                canvas.setStrokeStyle(this.colourScheme.buildingSideColour);

                // This is a cheap approximation that often creates visual artefacts
                // Draws building sides, then rooves instead of properly clipping polygons etc.
                for (const b of this.buildingModels) {
                    for (const s of b.sides) canvas.drawPolygon(s);
                }
                canvas.setStrokeStyle(this.colourScheme.buildingStroke);
                for (const b of this.buildingModels) {
                    canvas.setFillStyle(this.roofColour(b.zone));
                    canvas.drawPolygon(b.roof);
                }
            }

            if (this.colourScheme.floatingLabels) this.drawFloatingLabels(canvas);
        }

        if (this.showFrame) {
            canvas.setFillStyle(this.colourScheme.frameColour);
            canvas.setStrokeStyle(this.colourScheme.frameColour);
            canvas.drawFrame(30, 30, 30, 30);

            // canvas.setFillStyle(this.colourScheme.frameTextColour);
            // canvas.drawCityName();
        }
    }
}

export class RoughStyle extends Style {
    private dragging = false;

    constructor(c: HTMLCanvasElement, dragController: DragController, colourScheme: ColourScheme) {
        super(dragController, colourScheme);
        this.canvas = this.createCanvasWrapper(c, 1, true);
    }

    public createCanvasWrapper(c: HTMLCanvasElement, scale=1, resizeToWindow=true): CanvasWrapper {
        return new RoughCanvasWrapper(c, scale, resizeToWindow);
    }

    public update() {
        const dragging = this.dragController.isDragging || this.domainController.isScrolling;
        if (!dragging && this.dragging) this.canvas.needsUpdate = true;
        this.dragging = dragging;
    }

    public draw(canvas=this.canvas as RoughCanvasWrapper): void {
        canvas.setOptions({
            fill: this.colourScheme.bgColour,
            roughness: 1,
            bowing: 1,
            fillStyle: 'solid',
            stroke: "none",
        });

        canvas.clearCanvas();

        // Sea
        canvas.setOptions({
            roughness: 0,
            fillWeight: 1,
            fill: this.colourScheme.seaColour,
            fillStyle: 'solid',
            stroke: "none",
            strokeWidth: 1,
        });

        canvas.drawPolygon(this.seaPolygon);

        canvas.setOptions({
            fill: this.colourScheme.grassColour,
            stroke: "none",
        });
        canvas.drawPolygon(this.floodplain);

        canvas.setOptions({
            roughness: 0,
            fillWeight: 1,
            fill: this.colourScheme.seaColour,
            fillStyle: 'solid',
            stroke: "none",
            strokeWidth: 1,
        });

        canvas.drawPolygon(this.river);
        this.lakes.forEach(l => canvas.drawPolygon(l));
        canvas.setOptions({
            fill: this.colourScheme.sandColour,
        });
        this.sandBars.forEach(b => canvas.drawPolygon(b));

        // Port
        canvas.setOptions({
            fill: this.colourScheme.bgColour,
        });
        this.portLand.forEach(p => canvas.drawPolygon(p));
        canvas.setOptions({
            fill: this.colourScheme.seaColour,
        });
        this.portWater.forEach(p => canvas.drawPolygon(p));

        // Parks
        canvas.setOptions({
            fill: this.colourScheme.grassColour,
        });
        this.parks.forEach(p => canvas.drawPolygon(p));
        canvas.setOptions({
            fill: this.colourScheme.sandColour,
        });
        this.beaches.forEach(b => canvas.drawPolygon(b));
        canvas.setOptions({
            fill: this.colourScheme.seaColour,
        });
        this.lakes.forEach(l => canvas.drawPolygon(l));
        canvas.setOptions({
            fill: this.colourScheme.treeColour,
            fillStyle: 'hachure',
            hachureGap: 3,
            hachureAngle: -41,
        });
        this.woods.forEach(w => canvas.drawPolygon(w));
        canvas.setOptions({
            fillStyle: 'solid',
        });
        canvas.setOptions({
            stroke: this.colourScheme.minorRoadColour,
            strokeWidth: 0.6,
            fill: 'none',
        });
        this.paths.forEach(p => canvas.drawPolyline(p));
        this.pitchMarkings.forEach(p => canvas.drawPolyline(p));
        canvas.setOptions({
            stroke: 'none',
            strokeWidth: 1,
        });

        // Land use
        if (this.showZones) {
            canvas.setOptions({
                fill: this.colourScheme.lowIncomeColour,
            });
            this.lowIncomeAreas.forEach(p => canvas.drawPolygon(p));
            canvas.setOptions({
                fill: this.colourScheme.industrialColour,
            });
            this.industrialAreas.forEach(p => canvas.drawPolygon(p));
        }

        // Roads
        canvas.setOptions({
            stroke: this.colourScheme.minorRoadColour,
            strokeWidth: 1,
            fill: 'none',
        });

        this.minorRoads.forEach(s => canvas.drawPolyline(s));
        this.frontageRoads.forEach(s => canvas.drawPolyline(s));
        this.industrialRoads.forEach(s => canvas.drawPolyline(s));

        canvas.setOptions({
            strokeWidth: 2,
            stroke: this.colourScheme.majorRoadColour,
        });

        this.majorRoads.forEach(s => canvas.drawPolyline(s));
        canvas.drawPolyline(this.secondaryRiver);

        canvas.setOptions({
            strokeWidth: 3,
            stroke: this.colourScheme.mainRoadColour,
        });

        this.mainRoads.forEach(s => canvas.drawPolyline(s));
        this.coastlineRoads.forEach(s => canvas.drawPolyline(s));

        canvas.setOptions({
            strokeWidth: 2,
            stroke: this.colourScheme.highwayColour,
        });
        this.ramps.forEach(s => canvas.drawPolyline(s));

        canvas.setOptions({
            strokeWidth: 5,
            stroke: this.colourScheme.highwayColour,
        });
        this.highways.forEach(s => canvas.drawPolyline(s));

        // Buildings
        if (!this.dragging) {
            // Lots
            if (!this.colourScheme.zoomBuildings || this.domainController.zoom >= 2) {
                // Lots
                canvas.setOptions({
                    roughness: 1.2,
                    stroke: this.colourScheme.buildingStroke,
                    strokeWidth: 1,
                    fill: '',
                });
                for (const b of this.lots) canvas.drawPolygon(b);
                for (const b of this.largeBuildings) canvas.drawPolygon(b);
                for (const b of this.lowIncomeLots) canvas.drawPolygon(b);
                for (const b of this.industrialLots) canvas.drawPolygon(b);
                canvas.setOptions({
                    strokeWidth: 0.4,
                });
                for (const f of this.fences) canvas.drawPolyline(f);
            }

            // Pseudo-3D
            if (this.colourScheme.buildingModels && (!this.colourScheme.zoomBuildings || this.domainController.zoom >= 2.5)) {
                // Pseudo-3D
                canvas.setOptions({
                    roughness: 1.2,
                    stroke: this.colourScheme.buildingStroke,
                    strokeWidth: 1,
                    fill: this.colourScheme.buildingSideColour,
                });

                // TODO this can be hugely improved
                const allSidesDistances: any[] = [];
                const camera = this.domainController.getCameraPosition();
                for (const b of this.buildingModels) {
                    for (const s of b.sides) {
                        const averagePoint = s[0].clone().add(s[1]).divideScalar(2);
                        allSidesDistances.push([averagePoint.distanceToSquared(camera), s]);
                    }
                }
                allSidesDistances.sort((a, b) => b[0] - a[0]);
                for (const p of allSidesDistances) canvas.drawPolygon(p[1]);

                canvas.setOptions({
                    roughness: 1.2,
                    stroke: this.colourScheme.buildingStroke,
                    strokeWidth: 1,
                    fill: this.colourScheme.buildingColour,
                });

                for (const b of this.buildingModels) canvas.drawPolygon(b.roof);
            }
        }
    }
}

/**
 * Looks like the standard OpenStreetMap map (OpenStreetMap Carto): its colours, road classes,
 * land use fills, dashed footpaths, bridges and labels.
 * At zoom 1 (1 world unit = 2 m per pixel) widths and text sizes match OSM zoom 16
 */
export class OsmStyle extends DefaultStyle {
    constructor(c: HTMLCanvasElement, dragController: DragController, colourScheme: ColourScheme) {
        super(c, dragController, colourScheme);
        const cs = this.colourScheme;
        if (!cs.residentialColour) cs.residentialColour = '#e0dfdf';
        if (!cs.tertiaryRoadColour) cs.tertiaryRoadColour = '#ffffff';
        if (!cs.tertiaryRoadOutline) cs.tertiaryRoadOutline = '#8f8f8f';
        if (!cs.serviceRoadColour) cs.serviceRoadColour = '#ffffff';
        if (!cs.serviceRoadOutline) cs.serviceRoadOutline = '#bbbbbb';
        if (!cs.footwayColour) cs.footwayColour = '#fa8072';
        if (!cs.pitchColour) cs.pitchColour = '#aae0cb';
        if (!cs.pitchOutline) cs.pitchOutline = '#88cfb0';
        if (!cs.bridgeOutline) cs.bridgeOutline = '#000000';
        if (!cs.labelColour) cs.labelColour = '#222222';
        if (!cs.waterLabelColour) cs.waterLabelColour = '#4d80b3';
        if (!cs.parkLabelColour) cs.parkLabelColour = '#3c7a43';
        if (!cs.placeLabelColour) cs.placeLabelColour = '#666666';
        if (!cs.shieldColour) cs.shieldColour = '#f3c4ce';
        if (!cs.shieldOutline) cs.shieldOutline = '#c2406a';
        if (!cs.retailColour) cs.retailColour = '#ffd6d1';
        if (!cs.retailOutline) cs.retailOutline = '#d99c95';
        if (!cs.parkingColour) cs.parkingColour = '#eeeeee';
        if (!cs.parkingOutline) cs.parkingOutline = '#d4d4d4';
        if (!cs.poolOutline) cs.poolOutline = '#78bed2';
        if (!cs.shopLabelColour) cs.shopLabelColour = '#ac39ac';
        if (!cs.fontFamily) cs.fontFamily = '"Noto Sans", "DejaVu Sans", "Helvetica Neue", Arial, sans-serif';
    }

    /**
     * Pixel mask of the river and lakes, to find where roads become bridges
     */
    private waterMask(width: number, height: number): (p: Vector) => boolean {
        const c = document.createElement('canvas');
        c.width = Math.ceil(width);
        c.height = Math.ceil(height);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#000';
        for (const poly of [this.river].concat(this.lakes)) {
            if (poly.length < 3) continue;
            ctx.beginPath();
            ctx.moveTo(poly[0].x, poly[0].y);
            for (const v of poly) ctx.lineTo(v.x, v.y);
            ctx.closePath();
            ctx.fill();
        }
        const data = ctx.getImageData(0, 0, c.width, c.height).data;
        return (p: Vector): boolean => {
            const x = Math.round(p.x);
            const y = Math.round(p.y);
            if (x < 0 || y < 0 || x >= c.width || y >= c.height) return false;
            return data[4 * (y * c.width + x) + 3] > 128;
        };
    }

    /**
     * Stretches of road over water, with a little margin onto the banks
     */
    private static bridgeRuns(line: Vector[], wet: (p: Vector) => boolean): Vector[][] {
        const runs: Vector[][] = [];
        const STEP = 2;
        const pts: Vector[] = [];
        for (let i = 0; i < line.length - 1; i++) {
            const a = line[i];
            const b = line[i + 1];
            const n = Math.max(1, Math.ceil(a.distanceTo(b) / STEP));
            for (let k = 0; k < n; k++) pts.push(a.clone().add(b.clone().sub(a).multiplyScalar(k / n)));
        }
        if (line.length > 0) pts.push(line[line.length - 1]);
        let i = 0;
        while (i < pts.length) {
            if (!wet(pts[i])) {
                i++;
                continue;
            }
            let j = i;
            while (j < pts.length && wet(pts[j])) j++;
            const from = Math.max(0, i - 3);
            const to = Math.min(pts.length - 1, j + 2);
            if (to - from >= 2) runs.push(pts.slice(from, to + 1));
            i = j;
        }
        return runs;
    }

    private strokeAll(canvas: DefaultCanvasWrapper, lines: Vector[][], colour: string, width: number): void {
        canvas.setStrokeStyle(colour);
        canvas.setLineWidth(width);
        for (const l of lines) canvas.drawPolyline(l);
    }

    public draw(canvas=this.canvas as DefaultCanvasWrapper): void {
        const cs = this.colourScheme;
        const zoom = this.domainController.zoom;
        canvas.setRoundLines(false);
        canvas.setLineDash([]);

        canvas.setFillStyle(cs.bgColour);
        canvas.clearCanvas();

        const fillAll = (polygons: Vector[][], colour: string, stroke = colour, width = 1): void => {
            canvas.setFillStyle(colour);
            canvas.setStrokeStyle(stroke);
            canvas.setLineWidth(width);
            for (const p of polygons) if (p.length >= 3) canvas.drawPolygon(p);
        };

        // Land use. Like OpenStreetMap's residential areas, it covers whole neighbourhoods,
        // streets included, but not the land along the freeways
        const screen = this.domainController.screenDimensions;
        fillAll([[new Vector(-50, -50), new Vector(screen.x + 50, -50), new Vector(screen.x + 50, screen.y + 50), new Vector(-50, screen.y + 50)]],
            cs.residentialColour);
        fillAll(this.corridors, cs.bgColour);
        fillAll(this.residentialAreas, cs.residentialColour);
        fillAll(this.industrialAreas, cs.industrialColour);
        fillAll(this.retailAreas, cs.retailColour, cs.retailOutline, 0.8);
        fillAll(this.parkingLots, cs.parkingColour, cs.parkingOutline, 0.8);

        // Green spaces
        fillAll([this.floodplain], cs.grassColour);
        fillAll(this.parks, cs.grassColour);
        fillAll(this.pitches, cs.pitchColour, cs.pitchOutline, 0.8);
        canvas.setFillPattern(this.woodPattern());
        canvas.setStrokeStyle(cs.treeColour);
        canvas.setLineWidth(1);
        for (const w of this.woods) canvas.drawPolygon(w);

        // Water
        fillAll([this.seaPolygon], cs.seaColour, cs.seaColour, 0.5);
        // Port quays are built out over the sea
        fillAll(this.portLand, cs.industrialColour);
        fillAll(this.portWater, cs.seaColour);
        fillAll(this.beaches, cs.sandColour);
        fillAll([this.river], cs.seaColour);
        fillAll(this.lakes, cs.seaColour);
        fillAll(this.sandBars, cs.sandColour);

        // Buildings sit under the roads, as on OpenStreetMap
        const buildings = this.lots.concat(this.lowIncomeLots);
        fillAll(buildings, cs.buildingColour, cs.buildingStroke, 0.6);
        fillAll(this.industrialLots, cs.industrialBuildingColour, cs.buildingStroke, 0.6);
        fillAll(this.largeBuildings, cs.buildingColour, cs.buildingStroke, 0.6);
        fillAll(this.pools, cs.seaColour, cs.poolOutline, 0.8);

        // Footpaths: a faint light casing under a dashed salmon line
        canvas.setRoundLines(true);
        this.strokeAll(canvas, this.paths, 'rgba(255,255,255,0.55)', 3 * Math.max(0.7, zoom));
        canvas.setLineDash([2.5, 2]);
        this.strokeAll(canvas, this.paths, cs.footwayColour, 1.3 * Math.max(0.7, zoom));
        canvas.setLineDash([]);

        // Road classes, from least to most important
        const names = this.names;
        const primary: Vector[][] = this.mainRoads.slice();
        const secondary: Vector[][] = [];
        const tertiary: Vector[][] = [];
        this.majorRoads.forEach((r, i) => {
            const c = names ? names.majorClass[i] : 'tertiary';
            (c === 'primary' ? primary : c === 'secondary' ? secondary : tertiary).push(r);
        });
        if (this.secondaryRiver.length >= 2) secondary.push(this.secondaryRiver);
        secondary.push(...this.coastlineRoads);
        secondary.push(...this.frontageRoads);

        const w = (width: number): number => width * zoom;
        const classes: {lines: Vector[][]; fill: string; casing: string; width: number; casingWidth: number}[] = [
            {lines: this.parkingAisles, fill: cs.serviceRoadColour, casing: cs.serviceRoadOutline, width: w(0.35 * cs.minorWidth), casingWidth: 0.8},
            {lines: this.industrialRoads, fill: cs.serviceRoadColour, casing: cs.serviceRoadOutline, width: w(0.6 * cs.minorWidth), casingWidth: 1},
            {lines: this.minorRoads, fill: cs.minorRoadColour, casing: cs.minorRoadOutline, width: w(cs.minorWidth), casingWidth: 1.2},
            {lines: tertiary, fill: cs.tertiaryRoadColour, casing: cs.tertiaryRoadOutline, width: w(cs.majorWidth * 0.9), casingWidth: 1.4},
            {lines: secondary, fill: cs.majorRoadColour, casing: cs.majorRoadOutline, width: w(cs.majorWidth), casingWidth: 1.6},
            {lines: primary, fill: cs.mainRoadColour, casing: cs.mainRoadOutline, width: w(cs.mainWidth), casingWidth: 1.6},
            {lines: this.ramps, fill: cs.highwayColour, casing: cs.highwayOutline, width: w(cs.rampWidth), casingWidth: 1.6},
        ];
        for (const c of classes) this.strokeAll(canvas, c.lines, c.casing, c.width + c.casingWidth);
        for (const c of classes) this.strokeAll(canvas, c.lines, c.fill, c.width);

        // Railway: grey with white dashes, over the smaller roads it crosses
        const wet = this.waterMask(this.domainController.screenDimensions.x, this.domainController.screenDimensions.y);
        const railBridges: Vector[][] = [];
        for (const r of this.railways) railBridges.push(...OsmStyle.bridgeRuns(r, wet));
        this.strokeAll(canvas, railBridges, cs.bridgeOutline, 6.5);
        this.strokeAll(canvas, railBridges, cs.bgColour, 5);
        this.strokeAll(canvas, this.railways, '#707070', 3);
        canvas.setLineDash([8, 8]);
        this.strokeAll(canvas, this.railways, '#ffffff', 1);
        canvas.setLineDash([]);

        // Freeways: two carriageways side by side
        const hw = w(cs.highwayWidth);
        this.strokeAll(canvas, this.highways, cs.highwayOutline, hw + 2);
        this.strokeAll(canvas, this.highways, cs.highwayColour, hw);
        this.strokeAll(canvas, this.highways, cs.highwayOutline, Math.max(1.5, 0.16 * hw));
        this.strokeAll(canvas, this.highways, cs.bgColour, Math.max(0.6, 0.07 * hw));

        // Bridges over the river, with the black casing OpenStreetMap gives bridges
        classes.push({lines: this.highways, fill: cs.highwayColour, casing: cs.highwayOutline, width: hw, casingWidth: 2});
        canvas.setRoundLines(false);
        for (const c of classes) {
            const runs: Vector[][] = [];
            for (const l of c.lines) runs.push(...OsmStyle.bridgeRuns(l, wet));
            if (runs.length === 0) continue;
            this.strokeAll(canvas, runs, cs.bridgeOutline, c.width + c.casingWidth + 1.6);
            this.strokeAll(canvas, runs, c.casing, c.width + c.casingWidth);
            this.strokeAll(canvas, runs, c.fill, c.width);
            if (c.lines === this.highways) {
                this.strokeAll(canvas, runs, cs.highwayOutline, Math.max(1.5, 0.16 * hw));
            }
        }
        canvas.setRoundLines(false);

        this.drawLabels(canvas);
    }

    /**
     * Furthest point of open water from the shore, for the name of the sea
     */
    private seaLabelPoint(width: number, height: number): Vector {
        if (this.seaPolygon.length < 3) return null;
        const shore = this.seaPolygon.filter((_, i) => i % 2 === 0);
        let best: Vector = null;
        let bestD = 0;
        for (let x = 60; x < width - 60; x += 24) {
            for (let y = 40; y < height - 40; y += 24) {
                const p = new Vector(x, y);
                if (!PolygonUtil.insidePolygon(p, this.seaPolygon)) continue;
                if (this.portLand.some(l => PolygonUtil.insidePolygon(p, l))) continue;
                let d = Infinity;
                for (const v of shore) {
                    // Edges of the screen count as shore, so the label stays in view
                    if (v.x < 0 || v.y < 0 || v.x > width || v.y > height) continue;
                    d = Math.min(d, v.distanceToSquared(p));
                }
                d = Math.min(d, (x - 0) ** 2, (width - x) ** 2, (y - 0) ** 2, (height - y) ** 2);
                if (d > bestD) {
                    bestD = d;
                    best = p;
                }
            }
        }
        return best;
    }

    private drawLabels(canvas: DefaultCanvasWrapper): void {
        const names = this.names;
        if (!names) return;
        const cs = this.colourScheme;
        const screen = this.domainController.screenDimensions;
        const labeller = new Labeller(canvas, screen.x, screen.y);
        const font = (size: number, extra = ''): string => `${extra} ${size}px ${cs.fontFamily}`.trim();
        const halo = 'rgba(255,255,255,0.8)';
        const style = (size: number, fill: string, extra = '', repeat = 420, haloWidth = 1.2): LabelStyle =>
            ({font: font(size, extra), size, fill, halo, haloWidth, repeat});

        // Sea
        if (this.seaName) {
            const p = this.seaLabelPoint(screen.x, screen.y);
            if (p) labeller.labelPoint(p, this.seaName, style(17, cs.waterLabelColour, 'italic', 0, 1), 30);
        }

        // Freeway numbers, then names
        this.highways.forEach((h, i) => {
            labeller.shieldLine(h, names.highwayRefs[i], style(10, '#000000', 'bold', 520, 0), cs.shieldColour, cs.shieldOutline);
        });
        this.highways.forEach((h, i) => labeller.labelLine(h, names.highways[i], style(11, cs.labelColour, '', 520)));

        // The mall and its car park
        for (const l of this.placeLabels) {
            if (l.kind === 'mall') labeller.labelPoint(l.at, l.text, style(11.5, cs.shopLabelColour, 'bold', 0, 1.5), 16);
        }
        const parkingStyle: LabelStyle = {font: font(13, 'bold'), size: 13, fill: '#0092da', halo: halo, haloWidth: 1};
        for (const lot of this.parkingLots) {
            if (PolygonUtil.calcPolygonArea(lot) < 3000) continue;
            // In the open part of the car park, towards the street
            const c = PolygonUtil.averagePoint(lot);
            for (const p of lot.filter((_, i) => i % Math.max(1, Math.floor(lot.length / 6)) === 0)) {
                const at = c.clone().add(p.clone().sub(c).multiplyScalar(0.6));
                if (labeller.labelPoint(at, 'P', parkingStyle)) break;
            }
        }

        // Neighbourhoods
        for (const l of this.placeLabels) {
            if (l.kind === 'neighbourhood') {
                labeller.labelPoint(l.at, l.text, style(13, cs.placeLabelColour, '', 0, 1.5), 12);
            }
        }

        // River
        if (this.riverName && this.riverCentreline.length >= 2) {
            labeller.labelLine(this.riverCentreline, this.riverName,
                Object.assign(style(11.5, cs.waterLabelColour, 'italic', 560), {maxBend: 0.5}));
        }

        // Roads, most important first
        this.mainRoads.forEach((r, i) => labeller.labelLine(r, names.main[i], style(11, cs.labelColour)));
        this.coastlineRoads.forEach((r, i) => labeller.labelLine(r, names.coast[i], style(10.5, cs.labelColour)));
        if (this.secondaryRiver.length >= 2) {
            labeller.labelLine(this.secondaryRiver, names.coast[names.coast.length - 1], style(10.5, cs.labelColour));
        }
        this.majorRoads.forEach((r, i) => labeller.labelLine(r, names.major[i], style(10.5, cs.labelColour)));
        this.frontageRoads.forEach((r, i) => labeller.labelLine(r, names.frontage[i], style(10, cs.labelColour, '', 460)));
        this.minorRoads.forEach((r, i) => labeller.labelLine(r, names.minor[i], style(10, cs.labelColour, '', 360)));

        // Parks
        for (const l of this.placeLabels) {
            if (l.kind === 'park') labeller.labelPoint(l.at, l.text, style(11, cs.parkLabelColour, '', 0, 1.2), 14);
        }
        for (const l of this.placeLabels) {
            if (l.kind === 'apartments') labeller.labelPoint(l.at, l.text, style(10, '#555555', '', 0, 1.2), 16);
        }

        this.drawPointsOfInterest(canvas, labeller);
    }

    /**
     * A sprinkling of map symbols: churches among the houses, car parks by the warehouses
     */
    private drawPointsOfInterest(canvas: DefaultCanvasWrapper, labeller: Labeller): void {
        const zoom = this.domainController.zoom;
        const poi = PointsOfInterest.select(this.residentialAreas, this.lots, this.industrialAreas, 60 * zoom);

        // Places of worship: a black cross on the church
        for (const church of poi.churches) {
            const at = PolygonUtil.averagePoint(church);
            if (!labeller.reserve(at, 5, 7)) continue;
            canvas.setStrokeStyle('#000000');
            canvas.setLineWidth(1.5);
            canvas.drawPolyline([new Vector(at.x, at.y - 5.5), new Vector(at.x, at.y + 5.5)]);
            canvas.drawPolyline([new Vector(at.x - 3.5, at.y - 2), new Vector(at.x + 3.5, at.y - 2)]);
        }

        // Car parks: a blue P
        const parking: LabelStyle = {font: `bold 13px ${this.colourScheme.fontFamily}`, size: 13, fill: '#0092da', halo: 'rgba(255,255,255,0.8)', haloWidth: 1};
        for (const p of poi.parking) labeller.labelPoint(p, 'P', parking);
    }
}
