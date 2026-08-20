const INERT_KEYWORDS = Object.freeze(['$id', 'title', 'description', 'version']);
const VALIDATION_KEYWORDS = Object.freeze([
  'type',
  'required',
  'properties',
  'items',
  'enum',
  'const',
  'additionalProperties',
]);
const SUPPORTED_KEYWORDS = new Set([...INERT_KEYWORDS, ...VALIDATION_KEYWORDS]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function childPath(parent, key) {
  return parent === '$' ? key : `${parent}.${key}`;
}

function itemPath(parent, index) {
  return parent === '$' ? `[${index}]` : `${parent}[${index}]`;
}

function typeMatches(type, value) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validate(schema, value, path, errors) {
  if (!isPlainObject(schema)) {
    errors.push(`${path}: schema must be an object`);
    return;
  }

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) errors.push(`${path}: unsupported keyword "${keyword}"`);
  }

  if (Object.hasOwn(schema, 'type')) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(type, value))) {
      errors.push(`${path}: expected type ${types.join(' or ')}`);
      return;
    }
  }

  if (Object.hasOwn(schema, 'enum') && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${path}: value is not in enum`);
  }
  if (Object.hasOwn(schema, 'const') && !Object.is(schema.const, value)) {
    errors.push(`${path}: value does not equal const`);
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (!Object.hasOwn(value, key)) errors.push(`${childPath(path, key)}: required property is missing`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validate(childSchema, value[key], childPath(path, key), errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) errors.push(`${childPath(path, key)}: additional property is not allowed`);
      }
    }
  }

  if (Array.isArray(value) && Object.hasOwn(schema, 'items')) {
    for (let index = 0; index < value.length; index += 1) {
      validate(schema.items, value[index], itemPath(path, index), errors);
    }
  }
}

export function checkSchema(schema, value) {
  const errors = [];
  validate(schema, value, '$', errors);
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}
