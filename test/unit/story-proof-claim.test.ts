/**
 * The Story page says what is true about proofs today: the proof system is
 * live and anyone can make a proof, but trades do not carry one yet.
 */
import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';

const dir = path.resolve(__dirname, '../../messages');

describe('story page proof claim', () => {
  it.each(fs.readdirSync(dir).filter((f) => f.endsWith('.json')))('%s', (f) => {
    const body = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).story.howItWorks.body1 as string;
    expect(body.length).toBeGreaterThan(50);
    if (f === 'en.json') {
      expect(body).not.toMatch(/When it makes a trade, it also produces/);
      expect(body).toMatch(/attaching one to every trade is the next step/);
    }
  });
});
