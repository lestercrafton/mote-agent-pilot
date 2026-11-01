import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { keccak256 } from 'ethers';
import { compileContracts } from '../scripts/compile.mjs';
import { hashJson } from './json.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const names = ['MoteToken', 'MotePayments'];
let cached;

/** Complete public compiler input; no artifacts are overwritten or published. */
export function createVerificationBundle() {
  if (!cached) {
    const artifacts = compileContracts({ writeArtifacts: false });
    const paths = [...new Set(names.flatMap((name) => Object.keys(artifacts[name].metadata.sources)))].sort();
    const sources = Object.fromEntries(paths.map((source) => {
      const permitted = source === 'contracts/MoteToken.sol' || source === 'contracts/MotePayments.sol'
        || (source.startsWith('@openzeppelin/contracts/') && !source.split('/').includes('..'));
      if (!permitted) throw new Error(`Unexpected verification source: ${source}`);
      const filename = source.startsWith('@openzeppelin/') ? path.join(root, 'node_modules', source) : path.join(root, source);
      return [source, { content: fs.readFileSync(filename, 'utf8') }];
    }));
    const input = {
      language: 'Solidity', sources,
      settings: {
        optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai',
        outputSelection: { '*': { '*': ['abi', 'metadata', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
      },
    };
    // Deliberately no import callback: the exported input must be self-contained.
    const output = JSON.parse(solc.compile(JSON.stringify(input)));
    const errors = (output.errors ?? []).filter((entry) => entry.severity === 'error');
    if (errors.length) throw new Error(errors.map((entry) => entry.formattedMessage).join('\n'));
    const contracts = Object.fromEntries(names.map((name) => {
      const compiled = output.contracts[`contracts/${name}.sol`][name];
      if (`0x${compiled.evm.bytecode.object}` !== artifacts[name].bytecode
        || `0x${compiled.evm.deployedBytecode.object}` !== artifacts[name].deployedBytecode
        || hashJson(compiled.abi) !== hashJson(artifacts[name].abi)) {
        throw new Error(`Verification input changed existing ${name} bytecode`);
      }
      return [name, {
        identifier: `contracts/${name}.sol:${name}`,
        creationBytecodeHash: keccak256(artifacts[name].bytecode),
        runtimeTemplateHash: keccak256(artifacts[name].deployedBytecode),
        abiHash: hashJson(compiled.abi),
        immutableReferences: compiled.evm.deployedBytecode.immutableReferences ?? {},
      }];
    }));
    cached = {
      schema: 'mote-solidity-verification-v1',
      compiler: {
        version: solc.version(),
        verificationVersion: `v${solc.version().split('.Emscripten.')[0]}`,
        evmVersion: 'shanghai', optimizer: { enabled: true, runs: 200 },
      },
      input, inputHash: hashJson(input), contracts,
    };
  }
  return structuredClone(cached);
}
