import { Validator, deepCompareStrict } from '@cfworker/json-schema';

export const SCHEMA_KEYWORDS = Object.freeze([
  '$schema', 'title', 'description', 'type', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties',
]);
const TYPES = new Set(['array', 'boolean', 'integer', 'null', 'number', 'object', 'string']);
const COUNTS = new Set(['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties']);
const NUMBERS = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (message, code = 'INVALID_SCHEMA') => { throw Object.assign(new Error(message), { code }); };

function checkSchema(schema, state = { count: 0 }) {
  if (++state.count > 128) fail('Schema exceeds 128 subschemas.', 'SCHEMA_LIMIT');
  if (typeof schema === 'boolean') return;
  if (!isObject(schema)) fail('Expected a schema object or boolean.');
  for (const [key, value] of Object.entries(schema)) {
    if (!SCHEMA_KEYWORDS.includes(key)) fail(`Unsupported schema keyword: ${key}`, 'UNSUPPORTED_SCHEMA');
    if (key === '$schema' && value !== 'http://json-schema.org/draft-07/schema#') fail('Only the bounded draft-07 subset is supported.', 'UNSUPPORTED_SCHEMA');
    if (['title', 'description'].includes(key) && typeof value !== 'string') fail(`${key} must be a string.`);
    if (key === 'type') {
      const types = Array.isArray(value) ? value : [value];
      if (!types.length || types.some((type) => !TYPES.has(type)) || new Set(types).size !== types.length) fail('type must contain unique supported JSON Schema types.');
    }
    if (COUNTS.has(key) && (!Number.isSafeInteger(value) || value < 0)) fail(`${key} must be a nonnegative safe integer.`);
    if (NUMBERS.has(key) && (typeof value !== 'number' || !Number.isFinite(value) || (key === 'multipleOf' && value <= 0))) fail(`${key} must be a finite number${key === 'multipleOf' ? ' greater than zero' : ''}.`);
    if (key === 'required' && (!Array.isArray(value) || value.some((item) => typeof item !== 'string') || new Set(value).size !== value.length)) fail('required must contain unique strings.');
    if (key === 'enum' && (!Array.isArray(value) || !value.length)) fail('enum must be a nonempty array.');
    if (key === 'enum' && value.some((item, index) => value.slice(index + 1).some((other) => deepCompareStrict(item, other)))) fail('enum values must be unique.');
    if (key === 'uniqueItems' && typeof value !== 'boolean') fail('uniqueItems must be boolean.');
    if (key === 'properties') {
      if (!isObject(value)) fail('properties must be an object.');
      for (const child of Object.values(value)) checkSchema(child, state);
    }
    if (key === 'items' || key === 'additionalProperties') checkSchema(value, state);
  }
}

// Required/properties checks must see only JSON's own properties, never Object.prototype.
function plainData(value) {
  if (Array.isArray(value)) return value.map(plainData);
  if (!isObject(value)) return value;
  const copy = Object.create(null);
  for (const [key, child] of Object.entries(value)) copy[key] = plainData(child);
  return copy;
}
function atPointer(value, pointer) {
  if (pointer === '#') return value;
  for (const key of pointer.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
const instanceType = (value) => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const escapePointer = (value) => value.replace(/~/g, '~0').replace(/\//g, '~1');
function expectedSummary(value) {
  const text = JSON.stringify(value);
  return text && text.length > 512 ? { summary: 'constraint too large to echo', bytes: new TextEncoder().encode(text).length } : value;
}

/** Bounded, no-eval draft-07 subset. No fetching, refs, regex, formats, or coercion. */
export function validateSupportedSchema(schema, document) {
  checkSchema(schema);
  const validation = new Validator(plainData(schema), '7', true).validate(plainData(document));
  if (validation.valid) return { valid: true, errors: [] };
  const error = validation.errors.at(-1);
  let path = error.instanceLocation.slice(1);
  let observed = atPointer(document, error.instanceLocation);
  const expected = atPointer(schema, error.keywordLocation);
  if (error.keyword === 'required' && Array.isArray(expected) && isObject(observed)) {
    const missing = expected.filter((key) => !Object.hasOwn(observed, key)).at(-1);
    if (missing !== undefined) { path += `/${escapePointer(missing)}`; observed = undefined; }
  }
  return { valid: false, errors: [{ instancePath: path, keyword: error.keyword, message: error.error, expected: expectedSummary(expected) ?? false, observedType: instanceType(observed) }] };
}
