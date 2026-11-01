import { encodeBuilderCodeSuffix } from '@x402/extensions/builder-code';
import { assert } from './protocol.mjs';

export const ATTRIBUTION_LIMITS = Object.freeze({ bytes: 1024, nodes: 128, depth: 5, textBytes: 256, collection: 16, serviceCodes: 11 });
const MARKER = '80218021802180218021802180218021';
const code = s => typeof s === 'string' && /^[a-z0-9_]{1,32}$/.test(s);
const map = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// Decode only the bounded subset used by x402 Schema2. No tags/byte strings/floats/indefinite items.
function decode(bytes) {
  let offset = 0; let nodes = 0;
  const read = n => { assert(offset + n <= bytes.length, 'ATTRIBUTION_TRUNCATED'); const out = bytes.subarray(offset, offset+n); offset += n; return out; };
  function item(depth = 0) {
    assert(++nodes <= ATTRIBUTION_LIMITS.nodes && depth <= ATTRIBUTION_LIMITS.depth, 'ATTRIBUTION_LIMIT');
    const head = read(1)[0], major = head >> 5, info = head & 31;
    assert([0,3,4,5].includes(major) && info <= 27, 'ATTRIBUTION_TYPE');
    let size = BigInt(info);
    if (info >= 24) {
      const width = 2 ** (info-24); const raw = read(width); size = 0n;
      for (const b of raw) size = (size << 8n) | BigInt(b);
      assert(size >= [24n,256n,65536n,4294967296n][info-24], 'ATTRIBUTION_NONCANONICAL');
    }
    if (major === 0) return size;
    if (major === 3) {
      assert(size <= BigInt(ATTRIBUTION_LIMITS.textBytes), 'ATTRIBUTION_LIMIT');
      return new TextDecoder('utf-8', { fatal: true }).decode(read(Number(size)));
    }
    assert(size <= BigInt(ATTRIBUTION_LIMITS.collection), 'ATTRIBUTION_LIMIT');
    if (major === 4) return Array.from({length:Number(size)}, () => item(depth+1));
    const value = Object.create(null);
    for (let i=0;i<Number(size);i++) { const key = item(depth+1); assert(typeof key === 'string' && !Object.hasOwn(value,key), 'ATTRIBUTION_DUPLICATE_KEY'); value[key] = item(depth+1); }
    return value;
  }
  const result = item(); assert(offset === bytes.length, 'ATTRIBUTION_TRAILING'); return result;
}
export function validateTransferCalldata(actual, expected) {
  assert(typeof actual === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(actual) && actual.length <= expected.length + 2*(ATTRIBUTION_LIMITS.bytes+19), 'UNSUPPORTED_TRANSFER_CALL');
  assert(actual.slice(0,expected.length).toLowerCase() === expected.toLowerCase(), 'UNSUPPORTED_TRANSFER_CALL');
  if (actual.length === expected.length) return null;
  const suffix = actual.slice(expected.length).toLowerCase();
  assert(suffix.length >= 40 && suffix.endsWith(MARKER) && suffix.slice(-34,-32) === '02', 'ATTRIBUTION_FORMAT');
  const length = Number.parseInt(suffix.slice(-38,-34),16);
  assert(length > 0 && length <= ATTRIBUTION_LIMITS.bytes && suffix.length === 2*(length+19), 'ATTRIBUTION_LENGTH');
  const data = decode(Buffer.from(suffix.slice(0,length*2),'hex'));
  assert(map(data) && Object.keys(data).length > 0 && Object.keys(data).every(k => ['a','w','s','m'].includes(k)), 'ATTRIBUTION_FIELDS');
  for (const k of ['a','w']) if (Object.hasOwn(data,k)) assert(code(data[k]), 'ATTRIBUTION_CODE');
  if (Object.hasOwn(data,'s')) assert(Array.isArray(data.s) && data.s.length > 0 && data.s.length <= ATTRIBUTION_LIMITS.serviceCodes && data.s.every(code) && new Set(data.s).size === data.s.length, 'ATTRIBUTION_SERVICES');
  if (Object.hasOwn(data,'m')) assert(map(data.m) && Object.keys(data.m).every(k=>k.startsWith('x402')), 'ATTRIBUTION_METADATA');
  // Official pinned encoder establishes exact top-level a,w,s,m order and deterministic nested maps.
  assert(encodeBuilderCodeSuffix(data).toLowerCase() === '0x'+suffix, 'ATTRIBUTION_NONCANONICAL');
  // Attribution is untrusted annotation, never an authority or pricing input.
  return { schema: 2, bytes: length, fields: Object.keys(data) };
}
