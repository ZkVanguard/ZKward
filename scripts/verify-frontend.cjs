#!/usr/bin/env node
/**
 * Build-time guardrails against silent frontend bugs.
 *
 *   1. Every t('key') / t.rich('key') / t.raw('key') referenced in a file
 *      that calls useTranslations(ns) / getTranslations(ns) MUST exist
 *      in messages/en.json under `ns.key`. Would have caught the
 *      whitepaper 105-key MISSING_MESSAGE incident (2026-08-03).
 *
 *   2. No `use client` file may import getFullnodeUrl from @mysten/sui.
 *      fullnode.mainnet.sui.io killed JSON-RPC in 2026-07 and never sent
 *      CORS headers — routing browser RPC through it is a dead end. All
 *      client SUI RPC must go through /api/rpc/sui.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const EN_PATH = path.join(ROOT, 'messages', 'en.json');
const SCAN_DIRS = ['app', 'components', 'lib'];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const s = fs.statSync(p);
    if (s.isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function loadEn() {
  const raw = fs.readFileSync(EN_PATH, 'utf-8');
  return JSON.parse(raw);
}

function hasKey(root, dottedKey) {
  let o = root;
  for (const p of dottedKey.split('.')) {
    if (!o || typeof o !== 'object' || !(p in o)) return false;
    o = o[p];
  }
  return true;
}

const files = SCAN_DIRS.flatMap(d => walk(path.join(ROOT, d)));

// ---------------- i18n ----------------
const missingKeys = [];

const NS_RX = /\b(?:useTranslations|getTranslations)\(\s*['"`]([^'"`]+)['"`]/g;
const T_RX = /\bt(?:\.rich|\.raw)?\(\s*['"`]([^'"`]+)['"`]/g;

let en;
try {
  en = loadEn();
} catch (err) {
  console.error(`✗ Could not read ${EN_PATH}: ${err.message}`);
  process.exit(1);
}

for (const file of files) {
  const src = fs.readFileSync(file, 'utf-8');
  const namespaces = [];
  let m;
  NS_RX.lastIndex = 0;
  while ((m = NS_RX.exec(src)) !== null) namespaces.push(m[1]);
  if (namespaces.length === 0) continue;
  // Simple rule: apply the first namespace found in the file to every t() call.
  // Files that use multiple namespaces are rare; if this fires false positives,
  // rewrite the offending call to include the full dotted namespace.
  const ns = namespaces[0];
  T_RX.lastIndex = 0;
  while ((m = T_RX.exec(src)) !== null) {
    const key = m[1];
    if (/^\{.*\}$/.test(key) || key.includes('${')) continue;
    const dotted = `${ns}.${key}`;
    if (!hasKey(en, dotted)) {
      missingKeys.push({ file: path.relative(ROOT, file), key: dotted });
    }
  }
}

// ---------------- locale-parity check ----------------
// Would have caught 2026-08-04 whitepaper.conclusion.p1/p2/p3 missing
// from 11 non-en locales (silent MISSING_MESSAGE fallback in prod).
const LOCALE_DIR = path.join(ROOT, 'messages');
const localeGaps = [];
try {
  const enFlat = flattenKeys(en);
  const files = fs.readdirSync(LOCALE_DIR).filter(f => f.endsWith('.json') && f !== 'en.json');
  for (const file of files) {
    const locale = path.basename(file, '.json');
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, file), 'utf-8')); }
    catch { localeGaps.push({ locale, error: 'unparseable' }); continue; }
    const localeFlat = flattenKeys(data);
    const missing = enFlat.filter(k => !localeFlat.includes(k));
    if (missing.length > 0) localeGaps.push({ locale, missing });
  }
} catch (err) {
  console.error(`✗ locale-parity check failed: ${err.message}`);
}
function flattenKeys(obj, prefix = '') {
  const keys = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) keys.push(...flattenKeys(v, key));
    else keys.push(key);
  }
  return keys;
}

// ---------------- client-side SUI RPC ban ----------------
const badRpcImports = [];

for (const file of files) {
  const src = fs.readFileSync(file, 'utf-8');
  // Scan the whole file for 'use client' — some hooks put JSDoc + imports
  // before the pragma (see components/dashboard/community-pool/useCommunityPool.ts
  // where 'use client' sits on line 17 behind a long header).
  const isClient = /^\s*['"]use client['"]\s*;?/m.test(src);
  if (!isClient) continue;
  // Local/devnet use is fine — those resolve to localhost or dev endpoints.
  // Only mainnet + testnet are the dead-JSON-RPC + no-CORS endpoints.
  if (/getFullnodeUrl\(\s*['"](?:mainnet|testnet)['"]/.test(src)) {
    badRpcImports.push(path.relative(ROOT, file));
    continue;
  }
  // Also catch raw fetch()/URL strings to fullnode.mainnet.sui.io — some
  // hooks (e.g. OldPoolWithdraw.tsx) POST directly with a hardcoded URL.
  // The dot in the regex is literal to avoid matching unrelated strings.
  if (/['"`]https:\/\/fullnode\.(?:mainnet|testnet)\.sui\.io/.test(src)) {
    badRpcImports.push(path.relative(ROOT, file));
  }
}

// ---------------- report ----------------
let failed = false;

if (missingKeys.length > 0) {
  failed = true;
  console.error(`✗ ${missingKeys.length} i18n key(s) missing from messages/en.json:`);
  for (const { file, key } of missingKeys.slice(0, 50)) {
    console.error(`    ${file} → ${key}`);
  }
  if (missingKeys.length > 50) console.error(`    …and ${missingKeys.length - 50} more`);
  console.error('  Add the missing keys to messages/en.json before shipping.');
}

if (badRpcImports.length > 0) {
  failed = true;
  console.error(`✗ ${badRpcImports.length} client-side file(s) import getFullnodeUrl (dead JSON-RPC + no CORS):`);
  for (const f of badRpcImports) console.error(`    ${f}`);
  console.error('  Route browser SUI RPC through /api/rpc/sui instead (see app/sui-providers.tsx).');
}

if (localeGaps.length > 0) {
  failed = true;
  const totalMissing = localeGaps.reduce((s, g) => s + (g.missing?.length || 0), 0);
  console.error(`✗ locale parity: ${localeGaps.length} locale(s) missing ${totalMissing} key(s) present in en.json:`);
  for (const g of localeGaps) {
    if (g.error) { console.error(`    ${g.locale}: ${g.error}`); continue; }
    const preview = g.missing.slice(0, 5).join(', ');
    const more = g.missing.length > 5 ? ` (+${g.missing.length - 5} more)` : '';
    console.error(`    ${g.locale}: ${g.missing.length} missing — ${preview}${more}`);
  }
  console.error('  Add missing keys to each non-en locale in messages/. next-intl throws MISSING_MESSAGE otherwise.');
}

if (failed) process.exit(1);

console.log(`✓ frontend verify clean (${files.length} files scanned, i18n + locale parity + client RPC)`);
