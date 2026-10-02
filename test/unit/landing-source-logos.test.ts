/**
 * The landing page's data-source strip: every logo it references ships in
 * `public/logos/sources/` as a plain SVG (no scripts, no remote references),
 * and every locale carries the strip's strings.
 */
import { describe, it, expect } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const component = fs.readFileSync(path.join(root, 'lib/api/signal-providers.ts'), 'utf8');
const slugs = [...component.matchAll(/slug: '([a-z-]+)'/g)].map((m) => m[1]);
const roles = [...component.matchAll(/role: '([a-zA-Z]+)'/g)].map((m) => m[1]);

describe('data-source strip', () => {
  it('lists the providers the aggregator reads', () => {
    expect(slugs).toEqual(['polymarket', 'kalshi', 'manifold', 'binance', 'bybit', 'deribit', 'crypto-com', 'bluefin']);
  });

  it('ships every logo as a safe SVG', () => {
    for (const slug of slugs) {
      const file = path.join(root, 'public/logos/sources', `${slug}.svg`);
      expect(fs.existsSync(file)).toBe(true);
      const svg = fs.readFileSync(file, 'utf8');
      expect(svg).toMatch(/<svg[^>]*viewBox=/);
      expect(svg).not.toMatch(/<script|onload=|<foreignObject|xlink:href="http|href="http/i);
      expect(fs.statSync(file).size).toBeLessThan(20_000);
    }
  });

  it('every locale has the strip strings for every role used', () => {
    const locales = fs.readdirSync(path.join(root, 'messages')).filter((f) => f.endsWith('.json'));
    expect(locales.length).toBeGreaterThanOrEqual(13);
    for (const f of locales) {
      const json = JSON.parse(fs.readFileSync(path.join(root, 'messages', f), 'utf8'));
      const s = json.landing?.sources;
      const missing = ['eyebrow', 'caption'].filter((k) => !s?.[k]).concat([...new Set(roles)].filter((r) => !s?.roles?.[r]).map((r) => `roles.${r}`));
      expect({ locale: f, missing }).toEqual({ locale: f, missing: [] });
    }
  });
});
