import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline maintainer repair only. No install hook, package execution, network,
// platform override, dependency upgrade, or relaxation of npm's OS checks.
// Exact descriptor from the integrity-verified ganache@7.9.2 published archive:
// package/npm-shrinkwrap.json -> packages["node_modules/fsevents"].
// See docs/ganache-lock-metadata-v0.7.2.json for provenance and limitations.
const TARGET = 'node_modules/ganache/node_modules/fsevents';
const GANACHE_INTEGRITY = 'sha512-7gsVVDpO9AhrFyDMWWl7SpMsPpqGcnAzjxz3k32LheIPNd64p2XsY9GYRdhWmKuryb60W1iaWPZWDkFKlbRWHA==';
const EXPECTED = {
  version: '2.3.2',
  resolved: 'https://registry.npmjs.org/fsevents/-/fsevents-2.3.2.tgz',
  integrity: 'sha512-xiqMQR4xAeHTuB9uWm+fFRcIOgKBMiOBP+eXiyT7jsgVCq1bkVygt00oASowB7EdtpOHaaPgKt812P9ab+DDKA==',
  dev: true,
  optional: true,
  os: ['darwin'],
  engines: { node: '^8.16.0 || ^10.6.0 || >=11.0.0' },
};
const BROKEN = { version: EXPECTED.version, resolved: EXPECTED.resolved, integrity: EXPECTED.integrity,
  extraneous: true, os: EXPECTED.os, engines: EXPECTED.engines };
const defaultLock = fileURLToPath(new URL('../package-lock.json', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
    : JSON.stringify(value);
const same = (a, b) => canonical(a) === canonical(b);
const check = (value, message) => { if (!value) throw new Error(message); };

export function repairGanacheLock({ lockfile = defaultLock, write = false } = {}) {
  check(typeof lockfile === 'string' && typeof write === 'boolean', 'Explicit lockfile path and boolean write mode required');
  const filename = resolve(lockfile), stat = lstatSync(filename);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 2_000_000,
    'Lockfile must be a bounded regular single-link file, not an alias to an immutable release');
  const bytes = readFileSync(filename), lock = JSON.parse(bytes);
  check(lock.lockfileVersion === 3 && lock.packages && typeof lock.packages === 'object', 'Only the reviewed npm lockfile v3 layout is supported');
  const ganache = lock.packages['node_modules/ganache'], chokidar = lock.packages['node_modules/ganache/node_modules/chokidar'];
  check(ganache?.version === '7.9.2' && ganache.resolved === 'https://registry.npmjs.org/ganache/-/ganache-7.9.2.tgz'
    && ganache.integrity === GANACHE_INTEGRITY && ganache.dev === true && ganache.hasShrinkwrap === true,
  'Ganache identity or dependency role changed; review new upstream metadata instead of applying this repair');
  check(chokidar?.version === '3.5.2' && chokidar.resolved === 'https://registry.npmjs.org/chokidar/-/chokidar-3.5.2.tgz'
    && chokidar.integrity === 'sha512-ekGhOnNVPgT77r4K/U3GDhu+FQ2S8TnK/s2KbIGXi0SZWuwkZ2QNyfWdZW+TVfn84DpEP7rLeCt2UI6bJ8GwbQ=='
    && same(chokidar.optionalDependencies, { fsevents: '~2.3.2' }),
  'Chokidar identity or optional fsevents relationship changed; manual metadata review required');
  const descriptor = lock.packages[TARGET], beforeSha256 = digest(bytes);
  if (same(descriptor, EXPECTED)) return { status: 'correct', changed: false, target: TARGET, beforeSha256, afterSha256: beforeSha256 };
  check(same(descriptor, BROKEN), 'fsevents descriptor differs from the exact known malformed state; refusing to guess');
  if (!write) return { status: 'repair-required', changed: false, target: TARGET, beforeSha256 };
  lock.packages[TARGET] = structuredClone(EXPECTED);
  const output = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`);
  const temporary = join(dirname(filename), `.mote-lock-repair-${process.pid}-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, stat.mode & 0o777);
    writeFileSync(fd, output); fsyncSync(fd); closeSync(fd); fd = undefined;
    const current = lstatSync(filename);
    check(current.isFile() && !current.isSymbolicLink() && current.nlink === 1 && current.dev === stat.dev && current.ino === stat.ino
      && readFileSync(filename).equals(bytes), 'Lockfile changed concurrently; repair not applied');
    renameSync(temporary, filename);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { status: 'repaired', changed: true, target: TARGET, beforeSha256, afterSha256: digest(output) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); let write = false, lockfile = defaultLock;
    if (args[0] === '--check' || args[0] === '--write') write = args.shift() === '--write';
    if (args.length) { check(args.length === 2 && args[0] === '--lockfile' && args[1], 'Usage: node scripts/repair-ganache-lock.mjs [--check|--write] [--lockfile PATH]'); lockfile = args[1]; }
    const result = repairGanacheLock({ lockfile, write });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status === 'repair-required') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: 'GANACHE_LOCK_REPAIR_REFUSED', message: error.message })}\n`);
    process.exitCode = 1;
  }
}
