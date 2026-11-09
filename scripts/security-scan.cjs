#!/usr/bin/env node
/**
 * Repo malware guard. Scans tracked JS/TS source for the obfuscated-loader
 * signatures and appended-payload anomalies that infected next.config.js
 * (introduced by 9b6711ce, re-added by 6ea125ea, removed in 01f962f8).
 *
 * Wired as `prebuild` so an infected tree can never be built/deployed, and
 * runnable directly: `bun run security:scan`. Exits non-zero on any hit.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Long single lines are the most reliable tell of an appended obfuscated payload
// hidden behind whitespace. Real source in this repo stays well under this.
const MAX_LINE = 2000;

// Obfuscated-loader fingerprints observed in the next.config.js payload.
const SIGNATURES = [
  /global\.i\s*=/,                       // loader bootstrap
  /_\$_[0-9a-f]{4}/,                     // mangled identifier scheme
  /String\.fromCharCode\(127\)/,         // delimiter trick used by the deobfuscator
  /\)\s*=\s*lyR\(/,                      // string-shuffle deobfuscator call
  /global\[[^\]]{1,40}\]\s*=\s*require\b/, // require() hijack
];

const EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.cjs', '.mjs']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '.git', 'out', '.vercel']);

// Fallback: recursively walk the source tree when git isn't available.
// Vercel CLI deploys upload a tarball without .git, so the git path fails
// there — without this fallback the prebuild guard blocks every deploy.
function walk(dir, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    // Skip symlinks — they can point into bun/npm caches under
    // ~/.bun/install/cache, dragging vendor code into the tracked-source
    // scan (which is designed to inspect first-party code only).
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), acc);
    } else if (e.isFile() && EXTS.has(path.extname(e.name))) {
      const full = path.join(dir, e.name);
      // Path-based safety net for cache indirection: skip anything
      // whose resolved path lives under a bun/npm/pnpm cache dir even
      // if we somehow entered it via symlink hop.
      if (/[\\/]\.(bun|npm|pnpm)[\\/]/.test(full)) continue;
      acc.push(path.relative(process.cwd(), full));
    }
  }
  return acc;
}

let files;
let source;
try {
  files = execSync('git ls-files "*.js" "*.ts" "*.jsx" "*.tsx" "*.cjs" "*.mjs"', {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .split('\n')
    .filter(Boolean)
    .filter((f) => !f.startsWith('node_modules/') && !f.includes('/.next/') && !f.startsWith('.next/') && !f.startsWith('dist/'));
  source = 'git';
} catch {
  files = walk(process.cwd(), []);
  source = 'fs';
}

const hits = [];
for (const f of files) {
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const lines = txt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.length > MAX_LINE) hits.push(`${f}:${i + 1}  suspicious long line (${ln.length} chars)`);
    for (const sig of SIGNATURES) {
      if (sig.test(ln)) hits.push(`${f}:${i + 1}  matches malware signature ${sig}`);
    }
  }
}

if (hits.length) {
  console.error('\n[31m✗ SECURITY SCAN FAILED — possible injected/obfuscated code:[0m');
  for (const h of hits) console.error('  ' + h);
  console.error('\nBuild aborted. Investigate before deploying. (See scripts/security-scan.cjs)\n');
  process.exit(1);
}
console.log(`[32m✓ security scan clean[0m (${files.length} tracked source files)`);
