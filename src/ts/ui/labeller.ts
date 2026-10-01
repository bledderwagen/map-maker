import Vector from '../vector';
import {DefaultCanvasWrapper} from './canvas_wrapper';

export interface LabelStyle {
    font: string;  // CSS font, size in screen pixels
    size: number;  // Font size in pixels, for collision boxes
    fill: string;
    halo: string;
    haloWidth: number;
    repeat?: number;  // Distance between repeats of a label along a line, in pixels
    maxBend?: number;  // Largest change of direction under a label, radians
}

interface Box {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

interface Glyph {
    text: string;
    at: Vector;
    angle: number;
}

/**
 * Places labels in screen space without overlaps, the way web maps do:
 * names follow their road, repeat along long roads and are dropped where there's no room
 */
export default class Labeller {
    private readonly CELL = 64;
    private grid = new Map<string, Box[]>();

    constructor(private canvas: DefaultCanvasWrapper, private width: number, private height: number) {}

    private key(x: number, y: number): string {
        return `${x},${y}`;
    }

    private cells(b: Box, f: (k: string) => void): void {
        for (let x = Math.floor(b.x0 / this.CELL); x <= Math.floor(b.x1 / this.CELL); x++) {
            for (let y = Math.floor(b.y0 / this.CELL); y <= Math.floor(b.y1 / this.CELL); y++) {
                f(this.key(x, y));
            }
        }
    }

    private free(b: Box): boolean {
        if (b.x0 < 2 || b.y0 < 2 || b.x1 > this.width - 2 || b.y1 > this.height - 2) return false;
        let ok = true;
        this.cells(b, k => {
            if (!ok) return;
            for (const o of this.grid.get(k) || []) {
                if (b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0) {
                    ok = false;
                    return;
                }
            }
        });
        return ok;
    }

    /**
     * Reserve space, e.g. for something drawn without a label
     */
    occupy(b: Box): void {
        this.cells(b, k => {
            if (!this.grid.has(k)) this.grid.set(k, []);
            this.grid.get(k).push(b);
        });
    }

    /**
     * Claims a box for a symbol, false if something is already there
     */
    reserve(at: Vector, halfW: number, halfH: number): boolean {
        const box = Labeller.boxAround(at, halfW, halfH);
        if (!this.free(box)) return false;
        this.occupy(box);
        return true;
    }

    private static boxAround(at: Vector, halfW: number, halfH: number): Box {
        return {x0: at.x - halfW, y0: at.y - halfH, x1: at.x + halfW, y1: at.y + halfH};
    }

    /**
     * Point along a polyline at distance s, with the direction there
     */
    private static along(line: Vector[], cum: number[], s: number): {p: Vector; dir: Vector} {
        let i = 1;
        while (i < line.length - 1 && cum[i] < s) i++;
        const a = line[i - 1];
        const b = line[i];
        const seg = cum[i] - cum[i - 1];
        const t = seg > 0 ? Math.min(1, Math.max(0, (s - cum[i - 1]) / seg)) : 0;
        const dir = b.clone().sub(a);
        const len = dir.length();
        return {p: a.clone().add(dir.clone().multiplyScalar(t)), dir: len > 0 ? dir.divideScalar(len) : new Vector(1, 0)};
    }

    /**
     * Lay out text along a stretch of line centred at s, or null if it bends too much or collides
     */
    private fitAlong(line: Vector[], cum: number[], s: number, text: string, style: LabelStyle): {glyphs: Glyph[]; boxes: Box[]} {
        const total = this.canvas.measureText(text, style.font);
        const start = s - total / 2;
        const end = s + total / 2;
        if (start < 2 || end > cum[cum.length - 1] - 2) return null;

        // Straight enough?
        const maxBend = style.maxBend === undefined ? 0.35 : style.maxBend;
        const first = Labeller.along(line, cum, start).dir;
        let reference = first;
        for (let d = start; d <= end; d += 3) {
            const dir = Labeller.along(line, cum, d).dir;
            if (Math.acos(Math.max(-1, Math.min(1, dir.dot(first)))) > maxBend) return null;
            if (Math.acos(Math.max(-1, Math.min(1, dir.dot(reference)))) > 0.25) return null;
            reference = dir;
        }

        // Read left to right
        const mid = Labeller.along(line, cum, s).dir;
        const reversed = Labeller.along(line, cum, end).p.x < Labeller.along(line, cum, start).p.x
            || (Math.abs(mid.x) < 0.05 && mid.y < 0);

        const glyphs: Glyph[] = [];
        const boxes: Box[] = [];
        let offset = 0;
        const half = 0.55 * style.size;
        for (const ch of text) {
            const w = this.canvas.measureText(ch, style.font);
            const d = reversed ? end - offset - w / 2 : start + offset + w / 2;
            offset += w;
            if (ch === ' ') continue;
            // Smooth the direction over the width of the letter
            const a = Labeller.along(line, cum, d - 2).p;
            const b = Labeller.along(line, cum, d + 2).p;
            const p = Labeller.along(line, cum, d).p;
            let angle = Math.atan2(b.y - a.y, b.x - a.x);
            if (reversed) angle += Math.PI;
            glyphs.push({text: ch, at: p, angle});
            const box = Labeller.boxAround(p, half, half);
            if (!this.free(box)) return null;
            boxes.push(box);
        }
        return {glyphs, boxes};
    }

    private drawGlyphs(glyphs: Glyph[], style: LabelStyle): void {
        // Halo first for all letters, so a halo never covers the letter before it
        if (style.haloWidth > 0) {
            for (const g of glyphs) this.canvas.drawText(g.text, g.at, g.angle, style.font, style.halo, style.halo, style.haloWidth);
        }
        for (const g of glyphs) this.canvas.drawText(g.text, g.at, g.angle, style.font, style.fill, style.halo, 0);
    }

    /**
     * Name along a road or river, repeated along long lines
     * @return number of times the label was placed
     */
    labelLine(line: Vector[], text: string, style: LabelStyle): number {
        if (!text || line.length < 2) return 0;
        const cum = [0];
        for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + line[i].distanceTo(line[i - 1]));
        const length = cum[cum.length - 1];
        const textWidth = this.canvas.measureText(text, style.font);
        if (length < textWidth + 10) return 0;

        const repeat = style.repeat || 400;
        const step = 10;
        const candidates: number[] = [];
        if (length < repeat * 1.5) {
            // One label, as near the middle as it fits
            for (let d = 0; d < length / 2; d += step) {
                candidates.push(length / 2 + d);
                if (d > 0) candidates.push(length / 2 - d);
            }
        } else {
            for (let d = repeat / 3; d < length; d += step) candidates.push(d);
        }

        let placed = 0;
        let last = -Infinity;
        for (const s of candidates) {
            if (s - last < repeat) continue;
            const fit = this.fitAlong(line, cum, s, text, style);
            if (fit === null) continue;
            for (const b of fit.boxes) this.occupy(b);
            this.drawGlyphs(fit.glyphs, style);
            placed++;
            last = s;
            if (length < repeat * 1.5) break;
        }
        return placed;
    }

    /**
     * Horizontal label, split over lines at spaces when long
     */
    labelPoint(at: Vector, text: string, style: LabelStyle, wrap = 14): boolean {
        const draw = this.placePoint(at, text, style, wrap);
        if (draw === null) return false;
        draw();
        return true;
    }

    /**
     * Claims room for a point label without drawing it yet
     * @return draws the label, or null if there's no room
     */
    placePoint(at: Vector, text: string, style: LabelStyle, wrap = 14): () => void {
        const words = text.split(' ');
        const lines: string[] = [];
        for (const w of words) {
            if (lines.length > 0 && (lines[lines.length - 1] + ' ' + w).length <= wrap) {
                lines[lines.length - 1] += ' ' + w;
            } else {
                lines.push(w);
            }
        }
        const lineHeight = 1.2 * style.size;
        const widths = lines.map(l => this.canvas.measureText(l, style.font));
        const halfW = Math.max(...widths) / 2 + 2;
        const halfH = lines.length * lineHeight / 2 + 1;
        const box = Labeller.boxAround(at, halfW, halfH);
        if (!this.free(box)) return null;
        this.occupy(box);
        return (): void => lines.forEach((l, i) => {
            const p = new Vector(at.x, at.y - halfH + 1 + lineHeight * (i + 0.5));
            this.canvas.drawText(l, p, 0, style.font, style.fill, style.halo, style.haloWidth);
        });
    }

    /**
     * Road number in a shield on the road, every so often along it
     */
    shieldLine(line: Vector[], ref: string, style: LabelStyle, fill: string, stroke: string): number {
        if (!ref || line.length < 2) return 0;
        const cum = [0];
        for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + line[i].distanceTo(line[i - 1]));
        const length = cum[cum.length - 1];
        const repeat = style.repeat || 500;
        const w = this.canvas.measureText(ref, style.font) + 8;
        const h = style.size + 6;
        let placed = 0;
        let last = -Infinity;
        for (let s = repeat / 2; s < length; s += 10) {
            if (s - last < repeat) continue;
            const p = Labeller.along(line, cum, s).p;
            const box = Labeller.boxAround(p, w / 2 + 2, h / 2 + 2);
            if (!this.free(box)) continue;
            this.occupy(box);
            this.canvas.setFillStyle(fill);
            this.canvas.setStrokeStyle(stroke);
            this.canvas.setLineWidth(1);
            this.canvas.drawRoundedRect(p, w, h, 2.5);
            this.canvas.drawText(ref, p, 0, style.font, style.fill, style.halo, 0);
            placed++;
            last = s;
        }
        return placed;
    }
}
