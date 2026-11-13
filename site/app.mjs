import {makeScene, layout, height, fieldType, neighborhood, fitCamera, pick,
  cameraBasis, add, scale, expansion, makeTransition, advanceTransition} from './model.mjs';
import {Renderer} from './gpu.mjs';
import {readCatalogFiles} from './catalog.mjs';
import sample from './sample.mjs';

const $ = id => document.getElementById(id);
const canvas = $('scene');
let scene, renderer, selected = null, isolated = false, failed = false;
let pending = false, dirty = true;
let localRevision = 0;
const motions = new Map();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const camera = {target: [0, 0, 0], distance: 1800, yaw: .15, pitch: .12};
const aspect = () => canvas.clientWidth / Math.max(1, canvas.clientHeight);

function openModel(model, local = false) {
  const next = makeScene(model);
  motions.clear();
  renderer?.clearScene();
  scene = next; selected = null; isolated = false;
  $('search').value = ''; $('depth').value = 90;
  $('summary').textContent = `${model.name || model.fileName}\n${scene.nodes.length} tables / ${scene.edges.length} resolved relations / ${local ? 'LOCAL FILE / not uploaded' : 'synthetic sample only'}`;
  $('use-demo').hidden = !local;
  $('warnings').replaceChildren();
  const warnings = [...model.warnings];
  if (scene.omitted) warnings.push(`${scene.omitted} unresolved relations cannot be drawn.`);
  if (!scene.nodes.length) warnings.push('This catalog contains no tables.');
  $('notices').hidden = !warnings.length;
  $('notices').open = local && warnings.length > 0;
  for (const warning of warnings) {
    const p = document.createElement('p'); p.textContent = warning; $('warnings').append(p);
  }
  $('local-notes').hidden = !local || !warnings.length;
  $('local-notes').textContent = local && warnings.length
    ? `${warnings.length} parser notes. Some catalog entries or coordinates could not be used; see the inspector.` : '';
  showTables(); select(null); updateDepth(); fit({yaw: .15, pitch: .12});
}

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
  dirty = true;
  scheduleFrame();
}

function scheduleFrame() {
  if (pending || !renderer || failed || document.hidden) return;
  pending = true;
  requestAnimationFrame(now => {
    pending = false;
    if (failed || document.hidden) return;
    try {
      if (motions.size) dirty = true;
      for (const [subject, motion] of motions) {
        if (!advanceTransition(motion, reducedMotion.matches ? Infinity : now)) motions.delete(subject);
      }
      const result = renderer.render(scene, visibleNodes(), camera, selected,
        reducedMotion.matches ? 0 : now / 1000, dirty);
      dirty = false;
      const status = `WEBGPU / ${result.visible} IN VIEW${isolated ? ' / NEIGHBORHOOD' : ''}${result.overview ? ` / ${result.overview} OVERVIEW CARDS` : ''}`;
      if ($('status').textContent !== status) $('status').textContent = status;
      if (motions.size || (!reducedMotion.matches && scene.edges.length)) scheduleFrame();
    } catch (error) { fail(error); }
  });
}

function move(subject, to, duration = 320) {
  const motion = makeTransition(subject, {...motions.get(subject)?.to, ...to}, performance.now(),
    reducedMotion.matches || !renderer || failed ? 0 : duration);
  if (advanceTransition(motion, motion.start)) motions.set(subject, motion);
  else motions.delete(subject);
  invalidate();
}

function updateDepth() {
  for (const node of scene.nodes) {
    const motion = motions.get(node);
    if (motion) { delete motion.to.z; delete motion.from.z; }
    node.z = (node.id % 3 - 1) * Number($('depth').value) + node.offset;
  }
  invalidate();
}

function fit(overrides = {}, nodes = visibleNodes()) {
  const destination = {...camera, ...overrides};
  fitCamera(destination, nodes.map(node => ({...node, expansion: node.collapsed ? 0 : 1})), aspect());
  move(camera, destination, 360);
}

function showTables() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const matches = scene.nodes.filter(n => [n.table.name, ...n.table.fields.map(f => f.name)]
    .some(name => name.toLocaleLowerCase().includes(query)));
  $('matches').textContent = `${matches.length} / ${scene.nodes.length} tables`;
  $('tables').replaceChildren(...matches.map(node => {
    const row = document.createElement('div'); row.className = 'table-entry';
    const button = document.createElement('button'); button.className = 'table-select';
    button.dataset.tableId = node.id;
    button.title = node.table.name;
    const name = document.createElement('span'); name.textContent = node.table.name;
    const count = document.createElement('small'); count.textContent = node.table.fields.length;
    button.append(name, count);
    button.onclick = () => { select(node.id); focus(); };
    const toggle = document.createElement('button'); toggle.className = 'table-toggle';
    toggle.dataset.collapseId = node.id;
    toggle.onclick = () => setCollapsed([node], !node.collapsed);
    row.append(button, toggle);
    return row;
  }));
  updateTableControls();
}

function updateTableControls() {
  for (const button of $('tables').querySelectorAll('[data-table-id]')) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.tableId) === selected));
  }
  for (const button of $('tables').querySelectorAll('[data-collapse-id]')) {
    const node = scene.nodes[Number(button.dataset.collapseId)];
    button.textContent = node.collapsed ? '+' : '-';
    button.title = `${node.collapsed ? 'Restore' : 'Collapse'} ${node.table.name}`;
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(node.collapsed));
  }
  $('collapse-all').disabled = scene.nodes.every(node => node.collapsed);
  $('restore-all').disabled = scene.nodes.every(node => !node.collapsed);
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
    $('collapse').textContent = node.collapsed ? 'Restore' : 'Collapse';
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
  updateTableControls(); invalidate();
}

function focus() {
  const node = scene.nodes[selected];
  if (!node) return;
  const destination = {...node, ...motions.get(node)?.to, expansion: node.collapsed ? 0 : 1};
  move(camera, {target: [destination.x, destination.y, destination.z],
    distance: Math.max(520, height(destination) * 2, 400 / aspect())}, 360);
}

function collapse() {
  if (selected === null) return;
  setCollapsed([scene.nodes[selected]], !scene.nodes[selected].collapsed);
}

function setCollapsed(nodes, collapsed) {
  for (const node of nodes) {
    node.expansion = expansion(node);
    node.collapsed = collapsed;
    move(node, {expansion: collapsed ? 0 : 1}, 260);
  }
  select(selected);
}

function pan(dx, dy) {
  motions.delete(camera);
  const {right, up} = cameraBasis(camera);
  const units = 2 * camera.distance * Math.tan(Math.PI / 8) / Math.max(1, canvas.clientHeight);
  camera.target = add(camera.target, add(scale(right, -dx * units), scale(up, dy * units)));
}

function zoom(factor) {
  motions.delete(camera);
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
  const cancelLocal = () => {
    localRevision++;
    $('local-form').reset();
    $('load-local').disabled = $('cancel-local').disabled = false;
    $('local-dialog').close();
  };
  $('open-local').onclick = () => {
    $('local-error').hidden = true;
    $('local-dialog').showModal();
  };
  $('cancel-local').onclick = cancelLocal;
  $('local-dialog').addEventListener('cancel', cancelLocal);
  $('local-form').onsubmit = async event => {
    event.preventDefault();
    const revision = ++localRevision;
    $('load-local').disabled = true;
    $('cancel-local').disabled = true;
    $('local-error').hidden = true;
    try {
      const model = await readCatalogFiles($('catalog-file').files[0], $('editor-file').files[0]);
      if (revision !== localRevision) return;
      openModel(model, true);
      $('local-form').reset();
      $('local-dialog').close();
    } catch (error) {
      if (revision === localRevision) {
        $('local-error').textContent = error.message;
        $('local-error').hidden = false;
      }
    } finally {
      if (revision === localRevision) $('load-local').disabled = $('cancel-local').disabled = false;
    }
  };
  $('use-demo').onclick = () => openModel(sample);
  $('fit').onclick = () => fit();
  $('front').onclick = () => fit({yaw: 0, pitch: 0});
  $('reset').onclick = () => {
    const restored = layout({nodes: scene.nodes.map(node => ({...node}))});
    for (const destination of restored.nodes) {
      destination.z = (destination.id % 3 - 1) * 90;
      const node = scene.nodes[destination.id];
      node.expansion = expansion(node); node.collapsed = false; node.offset = 0;
      move(node, {x: destination.x, y: destination.y, z: destination.z, expansion: 1}, 360);
    }
    isolated = false; $('depth').value = 90; select(null);
    fit({yaw: .15, pitch: .12}, restored.nodes);
  };
  $('collapse-all').onclick = () => setCollapsed(scene.nodes, true);
  $('restore-all').onclick = () => setCollapsed(scene.nodes, false);
  for (const [buttonId, panelId, className] of [
    ['toggle-tables', 'tables-panel', 'hide-tables'],
    ['toggle-inspector', 'inspector-panel', 'hide-inspector'],
  ]) {
    $(buttonId).onclick = () => {
      const hidden = $('workspace').classList.toggle(className);
      $(buttonId).setAttribute('aria-expanded', String(!hidden));
      $(panelId).inert = hidden;
      $(panelId).setAttribute('aria-hidden', String(hidden));
    };
  }
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
    motions.delete(camera);
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
      motions.delete(gesture.node);
      gesture.node.expansion = gesture.node.collapsed ? 0 : 1;
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
  document.addEventListener('visibilitychange', invalidate);
  reducedMotion.addEventListener('change', invalidate);
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
  installControls(); openModel(sample);
  renderer = await Renderer.create(canvas, fail);
  invalidate();
} catch (error) { fail(error); }
