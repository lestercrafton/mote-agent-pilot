import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const root = fileURLToPath(new URL('../', import.meta.url));
const contractName = 'MoteTestDispenser';
const sourceName = `contracts/${contractName}.sol`;
let cached;

function compilationErrors(output) {
  const errors = (output.errors ?? []).filter((entry) => entry.severity === 'error');
  if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'));
}

/** Separate offline compilation. Never reads/writes the token/router artifacts.
 * The artifact includes a self-contained standard JSON verification input. */
export function compileDispenser({ writeArtifact = true } = {}) {
  if (!cached) {
    const sources = { [sourceName]: { content: fs.readFileSync(path.join(root, sourceName), 'utf8') } };
    const settings = {
      optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
      outputSelection: { '*': { '': ['ast'], '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'metadata'] } },
    };
    const seed = { language: 'Solidity', sources, settings };
    // Discover precisely the imports used by this contract; no network, broad
    // source-tree scan, existing artifact writes, or dependency install hooks.
    const initial = JSON.parse(solc.compile(JSON.stringify(seed), {
      import(importPath) {
        if (!importPath.startsWith('@openzeppelin/contracts/') || importPath.split('/').includes('..')) {
          return { error: `Unsupported import: ${importPath}` };
        }
        try {
          const content = fs.readFileSync(path.join(root, 'node_modules', importPath), 'utf8');
          sources[importPath] = { content };
          return { contents: content };
        } catch { return { error: `Unavailable dependency: ${importPath}` }; }
      },
    }));
    compilationErrors(initial);
    const compilerInput = { language: 'Solidity', sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)), settings };
    // Recompile without imports so exported input itself is the source of the
    // exact bytecode. Cache stays private; every caller receives its own copy.
    const output = JSON.parse(solc.compile(JSON.stringify(compilerInput)));
    compilationErrors(output);
    const result = output.contracts[sourceName][contractName];
    const definition = output.sources[sourceName].ast.nodes.find((node) => node.nodeType === 'ContractDefinition' && node.name === contractName);
    const immutableNames = Object.fromEntries(definition.nodes.filter((node) => node.nodeType === 'VariableDeclaration' && node.mutability === 'immutable').map((node) => [String(node.id), node.name]));
    if (Object.keys(result.evm.deployedBytecode.immutableReferences).some((key) => !Object.hasOwn(immutableNames, key))) throw new Error('Unmapped immutable compiler reference');
    cached = {
      contractName, sourceName, compiler: solc.version(), evmVersion: 'shanghai', optimizer: settings.optimizer,
      abi: result.abi, bytecode: `0x${result.evm.bytecode.object}`, deployedBytecode: `0x${result.evm.deployedBytecode.object}`,
      immutableReferences: result.evm.deployedBytecode.immutableReferences ?? {}, immutableNames, metadata: JSON.parse(result.metadata), compilerInput,
    };
  }
  if (writeArtifact) {
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'artifacts', `${contractName}.json`), `${JSON.stringify(cached, null, 2)}\n`);
  }
  return structuredClone(cached);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifact = compileDispenser();
  process.stdout.write(`Compiled only ${contractName} with solc ${artifact.compiler} (Shanghai).\n`);
}
