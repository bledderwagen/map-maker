import FieldIntegrator from '../impl/integrator';
import {StreamlineParams} from '../impl/streamlines';
import HighwayGenerator from '../impl/highway_generator';
import {HighwayParams, Interchange} from '../impl/highway_generator';
import TensorField from '../impl/tensor_field';
import Vector from '../vector';
import RoadGUI from './road_gui';

/**
 * Handles generation of highways, their frontage roads and interchanges
 */
export default class HighwayGUI extends RoadGUI {
    protected streamlines: HighwayGenerator;

    constructor(private tensorField: TensorField,
                protected params: HighwayParams,
                integrator: FieldIntegrator,
                guiFolder: dat.GUI,
                closeTensorFolder: () => void,
                folderName: string,
                redraw: () => void) {
        super(params, integrator, guiFolder, closeTensorFolder, folderName, redraw);
        this.streamlines = this.createGenerator();
    }

    initFolder(): HighwayGUI {
        const folder = this.guiFolder.addFolder(this.folderName);
        folder.add({Generate: () => this.generateRoads().then(() => this.redraw())}, 'Generate');
        folder.add(this.params, 'numHighways', 0, 4).step(1);
        folder.add(this.params, 'frontageRoads');

        const paramsFolder = folder.addFolder('Params');
        paramsFolder.add(this.params, 'dsep');
        paramsFolder.add(this.params, 'frontageDistance');
        paramsFolder.add(this.params, 'interchangeSize');

        const devParamsFolder = paramsFolder.addFolder('Dev');
        this.addDevParamsToFolder(this.params, devParamsFolder);
        return this;
    }

    private createGenerator(): HighwayGenerator {
        const area = this.domainController.generationArea;
        return new HighwayGenerator(
            this.integrator, area.origin, area.size,
            Object.assign({}, this.params), this.tensorField);
    }

    async generateRoads(): Promise<void> {
        this.preGenerateCallback();

        this.streamlines = this.createGenerator();

        this.streamlines.createHighways();

        this.closeTensorFolder();
        this.redraw();
        this.postGenerateCallback();
    }

    /**
     * Must be called after the roads that cross highways have been generated
     */
    createInterchanges(roads: Vector[][]): void {
        this.streamlines.createInterchanges(roads);
    }

    /**
     * Highways and frontage roads, used for finding blocks
     */
    get allStreamlines(): Vector[][] {
        return this.streamlines.highways.concat(this.streamlines.frontageRoads);
    }

    get highwaysWorld(): Vector[][] {
        return this.streamlines.highways;
    }

    get interchanges(): Interchange[] {
        return this.streamlines.interchanges;
    }

    get roads(): Vector[][] {
        return this.toScreen(this.streamlines.highways);
    }

    get frontageRoads(): Vector[][] {
        return this.toScreen(this.streamlines.frontageRoads);
    }

    replaceFrontageRoads(roads: Vector[][]): void {
        this.streamlines.frontageRoads = RoadGUI.withoutDuplicatePoints(roads);
    }

    get frontageRoadsWorld(): Vector[][] {
        return this.streamlines.frontageRoads;
    }

    get rampsWorld(): Vector[][] {
        const ramps: Vector[][] = [];
        for (const i of this.streamlines.interchanges) ramps.push(...i.ramps);
        return ramps;
    }

    get ramps(): Vector[][] {
        const ramps: Vector[][] = [];
        for (const i of this.streamlines.interchanges) ramps.push(...i.ramps);
        return this.toScreen(ramps);
    }

    roadsEmpty(): boolean {
        return this.streamlines.highways.length === 0;
    }

    private toScreen(lines: Vector[][]): Vector[][] {
        return lines.map(s => s.map(v => this.domainController.worldToScreen(v.clone())));
    }

    protected addDevParamsToFolder(params: StreamlineParams, folder: dat.GUI): void {
        folder.add(params, 'dtest');
        folder.add(params, 'seedTries');
        folder.add(params, 'dstep');
        folder.add(params, 'simplifyTolerance');
    }
}
