import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, chmodSync, mkdtempSync, linkSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Compile only. Never execute the resulting native helper or access Keychain.
let staging;
try {
  const args = process.argv.slice(2);
  if (process.platform !== 'darwin' || args.length !== 2 || args[0] !== '--out') throw new Error();
  const output = resolve(args[1]);
  if (existsSync(output)) throw new Error();
  staging = mkdtempSync(join(tmpdir(), 'mote-keychain-build-'));
  const binary = join(staging, 'helper'), source = resolve(dirname(fileURLToPath(import.meta.url)), 'mote-keychain.swift');
  const result = spawnSync('/usr/bin/swiftc', ['-module-cache-path', join(staging,'module-cache'), source, '-o', binary, '-framework', 'Security'], { stdio: ['ignore','pipe','pipe'], env: { PATH: '/usr/bin:/bin', TMPDIR: tmpdir() } });
  if (result.status !== 0) throw new Error();
  chmodSync(binary, 0o700);
  linkSync(binary, output); // Atomic create-only publication; never clobber an existing output.
  console.log(JSON.stringify({ built: true, executed: false, nativeKeychainTested: false, keychainCalls: 0, sha256: createHash('sha256').update(readFileSync(output)).digest('hex'), legacySecurityApis: true }));
} catch { console.error('KEYCHAIN_BUILD_REFUSED_OR_FAILED'); process.exitCode = 1; }
finally { if (staging) rmSync(staging, { recursive: true, force: true }); }
