import Vector from '../vector';

/**
 * Names for streets, highways, water, parks and neighbourhoods, in the style of an American city.
 * Streets running roughly east-west are numbered, the others take names from a pool,
 * the way many US grids are named
 */

const SURNAMES = [
    'Arlington', 'Ashland', 'Allston', 'Beverly', 'Bonner', 'Columbia', 'Cortlandt', 'Durham', 'Harvard',
    'Heights', 'Herkimer', 'Lawrence', 'Nicholson', 'Oxford', 'Rutland', 'Tulane', 'Yale', 'Waverly',
    'Studewood', 'Shepherd', 'Jackson', 'Lamar', 'Fowler', 'Patterson', 'Parker', 'Snover', 'Reinerman',
    'Detering', 'Birdsall', 'Malone', 'Asbury', 'Knox', 'Radcliffe', 'Sandman', 'Thompson', 'Olive',
    'Courtland', 'Dunbar', 'Garrett', 'Hamilton', 'Kirby', 'Lowell', 'Merrill', 'Norfolk', 'Prescott',
    'Quitman', 'Roberts', 'Sabine', 'Taft', 'Usener', 'Vincent', 'Walling', 'Bayland', 'Cooper',
    'Dorothy', 'Euclid', 'Granberry', 'Harrold', 'Ingold', 'Jefferson', 'Kent', 'Lindale', 'Monroe',
    'Nevada', 'Orleans', 'Payne', 'Rose', 'Silver', 'Tabor', 'Upland', 'Vine', 'Welch', 'Wichman',
    'Belmont', 'Chester', 'Dallas', 'Edwards', 'Fletcher', 'Gibson', 'Hartman', 'Irvington', 'Jensen',
    'Keeland', 'Lillian', 'Marshall', 'Nance', 'Pinckney', 'Ralston', 'Stanford', 'Trinity', 'Wakefield',
];

const TREES = [
    'Oak', 'Maple', 'Elm', 'Pine', 'Cedar', 'Walnut', 'Ash', 'Willow', 'Hickory', 'Magnolia', 'Pecan',
    'Cypress', 'Laurel', 'Holly', 'Chestnut', 'Sycamore', 'Mulberry', 'Poplar', 'Birch', 'Dogwood',
];

const NEIGHBOURHOOD_FIRST = [
    'Old West', 'Magnolia', 'Westwood', 'Rice', 'Camden', 'Memorial', 'Brook', 'Oak', 'River', 'Harbor',
    'Pleasant', 'Fair', 'Spring', 'Glen', 'Woodland', 'Highland', 'Cedar', 'Lake', 'Bay', 'Sunset',
    'Garden', 'Northside', 'Eastwood', 'Lindale', 'Idylwood', 'Pecan', 'Kashmere', 'Denver',
];

const NEIGHBOURHOOD_SECOND = [
    'Grove', 'Heights', 'Park', 'Terrace', 'Village', 'Acres', 'Place', 'Hills', 'Gardens', 'Manor',
    'Point', 'Oaks', 'Estates', 'Square', 'Crossing', 'End', 'Meadows', 'Ridge',
];

const HIGHWAY_NAMES = [
    'Katy', 'Gulf', 'North', 'Eastex', 'Southwest', 'Pasadena', 'La Porte', 'Crosstown', 'Lakeshore',
    'Bayshore', 'Pierce', 'Hardy', 'Westpark', 'Memorial', 'Calumet', 'Kennedy', 'Dan Ryan', 'Eisenhower',
];

const RIVER_FIRST = ['Buffalo', 'White Oak', 'Brays', 'Sims', 'Greens', 'Hunting', 'Cedar', 'Willow', 'Little', 'Clear'];
const RIVER_SECOND = ['Bayou', 'Bayou', 'River', 'Creek'];
const SEA_NAMES = ['Galveston Bay', 'Trinity Bay', 'Lake Michigan', 'Mobile Bay', 'Tampa Bay', 'Lake Erie', 'Matagorda Bay'];

export interface StreetNameSets {
    minor: string[];
    major: string[];
    main: string[];
    coast: string[];
    frontage: string[];
    highways: string[];
    highwayRefs: string[];
    majorClass: ('primary' | 'secondary' | 'tertiary')[];  // OpenStreetMap road class of each major road
}

export default class PlaceNames {
    private used = new Set<string>();

    private pick(list: string[]): string {
        for (let i = 0; i < 20; i++) {
            const name = list[Math.floor(Math.random() * list.length)];
            if (!this.used.has(name)) {
                this.used.add(name);
                return name;
            }
        }
        return list[Math.floor(Math.random() * list.length)];
    }

    private static ordinal(n: number): string {
        const tens = n % 100;
        if (tens >= 11 && tens <= 13) return `${n}th`;
        switch (n % 10) {
            case 1: return `${n}st`;
            case 2: return `${n}nd`;
            case 3: return `${n}rd`;
            default: return `${n}th`;
        }
    }

    private static mean(line: Vector[]): Vector {
        const m = Vector.zeroVector();
        for (const v of line) m.add(v);
        return m.divideScalar(Math.max(1, line.length));
    }

    private static lineLength(line: Vector[]): number {
        let l = 0;
        for (let i = 1; i < line.length; i++) l += line[i].distanceTo(line[i - 1]);
        return l;
    }

    /**
     * Pieces of the same street that line up get the same name, pieces are grouped by their
     * position across the street direction
     */
    private static groupCollinear(lines: Vector[][], indices: number[], across: (v: Vector) => number, gap: number): number[][] {
        const sorted = indices.slice().sort((a, b) => across(PlaceNames.mean(lines[a])) - across(PlaceNames.mean(lines[b])));
        const groups: number[][] = [];
        let last = -Infinity;
        for (const i of sorted) {
            const c = across(PlaceNames.mean(lines[i]));
            if (groups.length === 0 || c - last > gap) groups.push([]);
            groups[groups.length - 1].push(i);
            last = c;
        }
        return groups;
    }

    /**
     * @param centre world space centre of the map, divides East from West
     */
    nameStreets(minor: Vector[][], major: Vector[][], main: Vector[][], coast: Vector[][],
                frontage: Vector[][], highways: Vector[][], centre: Vector, riverCentreline: Vector[]): StreetNameSets {
        this.used.clear();
        const out: StreetNameSets = {
            minor: [], major: [], main: [], coast: [], frontage: [], highways: [], highwayRefs: [], majorClass: [],
        };

        // Highways
        const refs = ['I 10', 'I 45', 'I 69', 'US 59', 'US 90', 'SH 288', 'I 610', 'SH 225', 'I 94', 'I 55'];
        for (let i = 0; i < highways.length; i++) {
            out.highways.push(`${this.pick(HIGHWAY_NAMES)} ${Math.random() < 0.75 ? 'Freeway' : 'Expressway'}`);
            out.highwayRefs.push(this.pick(refs));
        }
        // Frontage roads take the name of the nearest highway
        for (const f of frontage) {
            const m = PlaceNames.mean(f);
            let best = -1;
            let bestD = Infinity;
            highways.forEach((h, i) => {
                for (const v of h) {
                    const d = v.distanceToSquared(m);
                    if (d < bestD) {
                        bestD = d;
                        best = i;
                    }
                }
            });
            out.frontage.push(best >= 0 ? `${out.highways[best]} Frontage Road` : '');
        }

        const mainSuffix = ['Boulevard', 'Avenue', 'Drive', 'Road', 'Parkway'];
        for (let i = 0; i < main.length; i++) {
            out.main.push(`${this.pick(SURNAMES)} ${this.pick(mainSuffix.concat(['Avenue', 'Boulevard']))}`);
        }
        const majorSuffix = ['Avenue', 'Street', 'Road', 'Drive', 'Boulevard', 'Avenue'];
        for (let i = 0; i < major.length; i++) {
            const base = Math.random() < 0.25 ? this.pick(TREES) : this.pick(SURNAMES);
            out.major.push(`${base} ${majorSuffix[Math.floor(Math.random() * majorSuffix.length)]}`);
            const r = Math.random();
            out.majorClass.push(r < 0.3 ? 'primary' : r < 0.7 ? 'secondary' : 'tertiary');
        }
        // Water roads: along the coast, or along the river banks
        const coastNames = ['Bay Shore Drive', 'Shoreline Drive', 'Lakeshore Drive', 'Harbor Drive', 'Bayside Boulevard'];
        const riverNames = ['Memorial Drive', 'Allen Parkway', 'Riverside Drive', 'Bayou Parkway', 'Riverview Drive'];
        const coastName = this.pick(coastNames);
        for (const road of coast) {
            const m = road.length > 0 ? road[Math.floor(road.length / 2)] : Vector.zeroVector();
            const byRiver = riverCentreline.some(v => v.distanceToSquared(m) < 200 * 200);
            out.coast.push(byRiver ? this.pick(riverNames) : coastName);
        }

        // Side streets: roughly east-west ones are numbered, north to south, the rest are named
        const eastWest: number[] = [];
        const northSouth: number[] = [];
        minor.forEach((line, i) => {
            if (line.length < 2) return;
            const d = line[line.length - 1].clone().sub(line[0]);
            (Math.abs(d.x) >= Math.abs(d.y) ? eastWest : northSouth).push(i);
        });
        out.minor = minor.map(() => '');

        const ewGroups = PlaceNames.groupCollinear(minor, eastWest, v => v.y, 18);
        let number = 2 + Math.floor(Math.random() * 6) + ewGroups.length;
        for (const group of ewGroups) {
            const n = Math.max(1, number);
            number -= Math.random() < 0.1 ? 2 : 1;
            for (const i of group) {
                const m = PlaceNames.mean(minor[i]);
                const side = m.x < centre.x ? 'West' : 'East';
                out.minor[i] = `${side} ${PlaceNames.ordinal(n)} Street`;
            }
        }

        const nsGroups = PlaceNames.groupCollinear(minor, northSouth, v => v.x, 18);
        for (const group of nsGroups) {
            const total = group.reduce((acc, i) => acc + PlaceNames.lineLength(minor[i]), 0);
            let suffix = 'Street';
            if (total < 160) suffix = ['Court', 'Place', 'Lane'][Math.floor(Math.random() * 3)];
            else if (Math.random() < 0.15) suffix = 'Avenue';
            else if (Math.random() < 0.08) suffix = 'Drive';
            const base = Math.random() < 0.12 ? this.pick(TREES) : this.pick(SURNAMES);
            for (const i of group) out.minor[i] = `${base} ${suffix}`;
        }
        return out;
    }

    riverName(): string {
        return `${RIVER_FIRST[Math.floor(Math.random() * RIVER_FIRST.length)]} ${RIVER_SECOND[Math.floor(Math.random() * RIVER_SECOND.length)]}`;
    }

    seaName(): string {
        return SEA_NAMES[Math.floor(Math.random() * SEA_NAMES.length)];
    }

    parkName(): string {
        const r = Math.random();
        if (r < 0.65) return `${this.pick(SURNAMES)} Park`;
        if (r < 0.85) return `${this.pick(TREES)} Park`;
        return `${this.pick(SURNAMES)} Green`;
    }

    /**
     * @param big a regional mall rather than a strip mall
     */
    mallName(big: boolean): string {
        const name = Math.random() < 0.5 ? this.pick(SURNAMES) : this.pick(NEIGHBOURHOOD_FIRST);
        if (big) return `${name} ${['Mall', 'Galleria', 'Town Center', 'Mall', 'Square'][Math.floor(Math.random() * 5)]}`;
        return `${name} ${['Plaza', 'Shopping Center', 'Village Shops', 'Marketplace'][Math.floor(Math.random() * 4)]}`;
    }

    apartmentName(): string {
        const r = Math.random();
        const place = Math.random() < 0.5 ? this.pick(TREES) : this.pick(SURNAMES);
        if (r < 0.35) return `The Reserve at ${place}`;
        if (r < 0.6) return `${place} ${['Place', 'Park', 'Village', 'Commons'][Math.floor(Math.random() * 4)]} Apartments`;
        if (r < 0.8) return `${place} Crossing`;
        return `The ${place}`;
    }

    neighbourhoodName(): string {
        for (let i = 0; i < 20; i++) {
            const first = NEIGHBOURHOOD_FIRST[Math.floor(Math.random() * NEIGHBOURHOOD_FIRST.length)];
            const second = NEIGHBOURHOOD_SECOND[Math.floor(Math.random() * NEIGHBOURHOOD_SECOND.length)];
            const name = first === 'Old West' ? 'Old West End' : `${first} ${second}`;
            if (!this.used.has(name)) {
                this.used.add(name);
                return name;
            }
        }
        return 'Midtown';
    }
}
