import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { PUBLIC_ORIGIN, publicApiOrigin } from './mcp-public.mjs';

const projectDir = fileURLToPath(new URL('..', import.meta.url));
const bridgeScript = fileURLToPath(new URL('./mcp-public.mjs', import.meta.url));
const schema = { type: 'object', required: ['count'], properties: { count: { type: 'integer', minimum: 0 } }, additionalProperties: false };

// A controlled synthetic smoke test, never an adoption or financial-settlement claim.
export async function evaluatePublicMcp({ fixtureOrigin } = {}) {
  const startedAt = new Date().toISOString();
  const origin = fixtureOrigin === undefined ? PUBLIC_ORIGIN : publicApiOrigin(fixtureOrigin, { fixtureMode: true });
  const client = new Client({ name: 'mote-controlled-public-smoke', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: { pin: '2026-07-28' } } });
  const transport = new StdioClientTransport({ command: process.execPath, args: [bridgeScript, ...(fixtureOrigin === undefined ? [] : ['--test-loopback-origin', origin])], cwd: projectDir, stderr: 'pipe', maxBufferSize: 1048576 });
  // Drain diagnostics but do not persist host-specific stderr in portable evidence.
  transport.stderr?.on('data', () => {});
  const methods = [];
  const send = transport.send.bind(transport);
  transport.send = async message => { if (typeof message.method === 'string') methods.push(message.method); return send(message); };
  const checks = [];
  const check = (name, assertion) => { assertion(); checks.push({ name, passed: true }); };
  let tools = [];
  let validSummary;
  let invalidSummary;
  let failure;
  let negotiatedProtocol;
  let server;
  try {
    await client.connect(transport, { timeout: 15000 });
    // The SDK can use a disposable sibling process for its connection probe;
    // explicitly exercise discovery on the retained transport too.
    await client.discover({ timeout: 15000 });
    negotiatedProtocol = client.getNegotiatedProtocolVersion();
    server = client.getServerVersion();
    check('official client negotiated modern stdio', () => {
      assert.equal(client.getProtocolEra(), 'modern');
      assert.equal(negotiatedProtocol, '2026-07-28');
      assert(methods.includes('server/discover'));
    });
    const listed = await client.listTools({}, { timeout: 15000 });
    tools = listed.tools.map(tool => tool.name).sort();
    check('only discovery and audit tools', () => assert.deepEqual(tools, ['mote_public_audit', 'mote_public_discover']));
    const discovery = await client.callTool({ name: 'mote_public_discover', arguments: {} }, { timeout: 15000 });
    check('anonymous free discovery and health', () => {
      assert.notEqual(discovery.isError, true, JSON.stringify(discovery));
      assert.equal(discovery.structuredContent.origin, origin);
      assert.equal(discovery.structuredContent.manifest.status, 200);
      assert.equal(discovery.structuredContent.health.status, 200);
      assert.equal(discovery.structuredContent.manifest.data.payment.required, false);
      assert.equal(discovery.structuredContent.health.data.paymentRequired, false);
    });
    const valid = await client.callTool({ name: 'mote_public_audit', arguments: { document: { count: 7 }, schema } }, { timeout: 15000 });
    check('synthetic valid audit', () => {
      assert.notEqual(valid.isError, true, JSON.stringify(valid));
      assert.equal(valid.structuredContent.status, 200);
      assert.equal(valid.structuredContent.data.result.valid, true);
      assert.equal(valid.structuredContent.data.result.canonicalJson, '{"count":7}');
      assert.equal(valid.structuredContent.data.receipt.amount, '0');
      assert.equal(valid.structuredContent.data.receipt.settlement, 'none');
      assert.equal(valid.structuredContent.data.receipt.signature, null);
    });
    validSummary = { valid: valid.structuredContent.data.result.valid, sha256: valid.structuredContent.data.result.sha256, receipt: valid.structuredContent.data.receipt };
    const invalid = await client.callTool({ name: 'mote_public_audit', arguments: { document: { count: 'wrong' }, schema } }, { timeout: 15000 });
    check('synthetic invalid audit reports count type', () => {
      assert.notEqual(invalid.isError, true, JSON.stringify(invalid));
      assert.equal(invalid.structuredContent.status, 200);
      assert.equal(invalid.structuredContent.data.result.valid, false);
      assert.equal(invalid.structuredContent.data.result.errors[0].instancePath, '/count');
      assert.equal(invalid.structuredContent.data.result.errors[0].keyword, 'type');
      assert.equal(invalid.structuredContent.data.receipt.amount, '0');
      assert.equal(invalid.structuredContent.data.receipt.settlement, 'none');
    });
    invalidSummary = { valid: invalid.structuredContent.data.result.valid, errors: invalid.structuredContent.data.result.errors, receipt: invalid.structuredContent.data.receipt };
  } catch (error) {
    failure = { name: error.name, message: error.message };
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
  return {
    evaluation: 'mote-public-stdio-official-client-v1', startedAt, finishedAt: new Date().toISOString(),
    passed: !failure && checks.length === 5, controlledTraffic: true, externalAdoptionClaim: false,
    destination: origin, fixtureMode: fixtureOrigin !== undefined, sdk: { client: '@modelcontextprotocol/client@2.4.0', server: '@modelcontextprotocol/server@2.4.0' }, nodeVersion: process.version,
    negotiatedProtocol, server, methods, tools, checks, validSummary, invalidSummary,
    expectedHttpRequestsOnSuccess: 4, hostedMcpRouteUsed: false, credentialsUsed: false, paymentPerformed: false,
    ...(failure ? { failure } : {}),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let evidencePath;
    let fixtureOrigin;
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index += 2) {
      const [flag, value] = args.slice(index, index + 2);
      if (!value || value.startsWith('--')) throw new Error('Usage: node scripts/evaluate-mcp-public.mjs [--evidence <new-file.json>] [--test-loopback-origin <http://literal-loopback:port>]');
      if (flag === '--evidence' && evidencePath === undefined) {
        if (!value.endsWith('.json')) throw new Error('Evidence path must end with .json.');
        evidencePath = resolve(value);
      } else if (flag === '--test-loopback-origin' && fixtureOrigin === undefined) fixtureOrigin = publicApiOrigin(value, { fixtureMode: true });
      else throw new Error(`Unknown or repeated option: ${flag}`);
    }
    const evidence = await evaluatePublicMcp({ fixtureOrigin });
    const encoded = `${JSON.stringify(evidence, null, 2)}\n`;
    // No file is written unless the operator explicitly requested evidence.
    // Refuse to overwrite any existing file, including prior evidence.
    if (evidencePath !== undefined) await writeFile(evidencePath, encoded, { flag: 'wx' });
    process.stdout.write(encoded);
    if (!evidence.passed) process.exitCode = 1;
  } catch (error) {
    console.error(`Mote MCP evaluation: ${error.message}`);
    process.exitCode = 1;
  }
}
