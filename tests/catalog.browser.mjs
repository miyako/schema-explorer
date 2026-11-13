import {parseCatalog, readCatalogFiles} from '../site/catalog.mjs';

const output = document.getElementById('results');
let passed = 0;
const assert = (condition, message = 'Assertion failed') => { if (!condition) throw new Error(message); };
const normalized = value => {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, normalized(value[key])]));
  return value;
};
const equal = (actual, expected) => assert(JSON.stringify(normalized(actual)) === JSON.stringify(normalized(expected)),
  `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const rejects = async (fn, pattern) => {
  let caught;
  try { await fn(); } catch (error) { caught = error; }
  assert(caught && pattern.test(caught.message), `Expected error ${pattern}, got ${caught?.message}`);
};
const check = async (name, fn) => {
  await fn(); passed++;
  output.textContent += `PASS ${name}\n`;
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await wait(10);
  }
  throw new Error('Timed out waiting for the local-file UI.');
};

try {
  const [xml, expected] = await Promise.all([
    fetch('./fixtures/catalog.4DCatalog').then(response => response.text()),
    fetch('./fixtures/catalog.expected.json').then(response => response.json()),
  ]);
  await check('browser decoder matches the existing Swift parser golden model', () => {
    equal(parseCatalog(xml), expected);
  });
  await check('companion coordinates override embedded positions by unique table name', () => {
    const model = parseCatalog(xml, {editorText: '{"tables":{"Clients":{"coordinates":{"left":"-300.5","top":0}}}}'});
    equal(model.tables.map(table => table.position), [{x: -300.5, y: 0}, {x: 400, y: 20}]);
    equal(model.warnings, []);
    const invalid = parseCatalog(xml, {editorText: '{"tables":{"Clients":{"coordinates":{"left":true,"top":4}}}}'});
    equal(invalid.tables[0].position, {x: -20.5, y: 10});
    assert(invalid.warnings.some(warning => warning.includes('invalid editor coordinates')));
  });
  await check('ambiguous UUIDs/names do not resolve arbitrarily and missing UUIDs fall back to names', () => {
    const model = parseCatalog(`<base><table name="A" uuid="AB-CD"><field name="ID" uuid="EF-GH" type="13"/>
      <primary_key field_uuid="efgh"/></table><table name="B"><field name="ID" type="4"/><field name="ID" type="4"/>
      <primary_key field_name="ID"/></table><relation><related_field kind="source"><field_ref uuid="missing" name="ID">
      <table_ref uuid="abcd"/></field_ref></related_field><related_field kind="destination"><field_ref name="ID">
      <table_ref name="B"/></field_ref></related_field></relation></base>`);
    assert(model.tables[0].fields[0].primaryKey);
    assert(model.tables[1].fields.every(field => !field.primaryKey));
    equal(model.relations[0].source.tableIndex, 0);
    equal(model.relations[0].source.fieldIndex, 0);
    equal(model.relations[0].destination.fieldIndex, undefined);
    assert(model.warnings.some(warning => warning.includes('Unresolved relation')));
    const ambiguous = parseCatalog(`<base><table name="A" uuid="AA"><field name="ID" type="4"/></table>
      <table name="B" uuid="aa"><field name="ID" type="4"/></table><relation>
      <related_field kind="source"><field_ref name="ID"><table_ref uuid="AA" name="A"/></field_ref></related_field>
      <related_field kind="destination"><field_ref name="ID"><table_ref name="B"/></field_ref></related_field></relation></base>`);
    equal(ambiguous.relations[0].source.tableIndex, undefined);
    const duplicates = parseCatalog('<base><table name="A"/><table name="A"/></base>',
      {editorText: '{"tables":{"A":{"coordinates":{"left":1,"top":2}}}}'});
    assert(duplicates.tables.every(table => !table.position));
    assert(duplicates.warnings.some(warning => warning.includes('ambiguous')));
  });
  await check('malformed catalogs, custom entities, and unsupported roots are rejected', async () => {
    for (const text of ['', 'not XML', '<base><table></base>', '<other/>']) {
      await rejects(() => parseCatalog(text), /Malformed|Expected/);
    }
    for (const declaration of ['<!ENTITY secret "expanded">', '<!ENTITY secret SYSTEM "https://example.invalid/secret">']) {
      await rejects(() => parseCatalog(`<!DOCTYPE base [${declaration}]><base name="&secret;"/>`), /entities|DTD/);
    }
    await rejects(() => parseCatalog('<!DOCTYPE base SYSTEM "<!--" [<!ENTITY secret "expanded"><!-- -->]><base name="&secret;"/>'), /entities|DTD/);
    equal(parseCatalog('<!DOCTYPE base SYSTEM "https://example.invalid/base.dtd"><base/>').tables, []);
    equal(parseCatalog('<base><!-- <!ENTITY ignored "comment"> --><future><table name="Not a table"/></future></base>').tables, []);
  });
  await check('malformed, duplicate-key, deep, and non-finite layout JSON is rejected', async () => {
    for (const editorText of ['not JSON', '{"tables":[]}', '{"tables":{},"tables":{}}',
      '{"tables":{"A":{},"\\u0041":{}}}', '{"tables":{},"x":1e999}',
      '{"tables":{},"x":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}']) {
      await rejects(() => parseCatalog('<base/>', {editorText}), /catalog_editor.json/);
    }
  });
  await check('resource limits are enforced and warnings are bounded', async () => {
    await rejects(() => parseCatalog('<base/>', {fileSize: 32 * 1024 * 1024 + 1}), /32 MiB/);
    await rejects(() => parseCatalog('<base>' + '<x>'.repeat(128) + '</x>'.repeat(128) + '</base>'), /nesting/);
    await rejects(() => parseCatalog('<base>' + '<x/>'.repeat(200000) + '</base>'), /200,000/);
    await rejects(() => parseCatalog('<base/>', {editorText: ' '.repeat(4 * 1024 * 1024 + 1)}), /4 MiB/);
    const model = parseCatalog('<base>' + '<table/>'.repeat(110) + '</base>');
    equal(model.warnings.length, 101);
  });
  await check('File API supports UTF-8/UTF-16 and declared legacy encoding, not binary database files', async () => {
    const text = '<?xml version="1.0" encoding="UTF-16"?><base name="日本語"><table name="顧客"/></base>';
    for (const little of [true, false]) {
      const bytes = new Uint8Array(2 + text.length * 2);
      bytes.set(little ? [255, 254] : [254, 255]);
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        bytes.set(little ? [code & 255, code >> 8] : [code >> 8, code & 255], 2 + i * 2);
      }
      const model = await readCatalogFiles(new File([bytes], 'catalog.4DCatalog'));
      equal(model.name, '日本語'); equal(model.tables[0].name, '顧客');
    }
    const legacy = '<?xml version="1.0" encoding="ISO-8859-1"?><base name="Café"/>';
    equal((await readCatalogFiles(new File([Uint8Array.from(legacy, value => value.charCodeAt(0))], 'legacy.4DCatalog'))).name, 'Café');
    await rejects(() => readCatalogFiles(new File(['binary'], 'db.4DD')), /\.4DB\/.4DD/);
    await rejects(() => readCatalogFiles(new File([new Uint8Array([0xff])], 'bad.4DCatalog')), /encoding/);
    await rejects(() => readCatalogFiles({name: 'big.4DCatalog', size: 32 * 1024 * 1024 + 1}), /32 MiB/);
    await rejects(() => readCatalogFiles(new File(['<base/>'], 'catalog.4DCatalog'),
      {name: 'catalog_editor.json', size: 4 * 1024 * 1024 + 1}), /4 MiB/);
    await rejects(() => readCatalogFiles(new File(['<base/>'], 'catalog.4DCatalog'),
      new File(['{}'], 'other.json')), /named catalog_editor/);
  });
  await check('local-file UI sends no requests, embeds no schema URLs, and restores the demo without fetching', async () => {
    const iframe = document.createElement('iframe');
    iframe.width = '1280'; iframe.height = '800';
    document.body.append(iframe);
    try {
      await new Promise(resolve => { iframe.onload = resolve; iframe.src = '../site/'; });
      const w = iframe.contentWindow, d = iframe.contentDocument, $ = id => d.getElementById(id);
      await until(() => $('tables').children.length === 12);
      const requests = [], violations = [];
      const block = name => (...args) => { requests.push([name, String(args[0])]); throw new Error('Unexpected network request'); };
      w.fetch = block('fetch');
      w.XMLHttpRequest.prototype.open = block('XMLHttpRequest');
      w.navigator.sendBeacon = block('beacon');
      w.WebSocket = block('WebSocket');
      w.EventSource = block('EventSource');
      d.addEventListener('securitypolicyviolation', event => {
        // Chromium's native XML parse-error document uses inline styles, not network resources.
        if (event.violatedDirective !== 'style-src-attr') violations.push(event.violatedDirective);
      });
      const resourceCount = w.performance.getEntriesByType('resource').length;
      const href = w.location.href, history = w.history.length, storage = [w.localStorage.length, w.sessionStorage.length];
      const choose = (id, content, name) => {
        const transfer = new w.DataTransfer();
        transfer.items.add(new w.File([content], name));
        $(id).files = transfer.files;
      };
      const localXML = xml.replace('Catalog Fixture', '&lt;img src=&quot;https://example.invalid/private-marker&quot;&gt;');
      $('open-local').click();
      choose('catalog-file', localXML, 'local-private-marker.4DCatalog');
      choose('editor-file', '{"tables":{"Clients":{"coordinates":{"left":900,"top":200}}}}', 'catalog_editor.json');
      $('local-form').requestSubmit();
      await until(() => !$('local-dialog').open);
      assert($('summary').textContent.includes('LOCAL FILE / not uploaded'));
      assert($('summary').textContent.includes('<img src='));
      assert(!d.querySelector('img') && !d.querySelector('a[href*="private-marker"]'));
      equal($('tables').children.length, 2);
      assert(!$('use-demo').hidden);
      $('open-local').click();
      choose('catalog-file', '<base><broken></base>', 'bad.4DCatalog');
      $('local-form').requestSubmit();
      await until(() => !$('local-error').hidden);
      equal($('tables').children.length, 2);
      $('cancel-local').click();
      $('open-local').click();
      choose('catalog-file', '<base><table name="New"/><table/></base>', 'notes.4DCatalog');
      $('local-form').requestSubmit();
      await until(() => !$('local-dialog').open);
      assert(!$('local-notes').hidden && $('notices').open, 'parser notes must be prominent');
      const readBuffer = w.File.prototype.arrayBuffer;
      let releaseRead;
      const reading = new Promise(resolve => { releaseRead = resolve; });
      try {
        w.File.prototype.arrayBuffer = async function() { await reading; return readBuffer.call(this); };
        $('open-local').click();
        choose('catalog-file', '<base name="Canceled import"/>', 'late.4DCatalog');
        $('local-form').requestSubmit();
        assert($('load-local').disabled);
        $('local-dialog').dispatchEvent(new w.Event('cancel', {cancelable: true}));
        $('use-demo').click();
        releaseRead();
        await wait(100);
        assert($('summary').textContent.includes('synthetic sample only'), 'canceled reads must not replace the scene later');
      } finally { releaseRead(); w.File.prototype.arrayBuffer = readBuffer; }
      equal($('tables').children.length, 12);
      assert($('summary').textContent.includes('synthetic sample only'));
      await wait(100);
      equal(requests, []);
      equal(violations, []);
      equal(w.performance.getEntriesByType('resource').length, resourceCount);
      equal(w.location.href, href); equal(w.history.length, history);
      equal([w.localStorage.length, w.sessionStorage.length], storage);
      assert(d.querySelector('meta[http-equiv="Content-Security-Policy"]').content.includes("connect-src 'none'"));
    } finally { iframe.remove(); }
  });
  output.textContent += `${passed} checks passed.\n`;
  document.body.dataset.status = 'passed';
} catch (error) {
  output.textContent += `FAIL ${error.stack || error.message}\n`;
  document.body.dataset.status = 'failed';
}
