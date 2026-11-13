export const WIDTH = 280;
export const ROW = 23;
export const MAX_FIELDS = 8;
export const add = (a, b) => a.map((v, i) => v + b[i]);
export const sub = (a, b) => a.map((v, i) => v - b[i]);
export const scale = (a, s) => a.map(v => v * s);
export const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

export function fieldType(field) {
  if ([10, 14, 17].includes(field.typeCode)) {
    return field.limitingLength > 0 ? `Alpha (${field.limitingLength})` : 'Text';
  }
  return ({1: 'Boolean', 2: 'Byte', 3: 'Integer', 4: 'Long Integer', 5: 'Integer 64 bit',
    6: 'Real', 7: 'Float', 8: 'Date', 9: 'Time', 11: 'BLOB', 12: 'Picture',
    13: 'UUID', 18: 'BLOB', 21: 'Object'})[field.typeCode] ?? `Type ${field.typeCode}`;
}

export function makeScene(model) {
  if (model.kind !== 'catalog.structure' || !Array.isArray(model.tables) || !Array.isArray(model.relations)) {
    throw new Error('The server did not return a parsed 4D catalog.');
  }
  const valid = e => Number.isInteger(e?.tableIndex) && Number.isInteger(e?.fieldIndex)
    && Boolean(model.tables[e.tableIndex]?.fields[e.fieldIndex]);
  const edges = model.relations.filter(r => valid(r.source) && valid(r.destination));
  const connected = new Map();
  for (const edge of edges) for (const endpoint of [edge.source, edge.destination]) {
    if (!connected.has(endpoint.tableIndex)) connected.set(endpoint.tableIndex, new Set());
    connected.get(endpoint.tableIndex).add(endpoint.fieldIndex);
  }
  const nodes = model.tables.map((table, id) => {
    const joins = connected.get(id) ?? new Set();
    const priority = table.fields.map((f, index) => ({...f, index}))
      .sort((a, b) => Number(b.primaryKey || joins.has(b.index)) - Number(a.primaryKey || joins.has(a.index)) || a.index - b.index)
      .slice(0, MAX_FIELDS).sort((a, b) => a.index - b.index);
    return {id, table, rows: priority, collapsed: false, offset: 0, x: 0, y: 0, z: 0};
  });
  const scene = {model, nodes, edges, omitted: model.relations.length - edges.length};
  layout(scene);
  return scene;
}

export function expansion(node) { return node.expansion ?? (node.collapsed ? 0 : 1); }

export function height(node) { return 58 + expansion(node) * (20 + node.rows.length * ROW); }

export function makeTransition(subject, to, start, duration = 320) {
  const copy = value => Array.isArray(value) ? [...value] : value;
  return {subject, to: Object.fromEntries(Object.entries(to).map(([key, value]) => [key, copy(value)])),
    from: Object.fromEntries(Object.keys(to).map(key => [key, copy(subject[key])])),
    start, duration};
}

export function advanceTransition(motion, now) {
  const t = motion.duration ? Math.max(0, Math.min(1, (now - motion.start) / motion.duration)) : 1;
  const eased = t * t * (3 - 2 * t);
  for (const [key, end] of Object.entries(motion.to)) {
    const start = motion.from[key];
    motion.subject[key] = Array.isArray(end)
      ? end.map((value, i) => start[i] + (value - start[i]) * eased)
      : start + (end - start) * eased;
  }
  return t < 1;
}

export function layout(scene) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(scene.nodes.length)));
  // Normalize large absolute editor coordinates without changing their relative distances.
  const positioned = scene.nodes.filter(n => n.table.position);
  const minX = positioned.length ? Math.min(...positioned.map(n => n.table.position.x)) : 0;
  const minY = positioned.length ? Math.min(...positioned.map(n => n.table.position.y)) : 0;
  const maxX = positioned.length ? Math.max(...positioned.map(n => n.table.position.x)) : 0;
  const maxY = positioned.length ? Math.max(...positioned.map(n => n.table.position.y)) : 0;
  const halfSpan = Math.max(1, maxX / 2 - minX / 2, maxY / 2 - minY / 2);
  const normalizer = Math.min(1, 10000 / halfSpan);
  const x = value => value * normalizer - minX * normalizer;
  const y = value => value * normalizer - minY * normalizer;
  let unplaced = 0;
  for (const n of scene.nodes) {
    const p = n.table.position;
    n.x = p ? x(p.x) : (positioned.length ? x(maxX) + 400 : 0) + (unplaced % columns) * 365;
    n.y = p ? -y(p.y) : -Math.floor(unplaced / columns) * 340;
    if (!p) unplaced++;
    n.offset = 0;
    n.collapsed = false;
    delete n.expansion;
  }
  const bounds = scene.nodes.reduce((b, n) => [
    Math.min(b[0], n.x), Math.max(b[1], n.x), Math.min(b[2], n.y), Math.max(b[3], n.y),
  ], [Infinity, -Infinity, Infinity, -Infinity]);
  for (const n of scene.nodes) { n.x -= (bounds[0] + bounds[1]) / 2; n.y -= (bounds[2] + bounds[3]) / 2; }
  return scene;
}

export function neighborhood(scene, id) {
  const ids = new Set([id]);
  for (const edge of scene.edges) {
    const a = edge.source.tableIndex, b = edge.destination.tableIndex;
    if (a === id || b === id) { ids.add(a); ids.add(b); }
  }
  return ids;
}

export function cameraBasis(camera) {
  const {yaw, pitch, distance, target} = camera;
  const back = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up = [-Math.sin(yaw) * Math.sin(pitch), Math.cos(pitch), -Math.cos(yaw) * Math.sin(pitch)];
  return {eye: add(target, scale(back, distance)), forward: scale(back, -1), right, up};
}

export function clip(point, camera, aspect) {
  const {eye, forward, right, up} = cameraBasis(camera);
  const d = sub(point, eye), depth = dot(d, forward);
  const near = 1, far = 1000000, f = 1 / Math.tan(Math.PI / 8);
  return [dot(d, right) * f / aspect, dot(d, up) * f,
    far / (far - near) * depth - near * far / (far - near), depth];
}

export function pick(nodes, camera, aspect, nx, ny) {
  const {eye, forward, right, up} = cameraBasis(camera);
  const f = Math.tan(Math.PI / 8);
  const ray = add(forward, add(scale(right, nx * aspect * f), scale(up, ny * f)));
  let hit = null;
  for (const node of nodes) {
    const t = (node.z - eye[2]) / ray[2];
    if (!Number.isFinite(t) || t <= 1 || (hit && t >= hit.t)) continue;
    const point = add(eye, scale(ray, t));
    if (Math.abs(point[0] - node.x) <= WIDTH / 2 && Math.abs(point[1] - node.y) <= height(node) / 2) {
      hit = {node, t, point};
    }
  }
  return hit;
}

export function anchor(node, fieldIndex, side) {
  const row = node.rows.findIndex(f => f.index === fieldIndex);
  const y = row < 0 ? node.y : node.y + expansion(node) * ((78 + node.rows.length * ROW) / 2 - 60 - row * ROW);
  return [node.x + side * WIDTH / 2, y, node.z + 1];
}

export function fitCamera(camera, nodes, aspect) {
  if (!nodes.length) { camera.target = [0, 0, 0]; camera.distance = 1000; return; }
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (const n of nodes) {
    const extent = [WIDTH / 2, height(n) / 2, 0];
    for (let i = 0; i < 3; i++) {
      low[i] = Math.min(low[i], [n.x, n.y, n.z][i] - extent[i]);
      high[i] = Math.max(high[i], [n.x, n.y, n.z][i] + extent[i]);
    }
  }
  camera.target = low.map((v, i) => (v + high[i]) / 2);
  const {right, up, forward} = cameraBasis(camera);
  let required = 300;
  const tan = Math.tan(Math.PI / 8);
  for (const n of nodes) for (const dx of [-WIDTH / 2, WIDTH / 2]) for (const dy of [-height(n) / 2, height(n) / 2]) {
    const p = sub([n.x + dx, n.y + dy, n.z], camera.target);
    required = Math.max(required, Math.abs(dot(p, right)) / (tan * aspect) - dot(p, forward),
      Math.abs(dot(p, up)) / tan - dot(p, forward));
  }
  camera.distance = required * 1.18 + 80;
}
