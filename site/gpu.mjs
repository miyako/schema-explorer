import {WIDTH, ROW, height, fieldType, clip, anchor} from './model.mjs';

const shader = `
struct Vertex {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
}
@vertex fn vertex(@location(0) position: vec4f, @location(1) uv: vec2f,
                  @location(2) color: vec4f) -> Vertex {
  var out: Vertex;
  out.position = position; out.uv = uv; out.color = color;
  return out;
}
@group(0) @binding(0) var image: texture_2d<f32>;
@group(0) @binding(1) var imageSampler: sampler;
@fragment fn card(in: Vertex) -> @location(0) vec4f {
  return textureSample(image, imageSampler, in.uv) * in.color;
}
@fragment fn line(in: Vertex) -> @location(0) vec4f { return in.color; }
`;

function ellipsis(ctx, text, width) {
  if (ctx.measureText(text).width <= width) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (ctx.measureText(text.slice(0, mid) + '...').width <= width) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low) + '...';
}

export class Renderer {
  static async create(canvas, fail) {
    if (!isSecureContext) throw new Error('WebGPU requires a secure context. Open this demo over HTTPS, or serve it on localhost for development.');
    if (!navigator.gpu) throw new Error('WebGPU is not available in this browser. Use a current WebGPU-enabled Chrome, Edge, or Safari on a supported device. No WebGL/SVG fallback is used.');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter is available. Enable hardware acceleration, check your graphics driver, or try another supported device.');
    const device = await adapter.requestDevice();
    device.lost.then(info => fail(`WebGPU device lost: ${info.message || info.reason}. Reload to reconnect.`));
    device.addEventListener('uncapturederror', event => fail(`WebGPU rendering error: ${event.error.message}`));
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('The browser could not create a WebGPU canvas context.');
    const format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({device, format, alphaMode: 'opaque'});
    const module = device.createShaderModule({code: shader});
    const compilation = await module.getCompilationInfo();
    const errors = compilation.messages.filter(m => m.type === 'error');
    if (errors.length) throw new Error(errors.map(m => m.message).join('\n'));
    const descriptor = entryPoint => ({
      layout: 'auto',
      vertex: {module, entryPoint: 'vertex', buffers: [{
        arrayStride: 40, attributes: [
          {shaderLocation: 0, offset: 0, format: 'float32x4'},
          {shaderLocation: 1, offset: 16, format: 'float32x2'},
          {shaderLocation: 2, offset: 24, format: 'float32x4'},
        ],
      }]},
      fragment: {module, entryPoint, targets: [{format, blend: {
        color: {srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha'},
        alpha: {srcFactor: 'one', dstFactor: 'one-minus-src-alpha'},
      }}]},
      primitive: {topology: entryPoint === 'line' ? 'line-list' : 'triangle-list'},
    });
    const [cards, lines] = await Promise.all([
      device.createRenderPipelineAsync(descriptor('card')),
      device.createRenderPipelineAsync(descriptor('line')),
    ]);
    return new Renderer(canvas, device, context, cards, lines);
  }

  constructor(canvas, device, context, cards, lines) {
    Object.assign(this, {canvas, device, context, cards, lines});
    this.sampler = device.createSampler({magFilter: 'linear', minFilter: 'linear'});
    this.cache = new Map();
    this.bufferSize = 0;
  }

  texture(node, selected, overview = false) {
    const key = overview ? 'overview' : node.id;
    const version = overview ? 'overview' : `${node.collapsed}/${selected}`;
    let cached = this.cache.get(key);
    if (cached?.version === version) {
      this.cache.delete(key); this.cache.set(key, cached);
      return cached.group;
    }
    cached?.texture.destroy();
    const canvas = document.createElement('canvas');
    const h = overview ? 100 : height(node);
    canvas.width = WIDTH * 2; canvas.height = h * 2;
    const ctx = canvas.getContext('2d');
    ctx.scale(2, 2);
    const gradient = ctx.createLinearGradient(0, 0, WIDTH, h);
    gradient.addColorStop(0, selected ? 'rgba(24,69,87,.98)' : 'rgba(18,43,61,.96)');
    gradient.addColorStop(1, 'rgba(8,20,37,.9)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, WIDTH, h);
    ctx.strokeStyle = selected ? '#b5f6ff' : '#438ba4'; ctx.lineWidth = selected ? 3 : 1;
    ctx.strokeRect(1.5, 1.5, WIDTH - 3, h - 3);
    ctx.fillStyle = selected ? '#8df3ff' : '#5fc6db'; ctx.fillRect(0, 0, 4, h);
    ctx.font = '600 15px system-ui'; ctx.fillStyle = '#e5f6ff';
    ctx.fillText(ellipsis(ctx, overview ? 'SCHEMA / TABLE' : node.table.name, WIDTH - 32), 16, 29);
    if (overview) {
      ctx.font = '11px system-ui'; ctx.fillStyle = '#91b5ca';
      ctx.fillText('Zoom in or select from the table list', 16, 65);
    } else if (node.collapsed) {
      ctx.font = '10px system-ui'; ctx.fillStyle = '#8faec2';
      ctx.fillText(`${node.table.fields.length} fields / collapsed`, 16, 47);
    } else {
      ctx.strokeStyle = '#2c536a'; ctx.beginPath(); ctx.moveTo(16, 42); ctx.lineTo(WIDTH - 16, 42); ctx.stroke();
      node.rows.forEach((field, i) => {
        const y = 65 + i * ROW;
        ctx.font = '12px system-ui'; ctx.fillStyle = field.primaryKey ? '#ffda84' : '#c8e0ec';
        ctx.fillText(field.primaryKey ? 'K' : (field.indexUUIDs?.length ? '#' : '.'), 16, y);
        ctx.fillText(ellipsis(ctx, field.name, 133), 33, y);
        ctx.font = '10px system-ui'; ctx.textAlign = 'right'; ctx.fillStyle = '#83b1c6';
        ctx.fillText(ellipsis(ctx, fieldType(field), 80), WIDTH - 14, y);
        ctx.textAlign = 'left';
      });
      ctx.font = '10px system-ui'; ctx.fillStyle = '#81a2b9';
      const remaining = node.table.fields.length - node.rows.length;
      ctx.fillText(`${remaining ? `+${remaining} fields in inspector` : `${node.table.fields.length} fields`}${node.table.hidden ? ' / hidden in 4D' : ''}`, 16, h - 13);
    }
    const texture = this.device.createTexture({
      size: [canvas.width, canvas.height], format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture({source: canvas}, {texture}, [canvas.width, canvas.height]);
    const group = this.device.createBindGroup({layout: this.cards.getBindGroupLayout(0), entries: [
      {binding: 0, resource: texture.createView()}, {binding: 1, resource: this.sampler},
    ]});
    this.cache.delete(key); this.cache.set(key, {texture, group, version});
    // At most 128 full-resolution card textures, plus one shared overview texture.
    while (this.cache.size > 129) {
      const oldest = this.cache.keys().next().value;
      this.cache.get(oldest).texture.destroy(); this.cache.delete(oldest);
    }
    return group;
  }

  render(scene, nodes, camera, selected) {
    const {canvas, device, context} = this;
    const ratio = Math.min(devicePixelRatio || 1, 2), rect = canvas.getBoundingClientRect();
    const limit = device.limits.maxTextureDimension2D;
    const width = Math.min(limit, Math.max(1, Math.round(rect.width * ratio)));
    const h = Math.min(limit, Math.max(1, Math.round(rect.height * ratio)));
    if (canvas.width !== width || canvas.height !== h) { canvas.width = width; canvas.height = h; }
    const aspect = rect.width / Math.max(1, rect.height);
    const vertices = [];
    const vertex = (p, color, uv = [0, 0]) => vertices.push(...clip(p, camera, aspect), ...uv, ...color);
    const line = (a, b, color) => { vertex(a, color); vertex(b, color); };
    const center = camera.target;
    const spacing = Math.max(150, 150 * Math.floor(camera.distance / 4000));
    for (let i = -16; i <= 16; i++) {
      const x = Math.round(center[0] / spacing) * spacing + i * spacing;
      const y = Math.round(center[1] / spacing) * spacing + i * spacing;
      line([x, center[1] - 16 * spacing, -600], [x, center[1] + 16 * spacing, -600], [.12, .32, .43, .22]);
      line([center[0] - 16 * spacing, y, -600], [center[0] + 16 * spacing, y, -600], [.12, .32, .43, .22]);
    }
    const ids = new Set(nodes.map(n => n.id));
    for (const edge of scene.edges) {
      const a = scene.nodes[edge.source.tableIndex], b = scene.nodes[edge.destination.tableIndex];
      if (!ids.has(a.id) || !ids.has(b.id)) continue;
      const side = a === b || a.x <= b.x ? 1 : -1;
      const start = anchor(a, edge.source.fieldIndex, side), end = anchor(b, edge.destination.fieldIndex, a === b ? 1 : -side);
      const bend = a === b ? 160 : Math.max(65, Math.abs(end[0] - start[0]) * .45);
      const c1 = [start[0] + side * bend, start[1] + (a === b ? 90 : 0), start[2] - 20];
      const c2 = [end[0] + (a === b ? side : -side) * bend, end[1] - (a === b ? 90 : 0), end[2] - 20];
      const active = selected === a.id || selected === b.id;
      const color = active ? [.84, .68, 1, 1] : [.55, .46, .94, selected === null ? .6 : .12];
      let prev = start;
      for (let i = 1; i <= 24; i++) {
        const t = i / 24, s = 1 - t;
        const p = start.map((v, k) => s ** 3 * v + 3 * s ** 2 * t * c1[k] + 3 * s * t ** 2 * c2[k] + t ** 3 * end[k]);
        line(prev, p, color); prev = p;
      }
      const direction = a === b ? 1 : -side;
      line(end, [end[0] + direction * 11, end[1] + 5, end[2]], color);
      line(end, [end[0] + direction * 11, end[1] - 5, end[2]], color);
    }
    const lineCount = vertices.length / 10;
    const visible = nodes.map(node => {
      const p = clip([node.x, node.y, node.z], camera, aspect);
      const extent = Math.max(WIDTH, height(node)) * 2.5;
      return {node, p, extent};
    }).filter(({p, extent}) => p[3] > 1 && Math.abs(p[0]) < p[3] + extent && Math.abs(p[1]) < p[3] + extent)
      .sort((a, b) => b.p[3] - a.p[3]);
    const detailed = new Set([...visible].sort((a, b) =>
      Number(b.node.id === selected) - Number(a.node.id === selected) || a.p[3] - b.p[3])
      .slice(0, 128).map(v => v.node.id));
    const draws = [];
    for (const {node} of visible) {
      const x = node.x, y = node.y, z = node.z, w = WIDTH / 2, h = height(node) / 2;
      const color = [1, 1, 1, 1];
      const first = vertices.length / 10;
      const corners = [[x - w, y + h, z], [x + w, y + h, z], [x - w, y - h, z], [x + w, y - h, z]];
      for (const index of [0, 2, 1, 1, 2, 3]) vertex(corners[index], color, [index % 2, Math.floor(index / 2)]);
      draws.push({first, group: this.texture(node, node.id === selected, !detailed.has(node.id))});
    }
    const data = new Float32Array(vertices);
    if (data.byteLength > this.bufferSize) {
      this.buffer?.destroy();
      this.bufferSize = Math.max(4096, data.byteLength * 2);
      this.buffer = device.createBuffer({size: this.bufferSize, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST});
    }
    device.queue.writeBuffer(this.buffer, 0, data);
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({colorAttachments: [{
      view: context.getCurrentTexture().createView(), clearValue: {r: .02, g: .045, b: .08, a: 1},
      loadOp: 'clear', storeOp: 'store',
    }]});
    pass.setVertexBuffer(0, this.buffer);
    pass.setPipeline(this.lines); pass.draw(lineCount);
    pass.setPipeline(this.cards);
    for (const draw of draws) { pass.setBindGroup(0, draw.group); pass.draw(6, 1, draw.first); }
    pass.end(); device.queue.submit([encoder.finish()]);
    return {visible: visible.length, overview: Math.max(0, visible.length - 128)};
  }
}
