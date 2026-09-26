import * as log from 'loglevel';
import * as PolyK from 'polyk';
import Vector from '../vector';
import * as jsts from 'jsts';

export default class PolygonUtil {
    private static geometryFactory = new jsts.geom.GeometryFactory();

    /**
     * Slices rectangle by line, returning smallest polygon
     */
    public static sliceRectangle(origin: Vector, worldDimensions: Vector, p1: Vector, p2: Vector): Vector[] {
        const rectangle = [
            origin.x, origin.y,
            origin.x + worldDimensions.x, origin.y,
            origin.x + worldDimensions.x, origin.y + worldDimensions.y,
            origin.x, origin.y + worldDimensions.y,
        ];
        const sliced = PolyK.Slice(rectangle, p1.x, p1.y, p2.x, p2.y).map(p => PolygonUtil.polygonArrayToPolygon(p));
        const minArea = PolygonUtil.calcPolygonArea(sliced[0]);

        if (sliced.length > 1 && PolygonUtil.calcPolygonArea(sliced[1]) < minArea) {
            return sliced[1];
        }

        return sliced[0];
    }

    /**
     * Used to create sea polygon
     */
    public static lineRectanglePolygonIntersection(origin: Vector, worldDimensions: Vector, line: Vector[]): Vector[] {
        const jstsLine = PolygonUtil.lineToJts(line);
        const bounds = [
            origin,
            new Vector(origin.x + worldDimensions.x, origin.y),
            new Vector(origin.x + worldDimensions.x, origin.y + worldDimensions.y),
            new Vector(origin.x, origin.y + worldDimensions.y),
        ];
        const boundingPoly = PolygonUtil.polygonToJts(bounds);
        const union = boundingPoly.getExteriorRing().union(jstsLine);
        const polygonizer = new (jsts.operation as any).polygonize.Polygonizer();
        polygonizer.add(union);
        const polygons = polygonizer.getPolygons();

        let smallestArea = Infinity;
        let smallestPoly;
        for (let i = polygons.iterator(); i.hasNext();) {
            const polygon = i.next();
            const area = polygon.getArea();
            if (area < smallestArea) {
                smallestArea = area;
                smallestPoly = polygon;
            }
        }

        if (!smallestPoly) return [];
        return smallestPoly.getCoordinates().map((c: any) => new Vector(c.x, c.y));
    }

    /**
     * Positive for one winding direction, negative for the other
     */
    public static signedArea(polygon: Vector[]): number {
        let total = 0;
        for (let i = 0; i < polygon.length; i++) {
            const next = polygon[(i + 1) % polygon.length];
            total += polygon[i].x * next.y - next.x * polygon[i].y;
        }
        return total / 2;
    }

    public static calcPolygonArea(polygon: Vector[]): number {
        let total = 0;

        for (let i = 0; i < polygon.length; i++) {
          const addX = polygon[i].x;
          const addY = polygon[i == polygon.length - 1 ? 0 : i + 1].y;
          const subX = polygon[i == polygon.length - 1 ? 0 : i + 1].x;
          const subY = polygon[i].y;

          total += (addX * addY * 0.5);
          total -= (subX * subY * 0.5);
        }

        return Math.abs(total);
    }

    /**
     * Recursively divide a polygon by its longest side until the minArea stopping condition is met
     */
    public static subdividePolygon(p: Vector[], minArea: number, depth=0): Vector[][] {
        // Closed rings repeat their first point, PolyK treats that as self-intersecting
        if (p.length > 3 && p[0].equals(p[p.length - 1])) {
            p = p.slice(0, p.length - 1);
        }

        const area = PolygonUtil.calcPolygonArea(p);
        if (area < 0.5 * minArea) {
            return [];
        }
        const divided: Vector[][] = [];  // Array of polygons

        let longestSideLength = 0;
        let longestSide = [p[0], p[1]];

        let perimeter = 0;

        for (let i = 0; i < p.length; i++) {
            const sideLength = p[i].clone().sub(p[(i+1) % p.length]).length();
            perimeter += sideLength;
            if (sideLength > longestSideLength) {
                longestSideLength = sideLength;
                longestSide = [p[i], p[(i+1) % p.length]];
            }
        }

        // Shape index
        // Using rectangle ratio of 1:4 as limit
        // Only applied to final lots, long thin blocks are split across their length first
        const thin = area / (perimeter * perimeter) < 0.04;
        if (area < 2 * minArea || depth > 16) {
            return thin ? [] : [p];
        }

        // Between 0.4 and 0.6
        const deviation = (Math.random() * 0.2) + 0.4;

        // Point part way along the longest side
        const averagePoint = longestSide[0].clone().add(longestSide[1].clone().sub(longestSide[0]).multiplyScalar(deviation));
        const differenceVector = longestSide[0].clone().sub(longestSide[1]);
        const perpVector = (new Vector(differenceVector.y, -1 * differenceVector.x))
            .normalize()
            .multiplyScalar(perimeter);  // Long enough to cut all the way through

        const bisect = [averagePoint.clone().add(perpVector), averagePoint.clone().sub(perpVector)];

        // Array of polygons
        try {
            const sliced = PolyK.Slice(PolygonUtil.polygonToPolygonArray(p), bisect[0].x, bisect[0].y, bisect[1].x, bisect[1].y);
            if (sliced.length < 2) {
                // Slice missed, stop here rather than recursing forever
                return thin ? [] : [p];
            }
            // Recursive call
            for (const s of sliced) {
                divided.push(...PolygonUtil.subdividePolygon(PolygonUtil.polygonArrayToPolygon(s), minArea, depth + 1));
            }

            return divided;
        } catch (error) {
            log.error(error);
            return [];
        }
    }

    /**
     * Shrink or expand polygon
     */
    public static resizeGeometry(geometry: Vector[], spacing: number, isPolygon=true): Vector[] {
        try {
            const jstsGeometry = isPolygon? PolygonUtil.polygonToJts(geometry) : PolygonUtil.lineToJts(geometry);
            const resized = jstsGeometry.buffer(spacing, undefined, (jsts as any).operation.buffer.BufferParameters.CAP_FLAT);
            if (!resized.isSimple()) {
                return [];
            }
            return resized.getCoordinates().map(c => new Vector(c.x, c.y));
        } catch (error) {
            log.error(error);
            return [];
        }
    }

    public static averagePoint(polygon: Vector[]): Vector {
        if (polygon.length === 0) return Vector.zeroVector();
        const sum = Vector.zeroVector();
        for (const v of polygon) {
            sum.add(v);
        }
        return sum.divideScalar(polygon.length);
    }

    public static insidePolygon(point: Vector, polygon: Vector[]): boolean {
        // ray-casting algorithm based on
        // http://www.ecse.rpi.edu/Homepages/wrf/Research/Short_Notes/pnpoly.html

        if (polygon.length === 0) {
            return false;
        }

        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i].x, yi = polygon[i].y;
            const xj = polygon[j].x, yj = polygon[j].y;

            const intersect = ((yi > point.y) != (yj > point.y))
                && (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }

        return inside;
    }

    public static pointInRectangle(point: Vector, origin: Vector, dimensions: Vector): boolean {
        return point.x >= origin.x && point.y >= origin.y && point.x <= dimensions.x && point.y <= dimensions.y;
    }

    /**
     * Shortest distance from point p to segment ab
     */
    public static distanceToSegment(p: Vector, a: Vector, b: Vector): number {
        const abx = b.x - a.x;
        const aby = b.y - a.y;
        const lengthSq = abx * abx + aby * aby;
        let t = lengthSq === 0 ? 0 : ((p.x - a.x) * abx + (p.y - a.y) * aby) / lengthSq;
        t = Math.max(0, Math.min(1, t));
        const dx = a.x + t * abx - p.x;
        const dy = a.y + t * aby - p.y;
        return Math.sqrt(dx * dx + dy * dy);
    }

    public static distanceToPolyline(p: Vector, line: Vector[]): number {
        let min = Infinity;
        for (let i = 0; i < line.length - 1; i++) {
            min = Math.min(min, PolygonUtil.distanceToSegment(p, line[i], line[i + 1]));
        }
        return min;
    }

    /**
     * Intersection of segments p1p2 and p3p4, or null
     * Also returns the parameter along each segment
     */
    public static segmentIntersection(p1: Vector, p2: Vector, p3: Vector, p4: Vector): {point: Vector, t: number, u: number} {
        const d1x = p2.x - p1.x, d1y = p2.y - p1.y;
        const d2x = p4.x - p3.x, d2y = p4.y - p3.y;
        const denom = d1x * d2y - d1y * d2x;
        if (Math.abs(denom) < 1e-9) return null;
        const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
        const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
        if (t < 0 || t > 1 || u < 0 || u > 1) return null;
        return {point: new Vector(p1.x + t * d1x, p1.y + t * d1y), t, u};
    }

    /**
     * Chaikin corner cutting, keeps end points
     */
    public static smoothPolyline(line: Vector[], iterations: number): Vector[] {
        let out = line;
        for (let n = 0; n < iterations; n++) {
            if (out.length < 3) return out;
            const next = [out[0]];
            for (let i = 0; i < out.length - 1; i++) {
                const a = out[i];
                const b = out[i + 1];
                next.push(a.clone().multiplyScalar(0.75).add(b.clone().multiplyScalar(0.25)));
                next.push(a.clone().multiplyScalar(0.25).add(b.clone().multiplyScalar(0.75)));
            }
            next.push(out[out.length - 1]);
            out = next;
        }
        return out;
    }

    /**
     * Offsets each vertex of a polyline sideways by distance (positive = left of direction of travel)
     * Only suitable for gently curving lines
     */
    public static offsetPolyline(line: Vector[], distance: number): Vector[] {
        const out: Vector[] = [];
        for (let i = 0; i < line.length; i++) {
            const prev = line[Math.max(0, i - 1)];
            const next = line[Math.min(line.length - 1, i + 1)];
            const tangent = next.clone().sub(prev);
            if (tangent.lengthSq() === 0) continue;
            tangent.normalize();
            out.push(new Vector(line[i].x - tangent.y * distance, line[i].y + tangent.x * distance));
        }
        return out;
    }

    /**
     * Samples a cubic bezier curve
     */
    public static bezier(p0: Vector, p1: Vector, p2: Vector, p3: Vector, samples: number): Vector[] {
        const out: Vector[] = [];
        for (let i = 0; i <= samples; i++) {
            const t = i / samples;
            const mt = 1 - t;
            const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
            out.push(new Vector(
                a * p0.x + b * p1.x + c * p2.x + d * p3.x,
                a * p0.y + b * p1.y + c * p2.y + d * p3.y));
        }
        return out;
    }

    public static circle(centre: Vector, radius: number, samples=24): Vector[] {
        const out: Vector[] = [];
        for (let i = 0; i < samples; i++) {
            const a = 2 * Math.PI * i / samples;
            out.push(new Vector(centre.x + Math.cos(a) * radius, centre.y + Math.sin(a) * radius));
        }
        return out;
    }

    /**
     * Convex hull of a set of points, grown by spacing
     */
    public static bufferedHull(points: Vector[], spacing: number): Vector[] {
        try {
            const coords = points.map(v => new jsts.geom.Coordinate(v.x, v.y));
            const multiPoint = (PolygonUtil.geometryFactory as any).createMultiPointFromCoords(coords);
            const hull = multiPoint.convexHull().buffer(spacing);
            const out = hull.getCoordinates().map((c: any) => new Vector(c.x, c.y));
            out.pop();  // Closing point duplicates the first
            return out;
        } catch (error) {
            log.error(error);
            return [];
        }
    }

    /**
     * Returns the pieces of polygon that remain after removing all of the holes
     * Pieces smaller than minArea are discarded
     * On a geometry error the original polygon is returned
     */
    public static subtractPolygons(polygon: Vector[], holes: Vector[][], minArea: number): Vector[][] {
        if (holes.length === 0) return [polygon];
        try {
            let geometry: any = PolygonUtil.polygonToJts(polygon);
            for (const h of holes) {
                geometry = geometry.difference(PolygonUtil.polygonToJts(h));
            }

            const out: Vector[][] = [];
            for (let i = 0; i < geometry.getNumGeometries(); i++) {
                const piece = geometry.getGeometryN(i);
                if (piece.getArea() < minArea) continue;
                const coords = (piece as any).getExteriorRing().getCoordinates();
                const vectors = coords.map((c: any) => new Vector(c.x, c.y));
                vectors.pop();  // Closing point duplicates the first
                out.push(vectors);
            }
            return out;
        } catch (error) {
            log.warn(error);
            return [polygon];
        }
    }

    /**
     * [minX, minY, maxX, maxY]
     */
    public static boundingBox(polygon: Vector[]): number[] {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const v of polygon) {
            minX = Math.min(minX, v.x);
            minY = Math.min(minY, v.y);
            maxX = Math.max(maxX, v.x);
            maxY = Math.max(maxY, v.y);
        }
        return [minX, minY, maxX, maxY];
    }

    public static boundingBoxesOverlap(a: number[], b: number[]): boolean {
        return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
    }

    private static lineToJts(line: Vector[]): jsts.geom.LineString {
        const coords = line.map(v => new jsts.geom.Coordinate(v.x, v.y));
        return PolygonUtil.geometryFactory.createLineString(coords);
    }

    private static polygonToJts(polygon: Vector[]): jsts.geom.Polygon {
        const geoInput = polygon.map(v => new jsts.geom.Coordinate(v.x, v.y));
        geoInput.push(geoInput[0]);  // Create loop
        return PolygonUtil.geometryFactory.createPolygon(PolygonUtil.geometryFactory.createLinearRing(geoInput), []);
    }

    /**
     * [ v.x, v.y, v.x, v.y ]...
     */
    private static polygonToPolygonArray(p: Vector[]): number[] {
        const outP: number[] = [];
        for (const v of p) {
            outP.push(v.x);
            outP.push(v.y);
        }
        return outP;
    }

    /**
     * [ v.x, v.y, v.x, v.y ]...
     */
    private static polygonArrayToPolygon(p: number[]): Vector[] {
        const outP = [];
        for (let i = 0; i < p.length / 2; i++) {
            outP.push(new Vector(p[2*i], p[2*i + 1]));
        }
        return outP;
    }
}
