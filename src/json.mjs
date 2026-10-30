import { createHash } from 'node:crypto';
import { validateSupportedSchema } from './schema.mjs';
export { SCHEMA_KEYWORDS } from './schema.mjs';

export const LIMITS = Object.freeze({ bodyBytes: 65536, depth: 16, nodes: 4096, arrayLength: 1024, schemaBytes: 32768, schemaNodes: 128 });
export class MoteError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

// Reject duplicate decoded object keys before they can silently overwrite data.
// JSON.parse checks grammar; the bounded scan checks ambiguity and nesting.
export function parseJson(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new MoteError('INVALID_JSON', 'Malformed JSON.'); }
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++; };
  const string = () => {
    const start = cursor++;
    while (text[cursor] !== '"') { cursor += text[cursor] === '\\' ? 2 : 1; }
    cursor++;
    return JSON.parse(text.slice(start, cursor));
  };
  const scan = (depth) => {
    if (depth > LIMITS.depth + 3) throw new MoteError('RESOURCE_LIMIT', 'JSON exceeds nesting limit.');
    whitespace();
    if (text[cursor] === '"') { string(); return; }
    if (text[cursor] === '{') {
      cursor++; whitespace();
      const keys = new Set();
      if (text[cursor] !== '}') for (;;) {
        whitespace(); const key = string();
        if (keys.has(key)) throw new MoteError('DUPLICATE_KEY', 'Duplicate JSON object keys are rejected.');
        keys.add(key); whitespace(); cursor++; scan(depth + 1); whitespace();
        if (text[cursor] !== ',') break;
        cursor++;
      }
      cursor++; return;
    }
    if (text[cursor] === '[') {
      cursor++; whitespace();
      if (text[cursor] !== ']') for (;;) {
        scan(depth + 1); whitespace();
        if (text[cursor] !== ',') break;
        cursor++;
      }
      cursor++; return;
    }
    while (cursor < text.length && !/[\s,\]}]/.test(text[cursor])) cursor++;
  };
  scan(0);
  return value;
}

export function boundedJson(value, { maxNodes = LIMITS.nodes, maxDepth = LIMITS.depth } = {}) {
  const pending = [[value, 0]];
  let count = 0;
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (++count > maxNodes || depth > maxDepth) throw new MoteError('RESOURCE_LIMIT', 'JSON exceeds node or depth limit.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number' && Number.isFinite(item)) {
      if (Number.isInteger(item) && !Number.isSafeInteger(item)) throw new MoteError('UNSAFE_NUMBER', 'Integer values must be within the JavaScript safe integer range; encode larger integers as strings.');
      continue;
    }
    if (typeof item !== 'object' || (Object.getPrototypeOf(item) !== Object.prototype && !Array.isArray(item) && Object.getPrototypeOf(item) !== null)) {
      throw new MoteError('INVALID_JSON', 'Only finite JSON values are accepted.');
    }
    if (Array.isArray(item) && item.length > LIMITS.arrayLength) throw new MoteError('RESOURCE_LIMIT', 'Arrays may contain at most 1024 elements.');
    for (const child of Object.values(item)) pending.push([child, depth + 1]);
  }
  return count;
}

// Sorted UTF-16 object keys and ECMAScript JSON number/string encoding.
// This is the Mote v1 representation; it is not advertised as RFC 8785 conformance.
export function canonicalStringify(value) {
  boundedJson(value);
  const render = (item) => item === null || typeof item !== 'object' ? JSON.stringify(item)
    : Array.isArray(item) ? `[${item.map(render).join(',')}]`
      : `{${Object.keys(item).sort().map((key) => `${JSON.stringify(key)}:${render(item[key])}`).join(',')}}`;
  return render(value);
}
export const hashText = (value) => `0x${createHash('sha256').update(value, 'utf8').digest('hex')}`;
export const hashJson = (value) => hashText(canonicalStringify(value));
// Validate the actual input once; the protocol wrapper must not reduce its
// advertised depth/node allowance by adding bookkeeping fields.
export const requestHash = (input) => hashText(`{"input":${canonicalStringify(input)},"service":"json.audit","version":1}`);

export function prepareAudit(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(input, 'document') || Object.keys(input).some((key) => !['document', 'schema'].includes(key))) {
    throw new MoteError('INVALID_INPUT', 'Provide {document, schema?}; no other input fields are accepted.');
  }
  const nodes = boundedJson(input);
  const serialized = canonicalStringify(input);
  const inputBytes = Buffer.byteLength(serialized);
  if (inputBytes > LIMITS.bodyBytes - 256) throw new MoteError('RESOURCE_LIMIT', 'Input exceeds byte limit.');
  let valid = true;
  let errors = [];
  if (Object.hasOwn(input, 'schema')) {
    if (Buffer.byteLength(canonicalStringify(input.schema)) > LIMITS.schemaBytes) throw new MoteError('SCHEMA_LIMIT', 'Schema exceeds byte limit.');
    try {
      ({ valid, errors } = validateSupportedSchema(input.schema, input.document));
    } catch (error) {
      throw new MoteError(error.code ?? 'INVALID_SCHEMA', error.code ? error.message : 'Schema is invalid for the supported draft-07 subset.');
    }
  }
  const canonicalJson = canonicalStringify(input.document);
  const result = { service: 'json.audit', version: 1, dialect: 'mote-draft-07-subset-v1', canonicalization: 'mote-sorted-json-v1', digestAlgorithm: 'sha-256', valid, errors, canonicalJson, sha256: hashText(canonicalJson), bytes: Buffer.byteLength(canonicalJson), inputNodes: nodes };
  return { result, resultHash: hashJson(result), requestHash: requestHash(input), inputBytes, amount: String(1000 + 10 * inputBytes) };
}
