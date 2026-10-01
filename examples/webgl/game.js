// Minimal three.js host for a map-maker Game export (Download -> Game, unzip map.json and map.glb next to this file).
// Shows the pieces a game needs: the same top-down perspective camera as the map maker's pseudo 3D view,
// floating labels, picking a feature under the mouse, and routing along the road network.
// See docs/game-export.md for the file formats.
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {Line2} from 'three/addons/lines/Line2.js';
import {LineMaterial} from 'three/addons/lines/LineMaterial.js';
import {LineGeometry} from 'three/addons/lines/LineGeometry.js';

// Draw buildings and labels as tall as the map maker does. Set to false for real heights
const MATCH_MAP_MAKER_HEIGHTS = true;

// Travel speeds in m/s, for picking the quickest route rather than the shortest
const SPEED = {motorway: 30, motorway_link: 15, primary: 17, secondary: 14, tertiary: 12, residential: 9, service: 6, parking_aisle: 4};

const view = document.getElementById('view');
const labelLayer = document.getElementById('labels');
const info = document.getElementById('info');

const [scene, gltf] = await Promise.all([
    fetch('map.json').then(r => r.json()),
    new GLTFLoader().loadAsync('map.glb'),
]).catch(e => {
    info.textContent = 'Put map.json and map.glb from a Game export next to index.html, and serve the folder over http. ' + e;
    throw e;
});

const header = scene.map_maker;
const exaggeration = MATCH_MAP_MAKER_HEIGHTS ? header.pseudo_3d.height_exaggeration : 1;
const features = new Map(scene.features.map(f => [f.id, f]));
const nodes = new Map(scene.road_network.nodes.map(n => [n.id, n]));
// Scene file (x, y) in metres to three.js: x east, y up, z south
const toWorld = (p, h = 0) => new THREE.Vector3(p[0], h, -p[1]);

// Renderer, lights
const renderer = new THREE.WebGLRenderer({antialias: true});
renderer.setPixelRatio(window.devicePixelRatio);
view.appendChild(renderer.domElement);
const world = new THREE.Scene();
world.background = new THREE.Color('#a6d5f9');
world.add(new THREE.HemisphereLight(0xffffff, 0xd0d0d0, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(-1, 2, 1.5);
world.add(sun);

// The map. Buildings stand on y = 0, so scaling their layer makes them taller without lifting them
world.add(gltf.scene);
const buildings = gltf.scene.getObjectByName('buildings');
if (buildings) buildings.scale.y = exaggeration;

// The edge of the world
const [minX, minY, maxX, maxY] = header.boundary.bounds;
const edge = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(header.boundary.polygon.slice(0, -1).map(p => toWorld(p, 1))),
    new THREE.LineBasicMaterial({color: 0x555555}));
world.add(edge);

// Camera: perspective, looking straight down, north up, like the map maker's pseudo 3D view
const camera = new THREE.PerspectiveCamera(header.pseudo_3d.vertical_fov_deg, 1, 1, 20000);
camera.up.set(0, 0, -1);
const target = new THREE.Vector2((minX + maxX) / 2, (minY + maxY) / 2);  // Scene x, y
const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
let height = (maxY - minY) / 2 / tanHalf;

// The ground in view stays inside the boundary, so the edge of the map is never on screen
function placeCamera() {
    height = THREE.MathUtils.clamp(height, 150, Math.min((maxY - minY) / 2 / tanHalf, (maxX - minX) / 2 / (tanHalf * camera.aspect)));
    const halfH = height * tanHalf;
    const halfW = halfH * camera.aspect;
    target.x = THREE.MathUtils.clamp(target.x, minX + halfW, maxX - halfW);
    target.y = THREE.MathUtils.clamp(target.y, minY + halfH, maxY - halfH);
    camera.position.copy(toWorld([target.x, target.y], height));
    camera.lookAt(toWorld([target.x, target.y]));
}

function resize() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    routeMaterial.resolution.set(window.innerWidth, window.innerHeight);
}

// Floating labels: HTML text over a stem from the ground
const labels = scene.features.filter(f => f.properties.layer === 'labels').map(f => {
    const div = document.createElement('div');
    div.className = 'label ' + f.properties.class;
    div.textContent = f.properties.name;
    labelLayer.appendChild(div);
    return {div, top: toWorld(f.geometry.coordinates, f.properties.hover_height * exaggeration), ground: toWorld(f.geometry.coordinates)};
});
const stems = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(labels.flatMap(l => [l.ground, l.top])),
    new THREE.LineBasicMaterial({color: 0x666666, transparent: true, opacity: 0.6}));
world.add(stems);

function placeLabels() {
    const v = new THREE.Vector3();
    for (const l of labels) {
        v.copy(l.top).project(camera);
        const visible = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
        l.div.style.display = visible ? '' : 'none';
        if (!visible) continue;
        l.div.style.left = `${(v.x + 1) / 2 * window.innerWidth}px`;
        l.div.style.top = `${(1 - v.y) / 2 * window.innerHeight}px`;
    }
}

// Picking: the _FEATURE_ID vertex attribute leads back to the feature in map.json
const raycaster = new THREE.Raycaster();
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function pick(event) {
    const pointer = new THREE.Vector2(event.clientX / window.innerWidth * 2 - 1, -event.clientY / window.innerHeight * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(gltf.scene, true).find(h => h.object.geometry.attributes._feature_id);
    const id = hit ? hit.object.geometry.attributes._feature_id.getX(hit.face.a) : null;
    const point = raycaster.ray.intersectPlane(ground, new THREE.Vector3());
    return {feature: id ? features.get(id) : null, point: point ? [point.x, -point.z] : null};
}

function describe(feature) {
    if (!feature) return 'Ground';
    const p = Object.assign({}, feature.properties);
    delete p.layer;
    delete p.class_id;
    return `<b>${p.name || p.class}</b> (feature ${feature.id})<br><code>${JSON.stringify(p)}</code>`;
}

// Routing: A* over road_network, each road feature is an edge between from_node and to_node
function nearestNode(p) {
    let best = null;
    let bestD = Infinity;
    for (const n of nodes.values()) {
        const d = Math.hypot(n.coordinates[0] - p[0], n.coordinates[1] - p[1]);
        if (d < bestD) {
            bestD = d;
            best = n;
        }
    }
    return best;
}

function route(from, to) {
    const cost = e => e.properties.length / (SPEED[e.properties.class] || 8);
    const guess = n => Math.hypot(n.coordinates[0] - to.coordinates[0], n.coordinates[1] - to.coordinates[1]) / SPEED.motorway;
    const g = new Map([[from.id, 0]]);
    const came = new Map();
    const open = new Set([from.id]);
    while (open.size > 0) {
        let current = null;
        for (const id of open) if (current === null || g.get(id) + guess(nodes.get(id)) < g.get(current) + guess(nodes.get(current))) current = id;
        if (current === to.id) break;
        open.delete(current);
        for (const edgeId of nodes.get(current).edges) {
            const e = features.get(edgeId);
            const next = e.properties.from_node === current ? e.properties.to_node : e.properties.from_node;
            const score = g.get(current) + cost(e);
            if (score < (g.has(next) ? g.get(next) : Infinity)) {
                g.set(next, score);
                came.set(next, {from: current, edge: e});
                open.add(next);
            }
        }
    }
    if (!g.has(to.id)) return null;
    // Walk back, joining edge geometry in travel order
    const points = [];
    for (let id = to.id; id !== from.id; id = came.get(id).from) {
        const {edge} = came.get(id);
        const line = edge.geometry.coordinates.slice();
        if (edge.properties.to_node !== id) line.reverse();
        // Its last point is where the part already walked starts
        points.unshift(...(points.length > 0 ? line.slice(0, -1) : line));
    }
    return {points, seconds: g.get(to.id)};
}

const routeMaterial = new LineMaterial({color: 0xe5352b, linewidth: 5});
let routeLine = null;
let routeStart = null;

function showRoute(points) {
    if (routeLine) world.remove(routeLine);
    const geometry = new LineGeometry();
    geometry.setPositions(points.flatMap(p => [p[0], 2, -p[1]]));
    routeLine = new Line2(geometry, routeMaterial);
    world.add(routeLine);
}

// Input
let drag = null;
renderer.domElement.addEventListener('pointerdown', e => drag = {x: e.clientX, y: e.clientY, moved: false});
window.addEventListener('pointermove', e => {
    if (!drag) return;
    const metresPerPixel = 2 * height * tanHalf / window.innerHeight;
    target.x -= (e.clientX - drag.x) * metresPerPixel;
    target.y += (e.clientY - drag.y) * metresPerPixel;
    drag.moved = drag.moved || Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3;
    drag.x = e.clientX;
    drag.y = e.clientY;
});
window.addEventListener('pointerup', e => {
    const click = drag && !drag.moved;
    drag = null;
    if (!click) return;
    const {feature, point} = pick(e);
    if (!e.shiftKey) {
        info.innerHTML = describe(feature);
        return;
    }
    if (!point) return;
    const node = nearestNode(point);
    if (routeStart === null) {
        routeStart = node;
        info.innerHTML = `Route from node ${node.id}, shift-click the destination`;
        return;
    }
    const found = route(routeStart, node);
    info.innerHTML = found
        ? `Route from node ${routeStart.id} to ${node.id}: ${Math.round(found.seconds / 60 * 10) / 10} min`
        : `No road route from node ${routeStart.id} to ${node.id}`;
    if (found) showRoute(found.points);
    routeStart = null;
});
renderer.domElement.addEventListener('wheel', e => {
    height *= e.deltaY > 0 ? 1.1 : 1 / 1.1;
    e.preventDefault();
}, {passive: false});
window.addEventListener('resize', resize);

resize();
renderer.setAnimationLoop(() => {
    placeCamera();
    renderer.render(world, camera);
    placeLabels();
});

// For automated checks
window.mapExample = {scene, route, nodes, features, pick, showRoute, camera, target, setHeight: h => height = h};
