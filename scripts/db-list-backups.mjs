#!/usr/bin/env node
/**
 * db-list-backups.mjs — list every dump in db-backups/ with size + age.
 *
 * No DB access. Safe to run anywhere, any time.
 *
 * Usage:
 *   bun run db:list-backups
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backupsDir = path.resolve(__dirname, '..', 'db-backups');

if (!existsSync(backupsDir)) {
  console.log('(no db-backups/ directory yet — run `bun run db:backup`)');
  process.exit(0);
}

const files = readdirSync(backupsDir)
  .filter((f) => f.endsWith('.sql') || f.endsWith('.sql.gz'))
  .map((f) => {
    const full = path.join(backupsDir, f);
    const st = statSync(full);
    return { name: f, size: st.size, mtime: st.mtimeMs };
  })
  .sort((a, b) => b.mtime - a.mtime);

if (files.length === 0) {
  console.log('(no backups yet — run `bun run db:backup`)');
  process.exit(0);
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function humanAge(msAgo) {
  const s = Math.round(msAgo / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const now = Date.now();
const totalSize = files.reduce((a, f) => a + f.size, 0);
console.log(`${files.length} backup(s) · ${humanSize(totalSize)} total`);
console.log('');
for (const f of files) {
  const age = humanAge(now - f.mtime).padStart(8);
  const size = humanSize(f.size).padStart(9);
  console.log(`  ${age}  ${size}  ${f.name}`);
}
console.log('');
console.log('Restore locally: bun run db:restore-local -- <name> --i-really-mean-it');
