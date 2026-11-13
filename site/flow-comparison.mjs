import {Renderer} from './gpu.mjs';
import {WIDTH, makeScene} from './model.mjs';
import {flowOptions} from './flow.mjs';

class LineRenderer extends Renderer {
  geometry(scene, nodes, camera, selected, aspect) {
    const normal = super.geometry(scene, nodes.slice(0, 2), camera, null, aspect, true);
    const highlighted = super.geometry(scene, nodes.slice(2), camera, 2, aspect, true);
    const data = new Float32Array(normal.data.length + highlighted.data.length);
    data.set(normal.data); data.set(highlighted.data, normal.data.length);
    return {...normal, data, flowCount: normal.flowCount + highlighted.flowCount};
  }
}

const previews = [];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let pending = false, failed = false, dirty = true;

function fail(error) {
  failed = true;
  document.getElementById('error').hidden = false;
  document.getElementById('error').textContent = error instanceof Error ? error.message : String(error);
  document.getElementById('status').textContent = 'WEBGPU PREVIEW UNAVAILABLE';
}

function paint(time) {
  for (const {renderer, canvas, scene, camera} of previews) {
    const distance = Math.max(20, canvas.clientWidth / 2 - 36);
    camera.distance = canvas.clientHeight / (2 * Math.tan(Math.PI / 8));
    for (const node of scene.nodes) {
      node.x = (node.id % 2 ? 1 : -1) * (distance + WIDTH / 2);
      node.y = (node.id < 2 ? 28 : -28) + (node.id % 2 ? -10 : 10);
    }
    renderer.render(scene, scene.nodes, camera, null, time, dirty);
  }
  dirty = false;
}

function schedule() {
  if (pending || failed || !previews.length || document.hidden) return;
  pending = true;
  requestAnimationFrame(now => {
    pending = false;
    if (failed || document.hidden) return;
    try {
      paint(reducedMotion.matches ? 0 : now / 1000);
      if (!reducedMotion.matches) schedule();
    } catch (error) { fail(error); }
  });
}

async function initialize() {
  for (const option of flowOptions) {
    const article = document.createElement('article');
    article.id = `option-${option.id}`;
    const caption = document.createElement('div'); caption.className = 'caption';
    const title = document.createElement('h2'); title.textContent = option.label + (option.id === 'b' ? ' (applied)' : '');
    const metrics = document.createElement('p'); metrics.className = 'metrics';
    metrics.textContent = `Light ${Math.round(option.strength * 100)}% / pulse ${Math.round(option.length / 81 * 100)}% / gap ${Math.round(option.gap / 99 * 100)}%`;
    caption.append(title, metrics);
    const preview = document.createElement('div'); preview.className = 'preview';
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-label', `${option.label}: normal and selected relations flowing from N to 1`);
    preview.append(canvas);
    for (const [label, className] of [['NORMAL / N \u2192 1', 'normal'], ['SELECTED / N \u2192 1', 'selected']]) {
      const lane = document.createElement('span'); lane.className = `lane ${className}`;
      lane.textContent = label; preview.append(lane);
    }
    article.append(caption, preview);
    document.getElementById('examples').append(article);
    const renderer = await LineRenderer.create(canvas, fail, option.id === 'current' ? null : option);
    const scene = makeScene({kind: 'catalog.structure',
      tables: Array.from({length: 4}, (_, i) => ({name: `Endpoint ${i}`, fields: [{name: 'ID', typeCode: 13, indexUUIDs: []}]})),
      relations: [0, 2].map(i => ({source: {tableIndex: i, fieldIndex: 0}, destination: {tableIndex: i + 1, fieldIndex: 0}}))});
    for (const node of scene.nodes) node.collapsed = true;
    const camera = {target: [0, 0, 0], distance: 180, yaw: 0, pitch: 0};
    previews.push({renderer, canvas, scene, camera});
  }
  paint(0);
  const status = () => {
    if (failed) return;
    document.getElementById('status').textContent = reducedMotion.matches
      ? 'WEBGPU / REDUCED MOTION / STATIC PREVIEWS' : 'WEBGPU / ANIMATED / EXPLORER USES B';
    dirty = true; schedule();
  };
  new ResizeObserver(() => { dirty = true; schedule(); }).observe(document.getElementById('examples'));
  document.addEventListener('visibilitychange', schedule);
  reducedMotion.addEventListener('change', status);
  status();
  document.body.dataset.ready = 'true';
}

export const ready = initialize();
ready.catch(fail);

export async function renderAt(time) {
  await ready;
  if (failed) throw new Error(document.getElementById('error').textContent);
  paint(time);
  await Promise.all(previews.map(({renderer}) => renderer.device.queue.onSubmittedWorkDone()));
}
