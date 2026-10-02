/**
 * The paper signal-flip exit is opt-in: 0 wins in 7 flips (−$49) after the
 * odds-based signals shipped. Default off; PAPER_TRADER_FLIP_EXIT=1 turns it on.
 */
import { describe, it, expect, jest } from '@jest/globals';

const loadFlag = (value: string | undefined): boolean => {
  let flag = true;
  jest.isolateModules(() => {
    if (value === undefined) delete process.env.PAPER_TRADER_FLIP_EXIT;
    else process.env.PAPER_TRADER_FLIP_EXIT = value;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    flag = (require('@/lib/services/paper-trader/config') as { PAPER_FLIP_EXIT_ENABLED: boolean }).PAPER_FLIP_EXIT_ENABLED;
  });
  return flag;
};

describe('PAPER_FLIP_EXIT_ENABLED', () => {
  it('is off when the env is unset', () => {
    expect(loadFlag(undefined)).toBe(false);
  });
  it('is off for an explicit 0', () => {
    expect(loadFlag('0')).toBe(false);
  });
  it('turns on for 1 / true / yes / on', () => {
    for (const v of ['1', 'true', 'yes', 'on', ' ON ']) expect(loadFlag(v)).toBe(true);
  });
});
