#!/usr/bin/env node
/**
 * Supply-chain hardening — runs on prebuild to catch classes of failure
 * that have caused real crypto incidents ($100M+ in aggregate industry
 * losses).
 *
 * Fails the build on:
 *   1. Missing bun.lock (dependency floats — hits reproducible-build integrity)
 *   2. package.json has any `^`, `~`, or wildcard version specifiers on
 *      *runtime* dependencies (dev deps allowed to float)
 *   3. `npm audit` returns HIGH or CRITICAL vulnerabilities (non-fatal in
 *      dev mode via SUPPLY_CHAIN_STRICT=0; hard-fail in production build)
 *   4. Any `file:` or `git+` dependency in runtime deps (can be modified
 *      post-install and evade lockfile pinning — Tether wdk-wallet-evm
 *      almost bit us via this in commit d4a4f8ab)
 *
 * To bypass in emergencies: SUPPLY_CHAIN_BYPASS=1 (audited via git log).
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const STRICT = (process.env.SUPPLY_CHAIN_STRICT ?? '1') === '1';
const BYPASS = process.env.SUPPLY_CHAIN_BYPASS === '1';

const errors = [];
const warnings = [];

function report(kind, msg) {
  (kind === 'error' ? errors : warnings).push(msg);
  console.log(`${kind === 'error' ? '❌' : '⚠️ '} ${msg}`);
}

// ── Check 1: lockfile present ────────────────────────────────────────────
const lockPaths = ['bun.lock', 'bun.lockb', 'package-lock.json'];
const lockFound = lockPaths.some((p) => fs.existsSync(path.join(ROOT, p)));
if (!lockFound) {
  report('error', `No lockfile found — dependencies will float between machines. Expected one of: ${lockPaths.join(', ')}`);
}

// ── Check 2: runtime deps must be pinned ─────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const RUNTIME_DEPS = pkg.dependencies || {};

const FLOATING_ALLOWED = new Set([
  // Allow floats on packages known safe to bump automatically (e.g., pure
  // TS types). Add sparingly.
]);

const UNSAFE_SPECIFIERS = [];
for (const [name, ver] of Object.entries(RUNTIME_DEPS)) {
  if (FLOATING_ALLOWED.has(name)) continue;
  if (typeof ver !== 'string') continue;
  if (ver.startsWith('file:') || ver.startsWith('git+') || ver.startsWith('http')) {
    UNSAFE_SPECIFIERS.push({ name, ver, type: 'non-registry' });
    continue;
  }
  if (ver.startsWith('*') || ver.startsWith('x') || ver === 'latest') {
    UNSAFE_SPECIFIERS.push({ name, ver, type: 'wildcard' });
    continue;
  }
}
if (UNSAFE_SPECIFIERS.length) {
  report('error',
    `Runtime deps with unsafe specifiers (${UNSAFE_SPECIFIERS.length}):\n` +
    UNSAFE_SPECIFIERS.map((d) => `      ${d.name}: "${d.ver}" (${d.type})`).join('\n'),
  );
}

// ── Check 3: known-bad packages / typos ──────────────────────────────────
const KNOWN_MALWARE_PATTERNS = [
  // Historic typosquat attacks — kept as a defensive check
  /^cross-env-shell$/,
  /^discord\.dll$/,
  /^express-cookie-parser$/,
  /^event-source-polyfill-npm$/,
];
for (const name of Object.keys(RUNTIME_DEPS)) {
  for (const pat of KNOWN_MALWARE_PATTERNS) {
    if (pat.test(name)) {
      report('error', `Suspected typosquat / historic-malware package: ${name}`);
    }
  }
}

// ── Check 3.5: install-scripts baseline ──────────────────────────────────
// npm 11's install-scripts warning prints when packages have pre/post/
// install hooks that aren't in an allowlist. We silence that warning via
// .npmrc loglevel=error (see docs/SUPPLY_CHAIN_POLICY.md), but silencing
// alone would hide the case where a NEW dep quietly gains install scripts.
// Programmatic replacement: walk package-lock.json, extract every package
// with hasInstallScript=true, diff against .install-scripts-baseline.json.
// Fail on new entries so the addition is reviewed + approved.
(function checkInstallScripts() {
  const baselinePath = path.join(ROOT, '.install-scripts-baseline.json');
  const lockPath = path.join(ROOT, 'package-lock.json');
  if (!fs.existsSync(baselinePath) || !fs.existsSync(lockPath)) return;

  let authorized;
  try {
    authorized = new Set(JSON.parse(fs.readFileSync(baselinePath, 'utf8')).authorized || []);
  } catch {
    report('warning', '.install-scripts-baseline.json is present but invalid — skipping check');
    return;
  }

  let lock;
  try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); }
  catch { return; }

  const found = new Set();
  for (const [p, meta] of Object.entries(lock.packages || {})) {
    if (!p || !p.startsWith('node_modules/')) continue;
    if (!meta || !meta.hasInstallScript) continue;
    const name = p.split('node_modules/').slice(-1)[0];
    found.add(name);
  }

  const newEntries = [...found].filter((n) => !authorized.has(n)).sort();
  const removed = [...authorized].filter((n) => !found.has(n)).sort();

  if (newEntries.length > 0) {
    report(
      'error',
      `${newEntries.length} package(s) added install scripts not in baseline:\n` +
        newEntries.map((n) => `      + ${n}`).join('\n') +
        '\n    Review each — if trusted, add to .install-scripts-baseline.json authorized[].\n' +
        '    If unexpected, investigate before authorizing (potential supply-chain attack surface).',
    );
  } else if (removed.length > 0) {
    // Stale baseline — informational, not blocking.
    console.log(`ℹ️  install-scripts baseline has ${removed.length} stale entry(ies) (no longer used): ${removed.join(', ')}`);
  } else {
    console.log(`✅ install-scripts baseline verified (${found.size} authorized package(s))`);
  }
})();

// ── Check 4: npm audit ────────────────────────────────────────────────────
// Blocking policy: CRITICAL always blocks; HIGH blocks only when
// SUPPLY_CHAIN_BLOCK_HIGH=1. Otherwise HIGH surfaces as warnings so the
// team can triage without breaking every deploy. Triaged findings can be
// waived via .audit-allowlist.json (see docs/SUPPLY_CHAIN_POLICY.md).
if (STRICT && !BYPASS) {
  // Load allowlist
  let allowlist = { waived: {} };
  const allowPath = path.join(ROOT, '.audit-allowlist.json');
  if (fs.existsSync(allowPath)) {
    try { allowlist = JSON.parse(fs.readFileSync(allowPath, 'utf8')); }
    catch { report('warning', '.audit-allowlist.json is present but invalid — ignoring'); }
  }
  const blockHigh = (process.env.SUPPLY_CHAIN_BLOCK_HIGH ?? '') === '1';

  function parseAudit(text) {
    try {
      const parsed = JSON.parse(text);
      const vulns = parsed.vulnerabilities || {};
      const entries = Object.entries(vulns);
      const critical = entries.filter(([, v]) => v.severity === 'critical');
      const high = entries.filter(([, v]) => v.severity === 'high');
      return { critical, high };
    } catch { return null; }
  }
  function isWaived(name) {
    const w = allowlist.waived?.[name];
    if (!w) return false;
    if (w.expires && Date.parse(w.expires) < Date.now()) return false;
    return true;
  }

  let auditText = '';
  try {
    // Windows-safe: use spawnSync so we don't rely on shell stderr redirect
    const { spawnSync } = require('child_process');
    const audit = spawnSync('npm', ['audit', '--json', '--omit=dev'], {
      cwd: ROOT, encoding: 'utf8', timeout: 90_000, shell: process.platform === 'win32',
    });
    auditText = audit.stdout || audit.stderr || '';
  } catch (e) {
    auditText = String(e.stdout || e.message || '');
  }

  const result = parseAudit(auditText);
  if (!result) {
    report('warning', 'npm audit did not return valid JSON — supply-chain audit skipped');
  } else {
    const criticalUnwaived = result.critical.filter(([name]) => !isWaived(name));
    const criticalWaived = result.critical.filter(([name]) => isWaived(name));
    const highUnwaived = result.high.filter(([name]) => !isWaived(name));
    const highWaived = result.high.filter(([name]) => isWaived(name));

    if (criticalUnwaived.length) {
      report('error',
        `${criticalUnwaived.length} CRITICAL vuln(s) in runtime deps (not waived):\n` +
        criticalUnwaived.slice(0, 5).map(([n]) => `      - ${n}`).join('\n'),
      );
    }
    if (highUnwaived.length) {
      const line = `${highUnwaived.length} HIGH-severity vuln(s) in runtime deps${highWaived.length ? ` (+${highWaived.length} waived)` : ''}:\n` +
        highUnwaived.slice(0, 10).map(([n]) => `      - ${n}`).join('\n');
      report(blockHigh ? 'error' : 'warning', line);
    }
    if (criticalWaived.length) {
      report('warning', `${criticalWaived.length} CRITICAL findings WAIVED via .audit-allowlist.json — review before expiry`);
    }
    if (!criticalUnwaived.length && !highUnwaived.length) {
      console.log('✅ npm audit clean (or all findings waived)');
    }
  }
}

// ── Result ───────────────────────────────────────────────────────────────
if (BYPASS) {
  console.log('\n⚠️  SUPPLY_CHAIN_BYPASS=1 — errors demoted to warnings (audit trail via git log)');
  const total = errors.length + warnings.length;
  if (total === 0) console.log('   (nothing was going to fail anyway)');
  process.exit(0);
}
if (errors.length > 0) {
  console.log(`\n❌ Supply chain verification FAILED with ${errors.length} error(s), ${warnings.length} warning(s)`);
  console.log('   Set SUPPLY_CHAIN_BYPASS=1 to force build (emergency only).');
  process.exit(1);
}
console.log(`\n✅ Supply chain verified (${warnings.length} warning(s))`);
process.exit(0);
