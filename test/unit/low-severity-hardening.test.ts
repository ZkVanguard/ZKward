/**
 * Small boundaries that each closed a gap: chat history belongs to its
 * signer, the public subgraph surface never reflects an origin with
 * credentials, the price route takes a bounded symbol list, and the
 * transaction-recorded check never answers "no" when it could not look.
 */
import { describe, it, expect, jest } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8').replace(/\r\n/g, '\n');

jest.mock('@/lib/db/postgres', () => ({
  query: jest.fn(),
  queryOne: jest.fn(async () => { throw new Error('db down'); }),
}));
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

describe('hardening', () => {
  it('txHashExists throws when the store cannot answer', async () => {
    const { txHashExists } = await import('@/lib/db/community-pool');
    await expect(txHashExists('0xabc')).rejects.toThrow('db down');
  });

  it('chat: every handler authenticates and keys history by the signer', () => {
    const src = read('app/api/chat/route.ts');
    for (const h of ['POST', 'DELETE', 'GET']) {
      const body = src.slice(src.indexOf(`export async function ${h}(`));
      expect(body.slice(0, 600)).toContain('await requireAuth(request)');
    }
    expect(src.match(/historyKey\(authResult\.identity,/g)).toHaveLength(3);
  });

  it('subgraph: public reads answer "*", never the caller origin', () => {
    const src = read('proxy.ts');
    expect(src).toContain("const allow = isPublicReadSurface\n      ? '*'\n");
  });

  it('prices: at most 50 well-formed symbols', () => {
    const src = read('app/api/prices/route.ts');
    expect(src).toContain('symbols.length > 50 || symbols.some((s) => !/^[A-Za-z0-9]{1,15}$/.test(s))');
  });
});
