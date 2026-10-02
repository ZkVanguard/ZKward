#!/usr/bin/env node
/**
 * Supplies the modules this repository pins but does not publish.
 *
 * `private-modules.lock.json` names a repository and an exact commit. This
 * script fetches that commit with a read-only credential, checks it against
 * the digest in the lock, and reports what it found in
 * `lib/generated/private-modules-status.json` (served by the health endpoint).
 *
 * Modes, set in the lock:
 *   shadow    fetch and compare with the files in this tree; change nothing;
 *             never fail the build. Proves the build environment can fetch.
 *   required  place the files in the tree; any failure fails the build.
 *
 * Credentials (first one present wins):
 *   PRIVATE_MODULES_DEPLOY_KEY_B64  base64 of a read-only SSH deploy key
 *   PRIVATE_MODULES_READ_TOKEN      a read-only HTTPS token
 *
 * The commit is fetched by its full hash and the tree is hashed after
 * extraction, so the build uses exactly the content the lock names.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const LOCK = path.join(ROOT, 'private-modules.lock.json');
const STATUS = path.join(ROOT, 'lib', 'generated', 'private-modules-status.json');
const GITHUB_HOST_KEY = 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';
const NOT_MODULES = new Set(['LICENSE', 'README.md', 'SYNC_NOTES.md', '.gitignore']);
const TIMEOUT_MS = 60_000;

const fwd = (p) => p.replace(/\\/g, '/');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function writeStatus(status) {
  fs.mkdirSync(path.dirname(STATUS), { recursive: true });
  fs.writeFileSync(STATUS, JSON.stringify(status, null, 2) + '\n');
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git') continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(fwd(path.relative(base, full)));
  }
  return out.filter((f) => !NOT_MODULES.has(f)).sort();
}

/** Stable digest of a file set: independent of line-ending conversion on checkout. */
function treeDigest(dir, files) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f)).toString('latin1').replace(/\r\n/g, '\n');
    h.update(f + '\0' + sha256(Buffer.from(text, 'latin1')) + '\n');
  }
  return h.digest('hex');
}

/** git never echoes a credential: errors are reduced to git's own first stderr line. */
function git(args, opts) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: TIMEOUT_MS, ...opts });
  } catch (e) {
    const line = String(e.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || (e.code === 'ETIMEDOUT' ? 'timed out' : 'git failed');
    throw new Error(line.replace(/[A-Za-z0-9+/=_-]{24,}/g, '<redacted>').slice(0, 200));
  }
}

function fetchCommit(lock, tmp) {
  const dest = path.join(tmp, 'src');
  fs.mkdirSync(dest);
  git(['init', '-q'], { cwd: dest });
  const keyB64 = (process.env.PRIVATE_MODULES_DEPLOY_KEY_B64 || '').trim();
  const token = (process.env.PRIVATE_MODULES_READ_TOKEN || '').trim();
  let via;
  if (keyB64) {
    via = 'ssh';
    const keyFile = path.join(tmp, 'key');
    const known = path.join(tmp, 'known_hosts');
    fs.writeFileSync(keyFile, Buffer.from(keyB64, 'base64').toString('utf8').replace(/\r/g, '').trimEnd() + '\n', { mode: 0o600 });
    fs.writeFileSync(known, GITHUB_HOST_KEY + '\n');
    const ssh = `ssh -i "${fwd(keyFile)}" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="${fwd(known)}"`;
    git(['fetch', '-q', '--depth', '1', `git@github.com:${lock.repo}.git`, lock.commit], { cwd: dest, env: { ...process.env, GIT_SSH_COMMAND: ssh } });
  } else if (token) {
    via = 'https';
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    git(['-c', `http.extraheader=AUTHORIZATION: basic ${basic}`, 'fetch', '-q', '--depth', '1', `https://github.com/${lock.repo}.git`, lock.commit], { cwd: dest });
  } else {
    return { via: 'none', dest: null };
  }
  git(['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD'], { cwd: dest });
  const head = git(['rev-parse', 'HEAD'], { cwd: dest }).trim();
  if (head !== lock.commit) throw new Error('fetched commit is not the pinned commit');
  return { via, dest };
}

function main() {
  if (!fs.existsSync(LOCK)) {
    writeStatus({ mode: 'none' });
    return 0;
  }
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  const required = lock.mode === 'required';
  const status = { mode: required ? 'required' : 'shadow', ok: false, commit: String(lock.commit).slice(0, 8) };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'private-modules-'));
  try {
    const { via, dest } = fetchCommit(lock, tmp);
    status.via = via;
    if (!dest) throw new Error('no credential in the environment');

    const files = listFiles(dest);
    status.files = files.length;
    status.digestOk = treeDigest(dest, files) === lock.digest;
    if (!status.digestOk) throw new Error('content does not match the pinned digest');

    if (required) {
      for (const f of files) {
        const to = path.join(ROOT, f);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(dest, f), to);
      }
      fs.writeFileSync(path.join(ROOT, '.private-modules-manifest.json'), JSON.stringify(files) + '\n');
    } else {
      const norm = (p) => fs.readFileSync(p).toString('latin1').replace(/\r\n/g, '\n');
      let identical = 0, different = 0, missing = 0;
      for (const f of files) {
        const here = path.join(ROOT, f);
        if (!fs.existsSync(here)) missing++;
        else if (norm(here) === norm(path.join(dest, f))) identical++;
        else different++;
      }
      Object.assign(status, { identical, different, missing });
    }
    status.ok = true;
  } catch (e) {
    status.error = String(e && e.message ? e.message : e).slice(0, 200);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  writeStatus(status);
  console.log(`[private-modules] ${JSON.stringify(status)}`);
  return required && !status.ok ? 1 : 0;
}

if (require.main === module) {
  let code = 0;
  try {
    code = main();
  } catch (e) {
    // A fault in this script must not take a shadow build down with it.
    console.log(`[private-modules] unexpected: ${String(e && e.message ? e.message : e).slice(0, 200)}`);
    try {
      const required = fs.existsSync(LOCK) && JSON.parse(fs.readFileSync(LOCK, 'utf8')).mode === 'required';
      code = required ? 1 : 0;
    } catch { code = 0; }
  }
  process.exit(code);
}

module.exports = { listFiles, treeDigest };
