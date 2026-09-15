/**
 * Signal Interpreter tests.
 *
 * Locks the regex fallback so a model outage doesn't degrade to nothing.
 * Model path is exercised via a mocked fetch — we don't want tests to
 * require a running Ollama server.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

afterEach(() => {
  global.fetch = originalFetch;
  process.env = { ...originalEnv };
  jest.resetModules();
});

async function loadInterpreter() {
  jest.resetModules();
  return await import('@/lib/services/ai/signal-interpreter');
}

describe('signal-interpreter — regex fallback (SIGNAL_INTERPRETER_ENABLED off)', () => {
  beforeEach(() => {
    delete process.env.SIGNAL_INTERPRETER_ENABLED;
  });

  it('extracts BTC + UP + threshold from "Will Bitcoin be above $68,000 on Sep 15?"', async () => {
    const { interpretSignal } = await loadInterpreter();
    const s = await interpretSignal('Will Bitcoin be above $68,000 on September 15?');
    expect(s.asset).toBe('BTC');
    expect(s.direction).toBe('UP');
    expect(s.threshold).toBe(68000);
    expect(s.source).toBe('regex-fallback');
  });

  it('extracts ETH + DOWN from "Will ETH drop below $3000 this week?"', async () => {
    const { interpretSignal } = await loadInterpreter();
    const s = await interpretSignal('Will ETH drop below $3000 this week?');
    expect(s.asset).toBe('ETH');
    expect(s.direction).toBe('DOWN');
    expect(s.threshold).toBe(3000);
    expect(s.horizon).toBe('weekly');
  });

  it('parses "$100K" style thresholds', async () => {
    const { interpretSignal } = await loadInterpreter();
    const s = await interpretSignal('Will BTC hit $100K by end of year?');
    expect(s.threshold).toBe(100_000);
    expect(s.horizon).toBe('longer');
  });

  it('returns asset=null for non-crypto titles', async () => {
    const { interpretSignal } = await loadInterpreter();
    const s = await interpretSignal('Will the Fed cut rates in December?');
    expect(s.asset).toBeNull();
  });

  it('never throws on empty title', async () => {
    const { interpretSignal } = await loadInterpreter();
    const s = await interpretSignal('');
    expect(s.asset).toBeNull();
    expect(s.direction).toBe('NEUTRAL');
    expect(s.source).toBe('regex-fallback');
  });

  it('regex fallback still emits an empty meta object (shape consistency)', async () => {
    const { interpretSignal } = await loadInterpreter();
    const s = await interpretSignal('Will Bitcoin be above $68,000?');
    expect(s.meta).toBeDefined();
    expect(s.meta?.novelty).toBe(0);
    expect(s.meta?.improvement_ask).toBe('');
  });

  it('preserves opts.endDate in horizon_end', async () => {
    const { interpretSignal } = await loadInterpreter();
    const s = await interpretSignal('Will BTC be above $68K?', { endDate: '2026-09-15T00:00:00Z' });
    expect(s.horizon_end).toBe('2026-09-15T00:00:00Z');
  });
});

describe('signal-interpreter — model path (SIGNAL_INTERPRETER_ENABLED=1)', () => {
  beforeEach(() => {
    process.env.SIGNAL_INTERPRETER_ENABLED = '1';
  });

  it('uses model response when it returns valid JSON with meta', async () => {
    global.fetch = jest.fn<any>(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  asset: 'ETH',
                  direction: 'DOWN',
                  threshold: 3200,
                  horizon: 'weekly',
                  horizon_end: null,
                  confidence: 0.87,
                  reasoning: 'ETH below threshold price question.',
                  meta: {
                    novelty: 0.2,
                    improvement_ask: 'timezone context would clarify week boundary',
                    generalization_note: 'weekly ETH threshold pattern common',
                  },
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    ) as any;
    const { interpretSignal } = await loadInterpreter();
    const s = await interpretSignal('Will ETH drop below $3200 this week?');
    expect(s.source).toBe('model');
    expect(s.asset).toBe('ETH');
    expect(s.direction).toBe('DOWN');
    expect(s.threshold).toBe(3200);
    expect(s.confidence).toBeCloseTo(0.87);
    expect(s.meta?.novelty).toBeCloseTo(0.2);
    expect(s.meta?.improvement_ask).toMatch(/timezone/);
    expect(s.meta?.generalization_note).toMatch(/weekly ETH/);
  });

  it('surfaces empty meta when model omits it (backward-compat)', async () => {
    global.fetch = jest.fn<any>(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  asset: 'BTC',
                  direction: 'UP',
                  threshold: 68000,
                  horizon: 'daily',
                  horizon_end: null,
                  confidence: 0.9,
                  reasoning: 'clean price target',
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    ) as any;
    const { interpretSignal } = await loadInterpreter();
    const s = await interpretSignal('Will BTC be above $68K today?');
    expect(s.source).toBe('model');
    // Meta must always be present so downstream code doesn't NPE
    expect(s.meta).toBeDefined();
    expect(s.meta?.novelty).toBe(0);
    expect(s.meta?.improvement_ask).toBe('');
    expect(s.meta?.generalization_note).toBe('');
  });

  it('falls back to regex when model returns non-JSON', async () => {
    global.fetch = jest.fn<any>(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'I do not know.' } }],
        }),
        { status: 200 },
      ),
    ) as any;
    const { interpretSignal } = await loadInterpreter();
    const s = await interpretSignal('Will Bitcoin be above $68K?');
    expect(s.source).toBe('regex-fallback');
    expect(s.asset).toBe('BTC');
  });

  it('falls back to regex on network failure', async () => {
    global.fetch = jest.fn<any>(async () => {
      throw new Error('ECONNREFUSED');
    }) as any;
    const { interpretSignal } = await loadInterpreter();
    const s = await interpretSignal('Will SOL hit $200?');
    expect(s.source).toBe('regex-fallback');
    expect(s.asset).toBe('SOL');
  });

  it('falls back to regex when model returns 500', async () => {
    global.fetch = jest.fn<any>(async () =>
      new Response('server error', { status: 500 }),
    ) as any;
    const { interpretSignal } = await loadInterpreter();
    const s = await interpretSignal('Will BTC be below $60K?');
    expect(s.source).toBe('regex-fallback');
    expect(s.direction).toBe('DOWN');
  });

  it('coerces bad enum values in model output to safe defaults', async () => {
    global.fetch = jest.fn<any>(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  asset: 'btc',
                  direction: 'MOON', // not a valid enum
                  threshold: 68000,
                  horizon: 'quarterly', // not valid
                  confidence: 5, // out of range
                  reasoning: 'x',
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    ) as any;
    const { interpretSignal } = await loadInterpreter();
    const s = await interpretSignal('Will BTC hit $68K?');
    expect(s.asset).toBe('BTC'); // uppercased
    expect(s.direction).toBe('NEUTRAL'); // MOON → default
    expect(s.horizon).toBe('unknown');
    expect(s.confidence).toBe(1); // clamped to [0,1]
  });
});
