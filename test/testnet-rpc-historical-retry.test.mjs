import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEthereumSepoliaReader, HISTORICAL_STATE_ATTEMPTS } from '../src/testnet-rpc.mjs';

// Exact reply observed from https://ethereum-sepolia-rpc.publicnode.com on 2026-10-31.
const MISS = { code: -32000, message: 'historical state 1d07ddca2344132cc6338e2c3d413f50e7aa401322e241e1caa4d4e55ef2e2ca is not available' };
const TOKEN = '0x990e43c6fed3f5a380c9a6ccd5e14878c4885564';
const SIX = '0x' + '0'.repeat(63) + '6';

function scripted(replies) {
  const seen = [];
  const reader = createEthereumSepoliaReader({ fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body); seen.push({ url, request });
    const next = replies[Math.min(seen.length - 1, replies.length - 1)];
    return Response.json({ jsonrpc: '2.0', id: request.id, ...next });
  } });
  return { reader, seen };
}

test('a numbered-block state read re-asks the same endpoint only for the exact historical-state miss', async () => {
  const { reader, seen } = scripted([{ error: MISS }, { error: MISS }, { result: SIX }]);
  assert.equal(await reader.send('eth_call', [{ to: TOKEN, data: '0x313ce567' }, '0xb79e5b']), SIX);
  assert.equal(seen.length, 3);
  assert.ok(seen.every(({ url, request }) => url === reader.endpoint && request.method === 'eth_call'
    && JSON.stringify(request.params) === JSON.stringify(seen[0].request.params)), 'same endpoint, method and params on every attempt');
  assert.equal(new Set(seen.map(({ request }) => request.id)).size, 3, 'each attempt carries its own matching RPC id');
});

test('a persistent miss fails closed after the bounded attempts with the original error', async () => {
  const { reader, seen } = scripted([{ error: MISS }]);
  await assert.rejects(reader.send('eth_getCode', ['0x73726b075180bc8e62d271566fb46638cddffdc2', '0xb79e5a']),
    { code: 'RPC_REMOTE_ERROR', rpcCode: -32000, rpcMessage: MISS.message });
  assert.equal(seen.length, HISTORICAL_STATE_ATTEMPTS);
});

test('other errors, other codes, head tags, history reads and pruned history are never retried', async () => {
  const cases = [
    ['eth_getCode', [TOKEN, '0xb79e5b'], { code: -32000, message: 'header not found' }],
    ['eth_getCode', [TOKEN, '0xb79e5b'], { code: -32000, message: 'missing trie node 1d07ddca2344132cc6338e2c3d413f50e7aa401322e241e1caa4d4e55ef2e2ca' }],
    ['eth_getCode', [TOKEN, '0xb79e5b'], { code: 4444, message: 'pruned history unavailable: requested 12033627, earliest available 12043700' }],
    ['eth_getCode', [TOKEN, '0xb79e5b'], { code: -32001, message: MISS.message }],
    ['eth_getCode', [TOKEN, '0xb79e5b'], { code: -32000, message: MISS.message + ' ' }],
    ['eth_getCode', [TOKEN, 'finalized'], MISS],
    ['eth_getBalance', [TOKEN, 'latest'], MISS],
    ['eth_getBlockByNumber', ['0xb79e5b', false], MISS],
    ['eth_getTransactionReceipt', ['0x' + '11'.repeat(32)], MISS],
  ];
  for (const [method, params, error] of cases) {
    const { reader, seen } = scripted([{ error }]);
    await assert.rejects(reader.send(method, params), { code: 'RPC_REMOTE_ERROR' });
    assert.equal(seen.length, 1, `${method} ${params[1] ?? ''} ${error.code} ${error.message.slice(0, 30)} must not retry`);
  }
});

test('validation still rejects before any fetch, so a denied request is never retried', async () => {
  const { reader, seen } = scripted([{ error: MISS }]);
  await assert.rejects(reader.send('eth_sendRawTransaction', ['0x00']), { code: 'RPC_METHOD_DENIED' });
  await assert.rejects(reader.send('eth_getCode', [TOKEN, 'earliest']), { code: 'RPC_PARAMS_INVALID' });
  assert.equal(seen.length, 0);
});

test('caller mutation cannot change later retry calldata or block', async () => {
 const params=[{to:TOKEN,data:'0x313ce567'},'0xb79e5b'], seen=[];
 const reader=createEthereumSepoliaReader({fetchImpl:async(url,options)=>{
  const request=JSON.parse(options.body);seen.push(request);
  if(seen.length===1){params[0].to='0x'+'11'.repeat(20);params[0].data='0x';params[1]='latest';}
  return Response.json({jsonrpc:'2.0',id:request.id,...(seen.length===1?{error:MISS}:{result:SIX})});
 }});
 assert.equal(await reader.send('eth_call',params),SIX);assert.deepEqual(seen[0].params,seen[1].params);
 assert.equal(seen[1].params[1],'0xb79e5b');assert.equal(seen[1].params[0].data,'0x313ce567');
});
test('Base Sepolia behavior retains no historical-state retries',async()=>{
 const {createBaseSepoliaReader}=await import('../src/testnet-rpc.mjs');let count=0;
 const reader=createBaseSepoliaReader({fetchImpl:async(_url,options)=>{count++;const r=JSON.parse(options.body);return Response.json({jsonrpc:'2.0',id:r.id,error:MISS});}});
 await assert.rejects(reader.send('eth_getCode',[TOKEN,'0xb79e5b']),{code:'RPC_REMOTE_ERROR'});assert.equal(count,1);
});
test('total historical retry deadline fails closed before another delay or request',async t=>{
 const {HISTORICAL_STATE_TOTAL_MS}=await import('../src/testnet-rpc.mjs');let clock=0,count=0;
 t.mock.method(performance,'now',()=>clock);
 const reader=createEthereumSepoliaReader({fetchImpl:async(_url,options)=>{count++;clock=HISTORICAL_STATE_TOTAL_MS+1;const r=JSON.parse(options.body);return Response.json({jsonrpc:'2.0',id:r.id,error:MISS});}});
 await assert.rejects(reader.send('eth_getCode',[TOKEN,'0xb79e5b']),{code:'RPC_TIMEOUT'});assert.equal(count,1);
});
test('a standalone client survives its pending retry without unrelated open handles',async()=>{
 const {spawnSync}=await import('node:child_process');const moduleUrl=new URL('../src/testnet-rpc.mjs',import.meta.url).href;
 const code=`import {createEthereumSepoliaReader} from ${JSON.stringify(moduleUrl)};let n=0;const reader=createEthereumSepoliaReader({fetchImpl:async(_u,o)=>{const r=JSON.parse(o.body);return Response.json({jsonrpc:'2.0',id:r.id,...(++n===1?{error:${JSON.stringify(MISS)}}:{result:'0x'})});}});if(await reader.send('eth_getCode',[${JSON.stringify(TOKEN)},'0xb79e5b'])!=='0x'||n!==2)throw Error('retry');process.stdout.write('completed');`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:5000});assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'completed');
});

test('a valid but late success cannot win over the total deadline',async t=>{
 const {HISTORICAL_STATE_TOTAL_MS}=await import('../src/testnet-rpc.mjs');let clock=0,count=0;
 t.mock.method(performance,'now',()=>clock);
 const reader=createEthereumSepoliaReader({fetchImpl:async(_url,options)=>{count++;clock=HISTORICAL_STATE_TOTAL_MS+1;const r=JSON.parse(options.body);return Response.json({jsonrpc:'2.0',id:r.id,result:SIX});}});
 await assert.rejects(reader.send('eth_call',[{to:TOKEN,data:'0x313ce567'},'0xb79e5b']),{code:'RPC_TIMEOUT'});assert.equal(count,1);
});
