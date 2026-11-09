#!/usr/bin/env node
/**
 * db-restore-local.mjs — restore a backup file into a LOCAL database.
 *
 * HARD RULE: this script refuses to restore into anything that looks
 * like production. Guards, in order:
 *   1. LOCAL_DATABASE_URL must be set (separate from DATABASE_URL).
 *   2. LOCAL_DATABASE_URL host must be localhost / 127.0.0.1 / a
 *      docker service name.
 *   3. LOCAL_DATABASE_URL must not equal DATABASE_URL (belt-and-braces).
 *
 * The real (Aiven) DB stays the source of truth — this script only
 * writes to your dev copy. You still have to explicitly opt in by
 * passing --i-really-mean-it, because DROP CASCADE hurts.
 *
 * Usage:
 *   bun run db:restore-local -- 20260729-134502.sql.gz --i-really-mean-it
 *   bun run db:restore-local -- --latest --i-really-mean-it
 */

import { spawn } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const backupsDir = path.join(repoRoot, 'db-backups');

// ---------- CLI args ----------
const args = process.argv.slice(2);
const iReallyMeanIt = args.includes('--i-really-mean-it');
const useLatest = args.includes('--latest');
const filenameArg = args.find(
  (a) => !a.startsWith('--') && (a.endsWith('.sql') || a.endsWith('.sql.gz')),
);

if (!iReallyMeanIt) {
  console.error(
    'ERROR: pass --i-really-mean-it to confirm you want to drop + reload your local DB.',
  );
  process.exit(1);
}

// ---------- Env guards ----------
const localUrl = (process.env.LOCAL_DATABASE_URL || '').trim();
const prodUrl = (process.env.DATABASE_URL || '').trim();

if (!localUrl) {
  console.error(
    'ERROR: LOCAL_DATABASE_URL is not set. Set it to a local Postgres URL, e.g.\n' +
      '  LOCAL_DATABASE_URL=postgres://user:pass@localhost:5432/zkv_dev',
  );
  process.exit(1);
}

const localLooksLocal =
  /@(localhost|127\.0\.0\.1|host\.docker\.internal|postgres|db)(:|\/)/i.test(localUrl);
if (!localLooksLocal) {
  console.error(
    `ERROR: LOCAL_DATABASE_URL does not look local (${redactUrl(localUrl)}).\n` +
      'Refusing to restore into something that might be prod. Point it at localhost.',
  );
  process.exit(1);
}

if (prodUrl && localUrl === prodUrl) {
  console.error('ERROR: LOCAL_DATABASE_URL equals DATABASE_URL. Refusing.');
  process.exit(1);
}

// ---------- psql presence ----------
async function findPsql() {
  return new Promise((resolve) => {
    const probe = spawn('psql', ['--version'], { shell: true });
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => resolve(code === 0));
  });
}
if (!(await findPsql())) {
  console.error(
    'ERROR: psql not found on PATH. Install PostgreSQL client tools (same install as pg_dump — see scripts/db-backup.mjs).',
  );
  process.exit(1);
}

// ---------- Choose backup file ----------
if (!existsSync(backupsDir)) {
  console.error(`ERROR: ${backupsDir} does not exist. Run \`bun run db:backup\` first.`);
  process.exit(1);
}

let backupPath;
if (useLatest) {
  const files = readdirSync(backupsDir)
    .filter((f) => f.endsWith('.sql') || f.endsWith('.sql.gz'))
    .map((f) => ({
      name: f,
      full: path.join(backupsDir, f),
      mtime: statSync(path.join(backupsDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) {
    console.error(`ERROR: no backups in ${backupsDir}.`);
    process.exit(1);
  }
  backupPath = files[0].full;
} else if (filenameArg) {
  backupPath = path.isAbsolute(filenameArg)
    ? filenameArg
    : path.join(backupsDir, filenameArg);
  if (!existsSync(backupPath)) {
    console.error(`ERROR: backup not found: ${backupPath}`);
    process.exit(1);
  }
} else {
  console.error(
    'ERROR: pass a backup filename (e.g. 20260729-134502.sql.gz) or --latest.',
  );
  process.exit(1);
}

function redactUrl(u) {
  return u.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:******@');
}

console.log(`[db-restore-local] target : ${redactUrl(localUrl)}`);
console.log(`[db-restore-local] source : ${backupPath}`);

// ---------- Restore via psql ----------
const started = Date.now();
const psql = spawn('psql', ['--dbname', localUrl, '--single-transaction', '-v', 'ON_ERROR_STOP=1']);

let stderrBuf = '';
psql.stderr.on('data', (chunk) => {
  stderrBuf += chunk.toString('utf8');
  process.stderr.write(chunk);
});

try {
  if (backupPath.endsWith('.gz')) {
    await pipeline(createReadStream(backupPath), createGunzip(), psql.stdin);
  } else {
    await pipeline(createReadStream(backupPath), psql.stdin);
  }
} catch (err) {
  console.error(`[db-restore-local] pipeline failed: ${err?.message ?? err}`);
  process.exit(1);
}

const code = await new Promise((resolve) => psql.on('close', resolve));
if (code !== 0) {
  console.error(`[db-restore-local] psql exited ${code}`);
  if (stderrBuf) console.error(stderrBuf.slice(-2000));
  process.exit(code ?? 1);
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`[db-restore-local] done in ${elapsed}s`);
