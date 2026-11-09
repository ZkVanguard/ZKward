#!/usr/bin/env node
/**
 * db-backup.mjs — one-shot pg_dump of the production DB to a local file.
 *
 * Read-only against the source: only calls `pg_dump`, never writes to
 * the DB. The real (Aiven) DB stays the source of truth; this just
 * lands a snapshot on disk so you can restore locally if prod goes
 * sideways.
 *
 * Usage:
 *   bun run db:backup                  # dumps DATABASE_URL → db-backups/{ts}.sql.gz
 *   bun run db:backup --plain          # skip gzip (bigger .sql file)
 *   bun run db:backup --schema-only    # structure only, no rows
 *   DATABASE_URL=... bun run db:backup # override source
 *
 * Aiven note: 20-conn plan-wide cap. `pg_dump` uses ONE connection for
 * the duration; kick this off during quiet windows and don't run it
 * back-to-back if the cron pool is busy.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const backupsDir = path.join(repoRoot, 'db-backups');

// ---------- CLI args ----------
const args = process.argv.slice(2);
const gzip = !args.includes('--plain');
const schemaOnly = args.includes('--schema-only');

// ---------- Env ----------
const rawUrl = (process.env.DATABASE_URL || '').trim();
if (!rawUrl) {
  console.error(
    'ERROR: DATABASE_URL is not set. Put it in your shell env or .env.local.',
  );
  process.exit(1);
}

// Sanity: refuse to dump `localhost` unless BACKUP_LOCAL=1. Nightly-cron
// footgun defense — you almost never want to snapshot your dev DB and
// call it a "prod backup".
const looksLocal = /@(localhost|127\.0\.0\.1|host\.docker\.internal)/.test(rawUrl);
if (looksLocal && process.env.BACKUP_LOCAL !== '1') {
  console.error(
    'ERROR: DATABASE_URL points at localhost. Set BACKUP_LOCAL=1 if you really meant it.',
  );
  process.exit(1);
}

// ---------- pg_dump presence ----------
async function findPgDump() {
  return new Promise((resolve) => {
    const probe = spawn('pg_dump', ['--version'], { shell: true });
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => resolve(code === 0));
  });
}

if (!(await findPgDump())) {
  console.error(
    [
      'ERROR: pg_dump not found on PATH.',
      '',
      'Install PostgreSQL client tools:',
      '  Windows : winget install PostgreSQL.PostgreSQL',
      '            (or: https://www.postgresql.org/download/windows/)',
      '  macOS   : brew install libpq && brew link --force libpq',
      '  Linux   : sudo apt install postgresql-client',
      '',
      'Only the client is required — you do NOT need a running Postgres server.',
    ].join('\n'),
  );
  process.exit(1);
}

// ---------- Output path ----------
if (!existsSync(backupsDir)) {
  mkdirSync(backupsDir, { recursive: true });
}

function stampNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}
const stamp = stampNow();
const suffix = schemaOnly ? '.schema' : '';
const ext = gzip ? '.sql.gz' : '.sql';
const outPath = path.join(backupsDir, `${stamp}${suffix}${ext}`);

// Redact URL for logging (never print passwords).
function redactUrl(u) {
  return u.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:******@');
}

console.log(`[db-backup] source : ${redactUrl(rawUrl)}`);
console.log(`[db-backup] output : ${outPath}`);
console.log(`[db-backup] format : ${gzip ? 'gzipped SQL' : 'plain SQL'}${schemaOnly ? ' (schema only)' : ''}`);

// ---------- pg_dump invocation ----------
const dumpArgs = [
  '--no-owner',      // portable across DB users
  '--no-privileges', // portable across DB users
  '--format=plain',  // psql \i-compatible
  '--dbname', rawUrl,
];
if (schemaOnly) dumpArgs.push('--schema-only');

const started = Date.now();
const child = spawn('pg_dump', dumpArgs);

let stderrBuf = '';
child.stderr.on('data', (chunk) => {
  stderrBuf += chunk.toString('utf8');
  // Aiven "sslmode=no-verify" produces harmless notices — surface only
  // real errors.
  const line = chunk.toString('utf8').trim();
  if (line && /error|fatal/i.test(line)) {
    process.stderr.write(`[db-backup] ${line}\n`);
  }
});

try {
  if (gzip) {
    await pipeline(child.stdout, createGzip({ level: 6 }), createWriteStream(outPath));
  } else {
    await pipeline(child.stdout, createWriteStream(outPath));
  }
} catch (err) {
  console.error(`[db-backup] pipeline failed: ${err?.message ?? err}`);
  if (stderrBuf) console.error(stderrBuf);
  process.exit(1);
}

const code = await new Promise((resolve) => child.on('close', resolve));
if (code !== 0) {
  console.error(`[db-backup] pg_dump exited ${code}`);
  if (stderrBuf) console.error(stderrBuf);
  process.exit(code ?? 1);
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const size = statSync(outPath).size;
const sizeMb = (size / (1024 * 1024)).toFixed(2);
console.log(`[db-backup] done   : ${sizeMb} MB in ${elapsed}s`);
console.log(`[db-backup] restore: bun run db:restore-local -- ${path.basename(outPath)}`);
