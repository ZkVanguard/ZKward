/**
 * Every network the dashboard names has its official mark on disk, safe to
 * serve, and every locale carries the same wallet strings.
 */
import { describe, it, expect } from '@jest/globals';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const CHAINS = ['sui', 'hedera', 'solana'];

function keys(o: unknown, prefix = ''): string[] {
  if (!o || typeof o !== 'object') return [prefix];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
}

describe('chain logos', () => {
  it.each(CHAINS)('%s has a vector mark with nothing executable in it', (chain) => {
    const p = join(ROOT, 'public', 'logos', 'chains', `${chain}.svg`);
    expect(existsSync(p)).toBe(true);
    const svg = readFileSync(p, 'utf8');
    expect(svg).toMatch(/<svg[\s>]/);
    expect(svg).toMatch(/<path/);
    expect(svg).not.toMatch(/<script|on\w+=|javascript:|<image|base64/i);
  });

  it('the wallet hub points every network at its mark', () => {
    const hub = readFileSync(join(ROOT, 'contexts', 'WalletHubContext.tsx'), 'utf8');
    for (const chain of CHAINS) expect(hub).toContain(`logo: '/logos/chains/${chain}.svg'`);
  });

  it('every locale has the same wallet strings as English', () => {
    const dir = join(ROOT, 'messages');
    const en = keys(JSON.parse(readFileSync(join(dir, 'en.json'), 'utf8')).wallet).sort();
    expect(en.length).toBeGreaterThan(30);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const got = keys(JSON.parse(readFileSync(join(dir, f), 'utf8')).wallet).sort();
      expect({ file: f, keys: got }).toEqual({ file: f, keys: en });
    }
  });
});
