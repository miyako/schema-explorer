import test from 'node:test';
import assert from 'node:assert/strict';
import {makeScene, height, anchor, neighborhood, pick, clip, fitCamera, layout,
  makeTransition, advanceTransition, MAX_FIELDS} from '../site/model.mjs';

const field = (name, primaryKey = false) => ({name, primaryKey, typeCode: 13, indexUUIDs: []});
const table = (name, count = 3, position) => ({
  name, position, fields: Array.from({length: count}, (_, i) => field(`${name}_${i}`, i === 0)),
});
const relation = (a, af, b, bf) => ({
  source: {tableIndex: a, fieldIndex: af}, destination: {tableIndex: b, fieldIndex: bf},
});
const catalog = (tables, relations = []) => ({kind: 'catalog.structure', tables, relations});

test('preserves array-index endpoints and prioritizes keys/joins without losing inspector fields', () => {
  const scene = makeScene(catalog([table('A', 20), table('B')], [
    relation(0, 19, 1, 0), relation(0, 999, 1, 0), relation(0, 1, 100, 0),
  ]));
  assert.equal(scene.omitted, 2);
  assert.equal(scene.nodes[0].rows.length, MAX_FIELDS);
  assert.deepEqual(scene.nodes[0].rows.map(f => f.index), [0, 1, 2, 3, 4, 5, 6, 19]);
  assert.equal(scene.nodes[0].table.fields.length, 20);
  assert.deepEqual([...neighborhood(scene, 0)], [0, 1]);
  assert.equal(anchor(scene.nodes[0], 19, 1)[1], scene.nodes[0].y + height(scene.nodes[0]) / 2 - 60 - 7 * 23);
  scene.nodes[0].collapsed = true;
  assert.equal(height(scene.nodes[0]), 58);
  assert.equal(anchor(scene.nodes[0], 19, 1)[1], scene.nodes[0].y);
});

test('uses parsed editor coordinates, including negative/zero positions, and restores moved nodes', () => {
  const scene = makeScene(catalog([table('A', 3, {x: -50, y: 0}), table('B', 3, {x: 400, y: 100}), table('C')]));
  assert.equal(scene.nodes[1].x - scene.nodes[0].x, 450);
  assert.equal(scene.nodes[1].y - scene.nodes[0].y, -100);
  assert.ok(scene.nodes[2].x > scene.nodes[1].x);
  const original = scene.nodes.map(n => [n.x, n.y]);
  scene.nodes[0].x += 250; scene.nodes[0].offset = 120; scene.nodes[0].collapsed = true;
  layout(scene);
  assert.deepEqual(scene.nodes.map(n => [n.x, n.y]), original);
  assert.equal(scene.nodes[0].offset, 0);
  assert.equal(scene.nodes[0].collapsed, false);
});

test('picking agrees with perspective projection and selects the nearest overlapping card', () => {
  const nodes = makeScene(catalog([table('A'), table('B')])).nodes;
  nodes[0].x = nodes[1].x = 30; nodes[0].y = nodes[1].y = -40;
  nodes[0].z = 0; nodes[1].z = 90;
  const camera = {yaw: .25, pitch: -.15, distance: 1000, target: [0, 0, 0]};
  const p = clip([nodes[1].x, nodes[1].y, nodes[1].z], camera, 1.4);
  assert.equal(pick(nodes, camera, 1.4, p[0] / p[3], p[1] / p[3]).node.id, 1);
  assert.equal(pick(nodes, camera, 1.4, 20, 20), null);
});

test('fit contains every table corner at narrow/wide aspects and oblique camera angles', () => {
  const scene = makeScene(catalog(Array.from({length: 400}, (_, i) => table(`Table ${i}`, i % 20))));
  for (const aspect of [.4, 1, 2.8]) for (const yaw of [-1.1, 0, 1.1]) {
    const camera = {yaw, pitch: .6, distance: 1000, target: [0, 0, 0]};
    for (const n of scene.nodes) n.z = n.id % 3 * 150;
    fitCamera(camera, scene.nodes, aspect);
    for (const n of scene.nodes) for (const dx of [-140, 140]) for (const dy of [-height(n) / 2, height(n) / 2]) {
      const p = clip([n.x + dx, n.y + dy, n.z], camera, aspect);
      assert.ok(Math.abs(p[0] / p[3]) < 1 && Math.abs(p[1] / p[3]) < 1);
      assert.ok(p[2] >= 0 && p[2] <= p[3]);
    }
  }
});

test('empty catalogs and self-relations remain navigable', () => {
  const empty = makeScene(catalog([]));
  const camera = {yaw: 0, pitch: 0, distance: 1, target: [10, 10, 10]};
  fitCamera(camera, empty.nodes, 1);
  assert.deepEqual(camera.target, [0, 0, 0]);
  assert.equal(pick(empty.nodes, camera, 1, 0, 0), null);
  const scene = makeScene(catalog([table('Self')], [relation(0, 2, 0, 0)]));
  assert.deepEqual([...neighborhood(scene, 0)], [0]);
  assert.equal(scene.edges.length, 1);
});

test('extreme but finite editor coordinates normalize without overflowing', () => {
  const scene = makeScene(catalog([
    table('A', 1, {x: -1e308, y: 1e308}),
    table('B', 1, {x: 1e308, y: -1e308}),
  ]));
  for (const n of scene.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
  assert.ok(scene.nodes[1].x - scene.nodes[0].x <= 20001);
  assert.ok(scene.nodes[1].x - scene.nodes[0].x >= 19999);
});

test('collapsing interpolates card bounds and field anchors, and restores from a partial transition', () => {
  const node = makeScene(catalog([table('A')])).nodes[0];
  const fullHeight = height(node), fullAnchor = anchor(node, 0, 1);
  node.expansion = 1; node.collapsed = true;
  const closing = makeTransition(node, {expansion: 0}, 100, 260);
  assert.equal(advanceTransition(closing, 230), true);
  assert.equal(height(node), (fullHeight + 58) / 2);
  assert.equal(anchor(node, 0, 1)[1], (fullAnchor[1] + node.y) / 2);

  const camera = {yaw: 0, pitch: 0, distance: 1000, target: [0, 0, 0]};
  const p = clip([node.x, node.y + height(node) / 2 + 1, node.z], camera, 1);
  assert.equal(pick([node], camera, 1, p[0] / p[3], p[1] / p[3]), null);

  const halfway = height(node);
  node.collapsed = false;
  const opening = makeTransition(node, {expansion: 1}, 230, 260);
  advanceTransition(opening, 230);
  assert.equal(height(node), halfway);
  assert.equal(advanceTransition(opening, 490), false);
  assert.equal(height(node), fullHeight);
  assert.deepEqual(anchor(node, 0, 1), fullAnchor);
  node.collapsed = true;
  advanceTransition(makeTransition(node, {expansion: 0}, 500, 260), 760);
  assert.equal(height(node), 58);
  assert.equal(anchor(node, 0, 1)[1], node.y);
});

test('camera transitions are smooth, interruptible, and support immediate reduced-motion endpoints', () => {
  const camera = {target: [0, 0, 0], distance: 1800, yaw: .15, pitch: .12};
  const target = {target: [100, 200, 90], distance: 600, yaw: 0, pitch: 0};
  const motion = makeTransition(camera, target, 0, 360);
  target.target[0] = 999;
  assert.equal(advanceTransition(motion, 0), true);
  assert.equal(camera.distance, 1800);
  advanceTransition(motion, 180);
  assert.deepEqual(camera.target, [50, 100, 45]);
  assert.equal(camera.distance, 1200);
  const next = makeTransition(camera, {target: [-100, 0, 0], distance: 900}, 180, 360);
  advanceTransition(next, 180);
  assert.deepEqual(camera.target, [50, 100, 45]);
  assert.equal(advanceTransition(next, 540), false);
  assert.deepEqual(camera.target, [-100, 0, 0]);
  assert.equal(camera.distance, 900);
  assert.equal(advanceTransition(makeTransition(camera, {yaw: 0, pitch: 0}, 600, 0), 600), false);
  assert.equal(camera.yaw, 0);
  assert.equal(camera.pitch, 0);
});
