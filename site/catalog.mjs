const MIB = 1024 * 1024;
const children = (node, name) => [...node.children].filter(child => child.tagName === name);
const child = (node, name) => node && children(node, name)[0];
const attribute = (node, name) => node?.getAttribute(name) ?? undefined;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const decimal = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

function editorJSON(text) {
  const value = JSON.parse(text.replace(/^\uFEFF/, ''));
  const stack = [];
  let count = 0;
  // JSON.parse validates syntax; this pass also rejects duplicate keys and bounds structure.
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|null/gi)) {
    const top = stack.at(-1);
    if (token === '}' || token === ']') { stack.pop(); continue; }
    if (token === ',') { if (top?.keys) top.key = true; continue; }
    if (token === ':') { top.key = false; continue; }
    if (top?.key && token.startsWith('"')) {
      const key = JSON.parse(token);
      if (top.keys.has(key)) throw new Error('Duplicate JSON object key.');
      top.keys.add(key);
      continue;
    }
    if (stack.length > 64 || ++count > 100000) throw new Error('JSON exceeds depth 64 or 100,000 values.');
    if (token === '{') stack.push({keys: new Set(), key: true});
    else if (token === '[') stack.push({});
    else if (/^-?\d/.test(token) && !Number.isFinite(Number(token))) throw new Error('JSON contains a non-finite number.');
  }
  if (!object(value) || !object(value.tables)) throw new Error('Expected a JSON object containing a tables object.');
  return value.tables;
}

function lookup(identities) {
  const uuids = new Map(), names = new Map();
  const normalize = value => value.replaceAll('-', '').toUpperCase();
  const insert = (map, key, index) => {
    map.set(key, map.has(key) ? null : index);
  };
  identities.forEach((value, index) => {
    if (value.uuid) insert(uuids, normalize(value.uuid), index);
    if (value.name) insert(names, value.name, index);
  });
  return (uuid, name) => {
    if (uuid && uuids.has(normalize(uuid))) return uuids.get(normalize(uuid)) ?? undefined;
    return names.get(name) ?? undefined;
  };
}

export function parseCatalog(xml, {fileName = 'catalog.4DCatalog', fileSize = new TextEncoder().encode(xml).length,
  editorText} = {}) {
  if (fileSize > 32 * MIB) throw new Error('Catalog exceeds the 32 MiB limit.');
  const declarations = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE\b(?:[^>"']|"[^"]*"|'[^']*')*>|<!ENTITY\b/gi;
  for (const [token] of xml.matchAll(declarations)) {
    if (/^<!ENTITY\b/i.test(token) || (/^<!DOCTYPE\b/i.test(token)
      && token.replace(/"[^"]*"|'[^']*'/g, '').includes('['))) {
      throw new Error('Custom XML entities and internal DTD subsets are not supported.');
    }
  }
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.getElementsByTagNameNS('*', 'parsererror').length) {
    throw new Error('Malformed catalog XML. Check that the selected file is a valid catalog.4DCatalog.');
  }
  const root = document.documentElement;
  if (root?.tagName !== 'base') throw new Error('Expected a 4D XML catalog with a <base> root element.');
  const pending = [[root, 0]];
  let elements = 0;
  while (pending.length) {
    const [node, depth] = pending.pop();
    if (++elements > 200000 || depth >= 128) throw new Error('XML exceeds 200,000 elements or nesting depth 128.');
    for (const item of node.children) pending.push([item, depth + 1]);
  }

  const warnings = [];
  const warn = message => {
    if (warnings.length < 100) warnings.push(message);
    else if (warnings.length === 100) warnings.push('Further catalog warnings omitted.');
  };
  const boolean = (node, key, fallback = false) => {
    const value = attribute(node, key);
    if (value === undefined) return fallback;
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'no'].includes(normalized)) return false;
    warn(`Invalid ${key} attribute on <${node.tagName}>.`);
    return fallback;
  };
  const integer = (node, key) => {
    const value = attribute(node, key);
    if (value === undefined) return undefined;
    if (/^[+-]?\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value))) return Number(value);
    warn(`Invalid or unsafe ${key} attribute on <${node.tagName}>.`);
    return undefined;
  };
  const tables = [];
  for (const node of children(root, 'table')) {
    const name = attribute(node, 'name');
    if (!name) { warn('Skipped a table without a name.'); continue; }
    const fields = [];
    for (const field of children(node, 'field')) {
      const fieldName = attribute(field, 'name');
      if (!fieldName) { warn(`Skipped a field without a name in table ${name}.`); continue; }
      const type = integer(field, 'type');
      if (type === undefined) warn(`Unknown field type for [${name}]${fieldName}.`);
      const length = integer(field, 'limiting_length');
      if (length < 0) warn(`Ignored negative limiting length for [${name}]${fieldName}.`);
      fields.push({number: integer(field, 'id'), name: fieldName, uuid: attribute(field, 'uuid') ?? '',
        typeCode: type ?? -1, limitingLength: length > 0 ? length : undefined,
        unique: boolean(field, 'unique'), autoSequence: boolean(field, 'autosequence'),
        notNull: boolean(field, 'not_null') || boolean(field, 'never_null'),
        hidden: !boolean(child(field, 'field_extra'), 'visible', true), primaryKey: false,
        indexUUIDs: children(field, 'index_ref').map(ref => attribute(ref, 'uuid')).filter(value => value !== undefined)});
    }
    const findField = lookup(fields);
    for (const key of children(node, 'primary_key')) {
      const index = findField(attribute(key, 'field_uuid'), attribute(key, 'field_name'));
      if (index !== undefined) fields[index].primaryKey = true;
      else warn(`Unresolved primary key in table ${name}.`);
    }
    const extra = child(node, 'table_extra');
    const coordinates = child(child(extra, 'editor_table_info'), 'coordinates');
    let position;
    if (coordinates) {
      const x = decimal(attribute(coordinates, 'left')), y = decimal(attribute(coordinates, 'top'));
      if (x !== undefined && y !== undefined) position = {x, y};
      else warn(`Ignored invalid editor coordinates for table ${name}.`);
    }
    tables.push({number: integer(node, 'id'), name, uuid: attribute(node, 'uuid') ?? '', fields,
      encryptable: boolean(node, 'encryptable'), hidden: !boolean(extra, 'visible', true), position});
  }

  if (editorText !== undefined) {
    if (new TextEncoder().encode(editorText).length > 4 * MIB) throw new Error('catalog_editor.json exceeds the 4 MiB limit.');
    let layouts;
    try { layouts = new Map(Object.entries(editorJSON(editorText))); }
    catch (error) { throw new Error(`Could not read catalog_editor.json: ${error.message}`); }
    const counts = new Map();
    for (const table of tables) counts.set(table.name, (counts.get(table.name) ?? 0) + 1);
    for (const table of tables) {
      if (!layouts.has(table.name)) continue;
      const value = layouts.get(table.name);
      if (counts.get(table.name) !== 1) { warn(`Ignored ambiguous editor layout for table ${table.name}.`); continue; }
      if (!object(value)) { warn(`Ignored invalid editor layout for table ${table.name}.`); continue; }
      if (!Object.hasOwn(value, 'coordinates')) continue;
      const x = decimal(object(value.coordinates) ? value.coordinates.left : undefined);
      const y = decimal(object(value.coordinates) ? value.coordinates.top : undefined);
      if (x === undefined || y === undefined) { warn(`Ignored invalid editor coordinates in catalog_editor.json for table ${table.name}.`); continue; }
      table.position = {x, y};
    }
  }

  const findTable = lookup(tables), findFields = tables.map(table => lookup(table.fields));
  const endpoint = (node, kind) => {
    const related = children(node, 'related_field').find(ref => attribute(ref, 'kind') === kind);
    const field = child(related, 'field_ref'), table = child(field, 'table_ref');
    if (!table) return undefined;
    const result = {tableName: attribute(table, 'name') ?? '', tableUUID: attribute(table, 'uuid') ?? '',
      fieldName: attribute(field, 'name') ?? '', fieldUUID: attribute(field, 'uuid') ?? ''};
    result.tableIndex = findTable(result.tableUUID, result.tableName);
    if (result.tableIndex !== undefined) {
      const resolved = tables[result.tableIndex];
      result.tableName = resolved.name;
      result.fieldIndex = findFields[result.tableIndex](result.fieldUUID, result.fieldName);
      if (result.fieldIndex !== undefined) result.fieldName = resolved.fields[result.fieldIndex].name;
    }
    if (result.tableIndex === undefined || result.fieldIndex === undefined) {
      warn(`Unresolved relation ${kind}: [${result.tableName}]${result.fieldName}.`);
    }
    return result;
  };
  const relations = [];
  for (const node of children(root, 'relation')) {
    const source = endpoint(node, 'source'), destination = endpoint(node, 'destination');
    if (!source || !destination) { warn('Skipped a relation with missing source or destination references.'); continue; }
    relations.push({uuid: attribute(node, 'uuid') ?? '', name: attribute(node, 'name_Nto1') ?? '',
      inverseName: attribute(node, 'name_1toN') ?? '', source, destination,
      autoLoadManyToOne: boolean(node, 'auto_load_Nto1'), autoLoadOneToMany: boolean(node, 'auto_load_1toN'),
      foreignKey: boolean(node, 'foreign_key'), integrity: attribute(node, 'integrity')});
  }
  return {kind: 'catalog.structure', fileName, fileSize, name: attribute(root, 'name') ?? '',
    databaseUUID: attribute(root, 'uuid') ?? '', collationLocale: attribute(root, 'collation_locale'),
    schemas: children(root, 'schema').map(schema => attribute(schema, 'name')).filter(value => value !== undefined),
    tables, relations, indexCount: children(root, 'index').length, warnings};
}

function decodeXML(buffer) {
  const bytes = new Uint8Array(buffer);
  if ((bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0 && bytes[3] === 0)
    || (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0xfe && bytes[3] === 0xff)) {
    throw new Error('UTF-32 catalogs are not supported. Use UTF-8 or UTF-16.');
  }
  let encoding;
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)) encoding = 'utf-16le';
  else if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)) encoding = 'utf-16be';
  else {
    const declaration = new TextDecoder('windows-1252').decode(bytes.subarray(0, 512));
    encoding = declaration.match(/^\s*(?:\uFEFF)?<\?xml\s[^?]*encoding\s*=\s*['"]([^'"]+)['"]/i)?.[1] ?? 'utf-8';
  }
  return new TextDecoder(encoding, {fatal: true}).decode(bytes);
}

export async function readCatalogFiles(catalog, editor = null) {
  if (!catalog || !/\.4dcatalog$/i.test(catalog.name)) throw new Error('Select an XML catalog.4DCatalog file, not a binary .4DB/.4DD file.');
  if (catalog.size > 32 * MIB) throw new Error('Catalog exceeds the 32 MiB limit.');
  if (editor && editor.name.toLowerCase() !== 'catalog_editor.json') throw new Error('The optional layout file must be named catalog_editor.json.');
  if (editor && editor.size > 4 * MIB) throw new Error('catalog_editor.json exceeds the 4 MiB limit.');
  let xml, editorText;
  try { xml = decodeXML(await catalog.arrayBuffer()); }
  catch (error) { throw new Error(`Could not read the catalog encoding or file: ${error.message}`); }
  if (editor) {
    try { editorText = new TextDecoder('utf-8', {fatal: true}).decode(await editor.arrayBuffer()); }
    catch (error) { throw new Error(`Could not read catalog_editor.json as UTF-8: ${error.message}`); }
  }
  return parseCatalog(xml, {fileName: catalog.name, fileSize: catalog.size, editorText});
}
