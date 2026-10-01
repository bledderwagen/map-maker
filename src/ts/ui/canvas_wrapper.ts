import * as log from 'loglevel';
import Vector from '../vector';
import { SVG } from '@svgdotjs/svg.js';
import Util from '../util';

export interface RoughOptions {
    roughness?: number;
    bowing?: number;
    seed?: number;
    stroke?: string;
    strokeWidth?: number;
    fill?: string;
    fillStyle?: string;
    fillWeight?: number;
    hachureAngle?: number;
    hachureGap?: number;
    dashOffset?: number;
    dashGap?: number;
    zigzagOffset?: number;
}

/**
 * Thin wrapper around HTML canvas, abstracts drawing functions so we can use the RoughJS canvas or the default one
 */
export default abstract class CanvasWrapper {
    protected svgNode: any;
    protected _width: number;
    protected _height: number;
    public needsUpdate: boolean = false;

    constructor(private canvas: HTMLCanvasElement, protected _scale=1, resizeToWindow=true) {
        this.setDimensions();
        this.resizeCanvas();
        if (resizeToWindow) {
            window.addEventListener('resize', (): void => {
                this.setDimensions();
                this.resizeCanvas();
            });
        }
    }

    protected appendSvgNode(node: any): void {
        if (this.svgNode) {
            this.svgNode.appendChild(node);
        }
    }

    createSVG(svgElement: any): void {
        this.svgNode = svgElement;
    }

    abstract drawFrame(left: number, right: number, up: number, down: number): void;

    setDimensions(): void {
        this._width = window.innerWidth * this._scale;
        this._height = window.innerHeight * this._scale;
    }

    get width(): number {
        return this._width;
    }

    get height(): number {
        return this._height;
    }

    get canvasScale(): number {
        return this._scale;
    }

    set canvasScale(s: number) {
        this._scale = s;
        this.setDimensions();
        this.resizeCanvas();
    }

    protected zoomVectors(vs: Vector[]): Vector[] {
        if (this._scale === 1) return vs;
        return vs.map(v => v.clone().multiplyScalar(this._scale));
    }

    protected resizeCanvas(): void {
        this.canvas.width = this._width;
        this.canvas.height = this._height;
        this.needsUpdate = true;
    }
}

export class DefaultCanvasWrapper extends CanvasWrapper {
    private ctx: CanvasRenderingContext2D;
    private svg: any;
    private svgFill: string = null;

    constructor(canvas: HTMLCanvasElement, scale=1, resizeToWindow=true) {
        super(canvas, scale, resizeToWindow);
        this.ctx = canvas.getContext("2d");
        this.ctx.fillStyle = 'black';
        this.ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    }

    createSVG(svgElement: any): void {
        super.createSVG(svgElement);
        this.svg = SVG(svgElement);
    }

    setFillStyle(colour: string): void {
        this.ctx.fillStyle = colour;
        this.svgFill = null;
    }

    /**
     * Fill with a repeating image tile, like the symbol patterns on OpenStreetMap
     * The tile is in screen pixels, so the pattern stays the same size when zooming
     */
    setFillPattern(tile: HTMLCanvasElement): void {
        const pattern = this.ctx.createPattern(tile, 'repeat');
        if (pattern === null) return;
        if (this._scale !== 1 && (pattern as any).setTransform) {
            (pattern as any).setTransform(new DOMMatrix().scale(this._scale, this._scale));
        }
        this.ctx.fillStyle = pattern;
        this.svgFill = null;
        if (this.svg) {
            try {
                const url = tile.toDataURL();
                const svgPattern = this.svg.pattern(tile.width, tile.height, (add: any) => {
                    add.image(url).size(tile.width, tile.height);
                });
                this.svgFill = svgPattern.url();
            } catch (e) {
                this.svgFill = null;
            }
        }
    }

    private svgFillValue(): string {
        if (this.svgFill !== null) return this.svgFill;
        return typeof this.ctx.fillStyle === 'string' ? this.ctx.fillStyle : 'none';
    }

    clearCanvas(): void {
        if (this.svgNode) {
            // Expanded to cover whole drawn area
            const startW = window.innerWidth * (Util.DRAW_INFLATE_AMOUNT - 1) / 2;
            const startH = window.innerHeight * (Util.DRAW_INFLATE_AMOUNT - 1) / 2;
            this.drawRectangle(-startW, -startH, window.innerWidth * Util.DRAW_INFLATE_AMOUNT, window.innerHeight * Util.DRAW_INFLATE_AMOUNT);
        } else {
            this.drawRectangle(0, 0, window.innerWidth, window.innerHeight);
        }
    }

    drawFrame(left: number, right: number, up: number, down: number): void {
        this.drawRectangle(0, 0, this._width/this._scale, up);
        this.drawRectangle(0, 0, left, this._height/this._scale);
        this.drawRectangle(this._width/this._scale - right, 0, right, this._height/this._scale);
        this.drawRectangle(0, this._height/this._scale - down, this._width/this._scale, down);
    }

    drawCityName(): void {
        const fontSize = 50 * this._scale;
        this.ctx.font = `small-caps ${fontSize}px Verdana`;
        this.ctx.textAlign = "center";
        this.ctx.fillText("san francisco", this._width/2, this._height - (80 * this._scale - fontSize));
    }

    drawRectangle(x: number, y: number, width: number, height: number): void {
        if (this._scale !== 1) {
            x *= this._scale;
            y *= this._scale;
            width *= this._scale;
            height *= this._scale;
        }
        this.ctx.fillRect(x, y, width, height);

        if (this.svg) {
            this.svg.rect({
                fill: this.svgFillValue(),
                'fill-opacity': 1,
                stroke: this.ctx.strokeStyle,
                'stroke-width': this.ctx.lineWidth,
                x: x,
                y: y,
                width: width,
                height: height,
            });
        }
    }

    drawPolygon(polygon: Vector[]): void {
        if (polygon.length === 0) {
            return;
        }
        polygon = this.zoomVectors(polygon);

        this.ctx.beginPath();
        this.ctx.moveTo(polygon[0].x, polygon[0].y);

        for (let i = 1; i < polygon.length; i++) {
            this.ctx.lineTo(polygon[i].x, polygon[i].y);
        }
        this.ctx.lineTo(polygon[0].x, polygon[0].y);

        this.ctx.fill();
        this.ctx.stroke();

        if (this.svg) {
            const vectorArray = polygon.map(v => [v.x, v.y]);
            vectorArray.push(vectorArray[0]);
            this.svg.polyline(vectorArray).attr({
                fill: this.svgFillValue(),
                'fill-opacity': 1,
                stroke: this.ctx.strokeStyle,
                'stroke-width': this.ctx.lineWidth,
            });
        }
    }

    drawCircle(centre: Vector, radius: number): void {
        const TAU = 2 * Math.PI;
        this.ctx.beginPath();
        this.ctx.arc(centre.x, centre.y, radius, 0, TAU);
        this.ctx.fill();
    }

    drawSquare(centre: Vector, radius: number): void {
        this.drawRectangle(centre.x - radius, centre.y - radius, 2 * radius, 2 * radius);
    }

    setLineWidth(width: number): void {
        if (this._scale !== 1) {
            width *= this._scale;
        }
        this.ctx.lineWidth = width;
    }

    setStrokeStyle(colour: string): void {
        this.ctx.strokeStyle = colour;
    }

    /**
     * Dash lengths in screen pixels, empty for a solid line
     */
    setLineDash(dash: number[]): void {
        this.ctx.setLineDash(dash.map(d => d * this._scale));
    }

    /**
     * Round ends and joins, as road maps draw roads
     */
    setRoundLines(round: boolean): void {
        this.ctx.lineCap = round ? 'round' : 'butt';
        this.ctx.lineJoin = round ? 'round' : 'miter';
    }

    /**
     * Width of text in screen pixels
     */
    measureText(text: string, font: string): number {
        this.ctx.save();
        this.ctx.setTransform(1, 0, 0, 1, 0, 0);
        this.ctx.font = font;
        const w = this.ctx.measureText(text).width;
        this.ctx.restore();
        return w;
    }

    /**
     * Text centred on a point and rotated by angle, with a halo so it reads over roads
     * @param font CSS font with the size in screen pixels
     */
    drawText(text: string, at: Vector, angle: number, font: string, fill: string,
             halo: string, haloWidth: number): void {
        const s = this._scale;
        this.ctx.save();
        this.ctx.translate(at.x * s, at.y * s);
        this.ctx.rotate(angle);
        this.ctx.scale(s, s);
        this.ctx.font = font;
        this.ctx.textAlign = 'center';
        this.ctx.textBaseline = 'middle';
        this.ctx.setLineDash([]);
        if (haloWidth > 0) {
            this.ctx.lineJoin = 'round';
            this.ctx.strokeStyle = halo;
            this.ctx.lineWidth = 2 * haloWidth;
            this.ctx.strokeText(text, 0, 0);
        }
        this.ctx.fillStyle = fill;
        this.ctx.fillText(text, 0, 0);
        this.ctx.restore();

        if (this.svg) {
            const degrees = angle * 180 / Math.PI;
            this.svg.plain(text).attr({
                x: 0,
                y: 0,
                transform: `translate(${at.x * s},${at.y * s}) rotate(${degrees}) scale(${s})`,
                style: `font: ${font}`,
                'text-anchor': 'middle',
                'dominant-baseline': 'central',
                fill: fill,
                stroke: haloWidth > 0 ? halo : 'none',
                'stroke-width': 2 * haloWidth,
                'stroke-linejoin': 'round',
                'paint-order': 'stroke',
            });
        }
    }

    /**
     * Rounded rectangle centred on a point, for road number shields
     */
    drawRoundedRect(centre: Vector, width: number, height: number, radius: number): void {
        const s = this._scale;
        const x = (centre.x - width / 2) * s;
        const y = (centre.y - height / 2) * s;
        const w = width * s;
        const h = height * s;
        const r = radius * s;
        this.ctx.beginPath();
        this.ctx.moveTo(x + r, y);
        this.ctx.arcTo(x + w, y, x + w, y + h, r);
        this.ctx.arcTo(x + w, y + h, x, y + h, r);
        this.ctx.arcTo(x, y + h, x, y, r);
        this.ctx.arcTo(x, y, x + w, y, r);
        this.ctx.closePath();
        this.ctx.fill();
        this.ctx.stroke();

        if (this.svg) {
            this.svg.rect(w, h).move(x, y).radius(r).attr({
                fill: this.svgFillValue(),
                stroke: this.ctx.strokeStyle,
                'stroke-width': this.ctx.lineWidth,
            });
        }
    }

    drawPolyline(line: Vector[]): void {
        if (line.length < 2) {
            return;
        }

        line = this.zoomVectors(line);

        this.ctx.beginPath();
        this.ctx.moveTo(line[0].x, line[0].y);

        for (let i = 1; i < line.length; i++) {
            this.ctx.lineTo(line[i].x, line[i].y);
        }

        this.ctx.stroke();

        if (this.svg) {
            const vectorArray = line.map(v => [v.x, v.y]);
            const dash = this.ctx.getLineDash();
            this.svg.polyline(vectorArray).attr({
                'fill-opacity': 0,
                stroke: this.ctx.strokeStyle,
                'stroke-width': this.ctx.lineWidth,
                'stroke-linecap': this.ctx.lineCap,
                'stroke-linejoin': this.ctx.lineJoin,
                'stroke-dasharray': dash.length > 0 ? dash.join(' ') : 'none',
            });
        }
    }
}

export class RoughCanvasWrapper extends CanvasWrapper {
    private r = require('roughjs/bundled/rough.cjs');
    private rc: any;
        
    private options: RoughOptions = {
        roughness: 1,
        bowing: 1,
        stroke: '#000000',
        strokeWidth: 1,
        fill: '#000000',
        fillStyle: 'solid',
    };

    constructor(canvas: HTMLCanvasElement, scale=1, resizeToWindow=true) {
        super(canvas, scale, resizeToWindow);
        this.rc = this.r.canvas(canvas);
    }

    createSVG(svgElement: any): void {
        super.createSVG(svgElement);
        this.rc = this.r.svg(this.svgNode);
    }

    drawFrame(left: number, right: number, up: number, down: number): void {

    }

    setOptions(options: RoughOptions): void {
        if (options.strokeWidth) {
            options.strokeWidth *= this._scale;
        }
        Object.assign(this.options, options);
    }

    clearCanvas(): void {
        if (this.svgNode) {
            // Expanded to cover whole drawn area
            const startW = window.innerWidth * (Util.DRAW_INFLATE_AMOUNT - 1) / 2;
            const startH = window.innerHeight * (Util.DRAW_INFLATE_AMOUNT - 1) / 2;
            this.drawRectangle(-startW, -startH, window.innerWidth * Util.DRAW_INFLATE_AMOUNT, window.innerHeight * Util.DRAW_INFLATE_AMOUNT);
        } else {
            this.drawRectangle(0, 0, window.innerWidth, window.innerHeight);
        }
    }

    drawRectangle(x: number, y: number, width: number, height: number): void {
        if (this._scale !== 1) {
            x *= this._scale;
            y *= this._scale;
            width *= this._scale;
            height *= this._scale;
        }
        this.appendSvgNode(this.rc.rectangle(x, y, width, height, this.options));
    }

    drawPolygon(polygon: Vector[]): void {
        if (polygon.length === 0) {
            return;
        }

        if (this._scale !== 1) {
            polygon = polygon.map(v => v.clone().multiplyScalar(this._scale));
        }

        this.appendSvgNode(this.rc.polygon(polygon.map(v => [v.x, v.y]), this.options));
    }

    drawSquare(centre: Vector, radius: number): void {
        const prevStroke = this.options.stroke;
        this.options.stroke = 'none';
        this.drawRectangle(centre.x - radius, centre.y - radius, 2 * radius, 2 * radius);
        this.options.stroke = prevStroke;
    }

    drawPolyline(line: Vector[]): void {
        if (line.length < 2) {
            return;
        }

        if (this._scale !== 1) {
            line = line.map(v => v.clone().multiplyScalar(this._scale));
        }

        this.appendSvgNode(this.rc.linearPath(line.map(v => [v.x, v.y]), this.options));
    }
}
