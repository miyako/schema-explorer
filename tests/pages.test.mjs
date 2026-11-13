import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {makeScene} from '../site/model.mjs';
import sample from '../site/sample.mjs';

const read = path => readFile(new URL(`../site/${path}`, import.meta.url), 'utf8');

test('published fixture is the synthetic sample with fully resolved relations', async () => {
  const model = sample;
  assert.equal(model.databaseUUID, 'WEBGPU-DEMO');
  assert.equal(model.name, 'Orbital commerce / synthetic demo');
  assert.deepEqual(model.tables.map(table => table.name), [
    'Customers', 'Addresses', 'Orders', 'OrderLines', 'Products', 'Categories',
    'Suppliers', 'Payments', 'Shipments', 'Reviews', 'Inventory', 'Warehouses',
  ]);
  const scene = makeScene(model);
  assert.equal(scene.edges.length, 14);
  assert.equal(scene.omitted, 0);
  assert.ok(scene.edges.some(edge => edge.source.tableIndex === edge.destination.tableIndex));
  assert.deepEqual(model.warnings, []);
});

test('HTML assets and module imports stay under the project Pages URL', async () => {
  const base = new URL('https://miyako.github.io/schema-explorer/');
  const html = await read('index.html');
  const paths = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(paths, ['./style.css', './app.mjs']);
  for (const name of ['app.mjs', 'gpu.mjs', 'model.mjs', 'catalog.mjs', 'sample.mjs']) {
    const source = await read(name);
    for (const match of source.matchAll(/from ['"]([^'"]+)['"]/g)) paths.push(match[1]);
  }
  for (const path of paths) {
    assert.ok(new URL(path, base).pathname.startsWith('/schema-explorer/'), path);
    assert.ok((await read(path)).length, path);
  }
});
