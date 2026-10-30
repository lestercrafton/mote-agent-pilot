import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
let cachedArtifacts;

/** Compile deployable artifacts without making any network request. */
export function compileContracts({ writeArtifacts = true } = {}) {
  if (!cachedArtifacts) {
    const sources = Object.fromEntries(['MoteToken', 'MotePayments'].map((name) => [
      `contracts/${name}.sol`,
      { content: fs.readFileSync(path.join(projectRoot, 'contracts', `${name}.sol`), 'utf8') },
    ]));
    const input = {
      language: 'Solidity',
      sources,
      settings: {
        optimizer: { enabled: true, runs: 200 },
        evmVersion: 'shanghai',
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] } },
      },
    };
    const output = JSON.parse(solc.compile(JSON.stringify(input), {
      import(importPath) {
        if (!importPath.startsWith('@openzeppelin/contracts/') || importPath.includes('..')) {
          return { error: `Unsupported import: ${importPath}` };
        }
        try {
          return { contents: fs.readFileSync(path.join(projectRoot, 'node_modules', importPath), 'utf8') };
        } catch (error) {
          return { error: error.message };
        }
      },
    }));
    const errors = (output.errors ?? []).filter((item) => item.severity === 'error');
    if (errors.length) throw new Error(errors.map((item) => item.formattedMessage).join('\n'));
    cachedArtifacts = Object.fromEntries(['MoteToken', 'MotePayments'].map((name) => {
      const result = output.contracts[`contracts/${name}.sol`][name];
      return [name, {
        contractName: name,
        sourceName: `contracts/${name}.sol`,
        compiler: solc.version(),
        evmVersion: 'shanghai',
        abi: result.abi,
        bytecode: `0x${result.evm.bytecode.object}`,
        deployedBytecode: `0x${result.evm.deployedBytecode.object}`,
        metadata: JSON.parse(result.metadata),
      }];
    }));
  }
  if (writeArtifacts) {
    fs.mkdirSync(path.join(projectRoot, 'artifacts'), { recursive: true });
    for (const [name, artifact] of Object.entries(cachedArtifacts)) {
      fs.writeFileSync(path.join(projectRoot, 'artifacts', `${name}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
    }
  }
  return cachedArtifacts;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifacts = compileContracts();
  process.stdout.write(`Compiled ${Object.keys(artifacts).join(', ')} with solc ${solc.version()} (Shanghai).\n`);
}
