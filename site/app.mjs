import {makeScene, layout, height, fieldType, neighborhood, fitCamera, pick,
  cameraBasis, add, scale} from './model.mjs';
import {Renderer} from './gpu.mjs';

const $ = id => document.getElementById(id);
const canvas = $('scene');
let scene, renderer, selected = null, isolated = false, failed = false;
let pending = false;
const camera = {target: [0, 0, 0], distance: 1800, yaw: .15, pitch: .12};
const aspect = () => canvas.clientWidth / Math.max(1, canvas.clientHeight);

function fail(message) {
  failed = true;
  $('error').hidden = false;
  $('error').textContent = message instanceof Error ? message.message : String(message);
  $('status').textContent = 'WEBGPU UNAVAILABLE / see error';
}

function visibleNodes() {
  if (!isolated || selected === null) return scene.nodes;
  const ids = neighborhood(scene, selected);
  return scene.nodes.filter(n => ids.has(n.id));
}

function invalidate() {
  if (pending || !renderer || failed) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    try {
      const result = renderer.render(scene, visibleNodes(), camera, selected);
      $('status').textContent = `WEBGPU / ${result.visible} IN VIEW${isolated ? ' / NEIGHBORHOOD' : ''}${result.overview ? ` / ${result.overview} OVERVIEW CARDS` : ''}`;
    } catch (error) { fail(error); }
  });
}

function updateDepth() {
  for (const node of scene.nodes) node.z = (node.id % 3 - 1) * Number($('depth').value) + node.offset;
  invalidate();
}

function fit() { fitCamera(camera, visibleNodes(), aspect()); invalidate(); }

function showTables() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const matches = scene.nodes.filter(n => [n.table.name, ...n.table.fields.map(f => f.name)]
    .some(name => name.toLocaleLowerCase().includes(query)));
  $('matches').textContent = `${matches.length} / ${scene.nodes.length} tables`;
  $('tables').replaceChildren(...matches.map(node => {
    const button = document.createElement('button');
    button.dataset.tableId = node.id;
    button.setAttribute('aria-pressed', String(node.id === selected));
    const name = document.createElement('span'); name.textContent = node.table.name;
    const count = document.createElement('small'); count.textContent = node.table.fields.length;
    button.append(name, count);
    button.onclick = () => { select(node.id); focus(); };
    return button;
  }));
}

function select(id) {
  selected = id;
  const node = scene.nodes[id];
  $('actions').hidden = !node;
  $('table-title').textContent = node ? node.table.name : 'Explore the structure';
  $('table-info').textContent = node
    ? `${node.table.fields.length} fields${node.table.hidden ? ' / hidden in 4D' : ''}${node.table.encryptable ? ' / encryptable' : ''}\n${node.table.uuid || 'No table UUID'}`
    : 'Select a table in the scene or list. Connected relations light up; all fields remain available here.';
  $('fields').replaceChildren();
  $('relations').replaceChildren();
  if (node) {
    $('pull').value = node.offset;
    $('collapse').textContent = node.collapsed ? 'Expand' : 'Collapse';
    $('collapse').setAttribute('aria-pressed', String(node.collapsed));
    for (const field of node.table.fields) {
      const row = document.createElement('div'); row.className = 'field';
      const name = document.createElement('span');
      name.textContent = `${field.primaryKey ? 'KEY / ' : ''}${field.name}`;
      if (field.primaryKey) name.className = 'primary';
      const type = document.createElement('small');
      type.textContent = [fieldType(field), field.notNull && 'not null', field.unique && 'unique',
        field.autoSequence && 'auto sequence', field.indexUUIDs.length > 0 && 'indexed', field.hidden && 'hidden'].filter(Boolean).join(' / ');
      row.append(name, type); $('fields').append(row);
    }
    const relations = scene.edges.filter(e => e.source.tableIndex === id || e.destination.tableIndex === id);
    const title = document.createElement('h3'); title.textContent = `${relations.length} relations`;
    $('relations').append(title);
    for (const edge of relations) {
      const other = edge.source.tableIndex === id ? edge.destination.tableIndex : edge.source.tableIndex;
      const label = e => `[${scene.nodes[e.tableIndex].table.name}] ${scene.nodes[e.tableIndex].table.fields[e.fieldIndex].name}`;
      const button = document.createElement('button');
      button.textContent = `${label(edge.source)} (N) \u2192 ${label(edge.destination)} (1)`;
      const detail = document.createElement('small');
      detail.textContent = [edge.name, edge.inverseName, edge.foreignKey && 'foreign key',
        edge.integrity && `integrity: ${edge.integrity}`,
        `auto-load N\u21921: ${edge.autoLoadManyToOne ? 'on' : 'off'}, 1\u2192N: ${edge.autoLoadOneToMany ? 'on' : 'off'}`].filter(Boolean).join(' / ');
      button.append(document.createElement('br'), detail);
      button.onclick = () => { select(other); focus(); };
      $('relations').append(button);
    }
  } else isolated = false;
  $('neighbors').setAttribute('aria-pressed', String(isolated));
  showTables(); invalidate();
}

function focus() {
  const node = scene.nodes[selected];
  if (!node) return;
  camera.target = [node.x, node.y, node.z];
  camera.distance = Math.max(520, height(node) * 2, 400 / aspect());
  invalidate();
}

function collapse() {
  if (selected === null) return;
  scene.nodes[selected].collapsed = !scene.nodes[selected].collapsed;
  select(selected);
}

function pan(dx, dy) {
  const {right, up} = cameraBasis(camera);
  const units = 2 * camera.distance * Math.tan(Math.PI / 8) / Math.max(1, canvas.clientHeight);
  camera.target = add(camera.target, add(scale(right, -dx * units), scale(up, dy * units)));
}

function zoom(factor) {
  camera.distance = Math.max(180, Math.min(300000, camera.distance * factor));
  invalidate();
}

function hit(event) {
  const rect = canvas.getBoundingClientRect();
  return pick(visibleNodes(), camera, aspect(),
    (event.clientX - rect.left) / rect.width * 2 - 1,
    1 - (event.clientY - rect.top) / rect.height * 2);
}

function installControls() {
  $('fit').onclick = fit;
  $('front').onclick = () => { camera.yaw = camera.pitch = 0; fit(); };
  $('reset').onclick = () => {
    layout(scene); isolated = false; $('depth').value = 90;
    updateDepth(); select(null); camera.yaw = .15; camera.pitch = .12; fit();
  };
  $('search').oninput = showTables;
  $('focus').onclick = focus;
  $('collapse').onclick = collapse;
  $('clear').onclick = () => select(null);
  $('neighbors').onclick = () => {
    isolated = !isolated;
    $('neighbors').setAttribute('aria-pressed', String(isolated)); fit();
  };
  $('pull').oninput = () => {
    if (selected === null) return;
    scene.nodes[selected].offset = Number($('pull').value); updateDepth();
  };
  $('depth').oninput = updateDepth;
  const pointers = new Map();
  let gesture = null;
  canvas.oncontextmenu = event => event.preventDefault();
  canvas.onpointerdown = event => {
    canvas.focus(); canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
    const picked = hit(event);
    gesture = {x: event.clientX, y: event.clientY, moved: false,
      node: picked?.node, mode: event.shiftKey || event.button === 2 ? 'pan' : picked ? 'node' : 'orbit'};
    if (pointers.size > 1) { gesture.mode = 'multi'; gesture.moved = true; }
  };
  canvas.onpointermove = event => {
    const previous = pointers.get(event.pointerId);
    if (!previous || !gesture) return;
    const dx = event.clientX - previous.x, dy = event.clientY - previous.y;
    if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 4) gesture.moved = true;
    if (pointers.size === 2) {
      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)[1];
      const before = Math.hypot(previous.x - other.x, previous.y - other.y);
      const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
      if (after > 1 && before > 1) zoom(before / after);
      pan(dx / 2, dy / 2);
    } else if (gesture.mode === 'node' && gesture.moved) {
      const old = hitPlane(previous.x, previous.y, gesture.node.z);
      const now = hitPlane(event.clientX, event.clientY, gesture.node.z);
      gesture.node.x += now[0] - old[0]; gesture.node.y += now[1] - old[1];
    } else if (gesture.mode === 'pan') pan(dx, dy);
    else if (gesture.mode === 'orbit') {
      camera.yaw = Math.max(-1.2, Math.min(1.2, camera.yaw - dx * .005));
      camera.pitch = Math.max(-.85, Math.min(.85, camera.pitch + dy * .005));
    }
    pointers.set(event.pointerId, {x: event.clientX, y: event.clientY});
    invalidate();
  };
  const end = event => {
    if (event.type === 'pointerup' && gesture && !gesture.moved) select(gesture.node?.id ?? null);
    pointers.delete(event.pointerId);
    if (pointers.size === 0) gesture = null;
    else if (gesture) gesture.mode = 'multi';
  };
  canvas.onpointerup = end; canvas.onpointercancel = end; canvas.onlostpointercapture = end;
  canvas.ondblclick = event => { const picked = hit(event); if (picked) { select(picked.node.id); collapse(); } };
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    zoom(Math.exp(Math.max(-.3, Math.min(.3, event.deltaY * (event.deltaMode === 1 ? .035 : .0015)))));
  }, {passive: false});
  canvas.onkeydown = event => {
    if (event.key.toLowerCase() === 'f') fit();
    else if (['+', '='].includes(event.key)) zoom(.85);
    else if (event.key === '-') zoom(1.18);
    else if (event.key === 'Escape') select(null);
    else if (event.key.startsWith('Arrow')) {
      pan(event.key === 'ArrowLeft' ? 45 : event.key === 'ArrowRight' ? -45 : 0,
        event.key === 'ArrowUp' ? 45 : event.key === 'ArrowDown' ? -45 : 0);
    } else return;
    event.preventDefault(); invalidate();
  };
  new ResizeObserver(invalidate).observe(canvas);
}

function hitPlane(x, y, z) {
  const rect = canvas.getBoundingClientRect();
  const {eye, forward, right, up} = cameraBasis(camera);
  const f = Math.tan(Math.PI / 8);
  const nx = (x - rect.left) / rect.width * 2 - 1, ny = 1 - (y - rect.top) / rect.height * 2;
  const ray = add(forward, add(scale(right, nx * aspect() * f), scale(up, ny * f)));
  const t = (z - eye[2]) / ray[2];
  return add(eye, scale(ray, t));
}

try {
  const response = await fetch(new URL('./catalog.json', import.meta.url));
  if (!response.ok) throw new Error(`Catalog request failed: HTTP ${response.status}`);
  scene = makeScene(await response.json());
  $('summary').textContent = `${scene.model.name || scene.model.fileName}\n${scene.nodes.length} tables / ${scene.edges.length} resolved relations / synthetic sample only`;
  const warnings = [...scene.model.warnings];
  if (scene.omitted) warnings.push(`${scene.omitted} unresolved relations cannot be drawn.`);
  if (!scene.nodes.length) warnings.push('This catalog contains no tables.');
  if (warnings.length) {
    $('notices').hidden = false;
    for (const warning of warnings) {
      const p = document.createElement('p'); p.textContent = warning; $('warnings').append(p);
    }
  }
  installControls(); showTables(); updateDepth(); fit();
  renderer = await Renderer.create(canvas, fail);
  invalidate();
} catch (error) { fail(error); }
