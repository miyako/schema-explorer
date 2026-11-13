import test from 'node:test';
import assert from 'node:assert/strict';
import {Renderer} from '../site/gpu.mjs';
import {makeScene} from '../site/model.mjs';

test('glass geometry has distinct front/back planes and flow follows source-to-destination arc distance', () => {
  const originalRatio = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio');
  Object.defineProperty(globalThis, 'devicePixelRatio', {value: 1, configurable: true});
  try {
    const scene = makeScene({kind: 'catalog.structure',
      tables: ['Many', 'One'].map(name => ({name, fields: [{name: 'ID', typeCode: 13, indexUUIDs: []}]})),
      relations: [{source: {tableIndex: 0, fieldIndex: 0}, destination: {tableIndex: 1, fieldIndex: 0}}]});
    const renderer = Object.create(Renderer.prototype);
    renderer.canvas = {width: 1000, height: 800};
    renderer.texture = () => ({});
    const camera = {yaw: .4, pitch: .2, distance: 1000, target: [0, 0, 0]};
    const frame = renderer.geometry(scene, scene.nodes, camera, null, 1.25);
    assert.equal(frame.visible, 2);
    assert.ok([...frame.data].every(Number.isFinite));
    const draw = frame.draws[0];
    const depth = index => frame.data[index * 10 + 3];
    const backDepths = Array.from({length: 6}, (_, i) => depth(draw.glassFirst + i));
    const frontDepths = Array.from({length: 6}, (_, i) => depth(draw.faces[0].first + i));
    assert.ok(backDepths.every((value, i) => value > frontDepths[i]),
      'the rear glass surface must be physically behind its front face');
    const phase = index => frame.data[index * 10 + 4];
    assert.equal(phase(frame.gridCount), 0);
    assert.ok(phase(frame.gridCount + 2) > 0, 'flow must advance away from the many-side anchor');
    assert.ok(phase(frame.gridCount + frame.flowCount - 1) > phase(frame.gridCount + 2));
  } finally {
    if (originalRatio) Object.defineProperty(globalThis, 'devicePixelRatio', originalRatio);
    else delete globalThis.devicePixelRatio;
  }
});
