/**
 * Cache headers: a failure is never cached, and the proxy leaves each route's
 * own header alone (its prefix rules used to override them, error responses
 * included).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { CACHE, cacheFor } from '@/lib/utils/http-cache';

describe('cacheFor', () => {
  it('caches a successful response for the given time', () => {
    const res = cacheFor(new Response('{}', { status: 200 }), CACHE.poolWide);
    expect(res.headers.get('Cache-Control')).toBe(CACHE.poolWide);
  });

  it.each([400, 404, 500, 503])('never caches a %i', (status) => {
    const res = cacheFor(new Response('{}', { status }), CACHE.poolWide);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('proxy', () => {
  it('sets no Cache-Control of its own on API responses', () => {
    const src = readFileSync(join(__dirname, '../../proxy.ts'), 'utf8');
    expect(src).not.toMatch(/headers\.set\(\s*['"]Cache-Control['"]/);
  });
});
