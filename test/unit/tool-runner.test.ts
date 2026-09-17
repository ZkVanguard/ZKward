/**
 * Tool-runner tests — locks the loop shape without hitting real OpenAI.
 * Injects a scripted ChatClient so the runner never imports the real SDK.
 */
import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import type { ChatClient } from '@/lib/services/ai/tool-runner';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  jest.resetModules();
});

function scriptedClient(responses: any[]): ChatClient {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          const r = responses[i++];
          if (!r) throw new Error(`no scripted response for turn ${i}`);
          return r;
        },
      },
    },
  };
}

describe('tool-runner', () => {
  beforeEach(() => {
    process.env.ASI_API_KEY = 'test-key';
  });

  it('returns no-op when no client + no ASI_API_KEY', async () => {
    delete process.env.ASI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    jest.resetModules();
    const { runWithTools } = await import('@/lib/services/ai/tool-runner');
    const r = await runWithTools({ systemPrompt: 'x', userPrompt: 'y' });
    expect(r.finalText).toBe('');
    expect(r.finishedNormally).toBe(false);
  });

  it('dispatches a tool call and loops until stop', async () => {
    jest.doMock('@/lib/services/market-data/unified-price-provider', () => ({
      getMultiSourceValidatedPrice: async () => ({
        price: 68000,
        confidence: 'high',
        sources: [1, 2, 3],
      }),
    }));
    jest.resetModules();

    const client = scriptedClient([
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'get_asset_price',
                    arguments: JSON.stringify({ asset: 'BTC' }),
                  },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: 'stop',
            message: { content: 'BTC price is retrieved.', tool_calls: null },
          },
        ],
      },
    ]);

    const { runWithTools } = await import('@/lib/services/ai/tool-runner');
    const r = await runWithTools({
      systemPrompt: 'you are test',
      userPrompt: 'what is BTC?',
      client,
    });

    expect(r.finishedNormally).toBe(true);
    expect(r.iterations).toBe(2);
    expect(r.finalText).toBe('BTC price is retrieved.');
    expect(r.invocations).toHaveLength(1);
    expect(r.invocations[0].tool).toBe('get_asset_price');
    expect(r.invocations[0].ok).toBe(true);
    expect(r.invocations[0].args).toEqual({ asset: 'BTC' });
  });

  it('caps at maxIterations if the model keeps requesting tools', async () => {
    jest.doMock('@/lib/services/market-data/unified-price-provider', () => ({
      getMultiSourceValidatedPrice: async () => ({
        price: 68000,
        confidence: 'high',
        sources: [1, 2, 3],
      }),
    }));
    jest.resetModules();

    const looper = {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_x',
                type: 'function',
                function: {
                  name: 'get_asset_price',
                  arguments: JSON.stringify({ asset: 'BTC' }),
                },
              },
            ],
          },
        },
      ],
    };
    const client = scriptedClient([looper, looper, looper, looper, looper]);

    const { runWithTools } = await import('@/lib/services/ai/tool-runner');
    const r = await runWithTools({
      systemPrompt: 't',
      userPrompt: 't',
      maxIterations: 3,
      client,
    });
    expect(r.finishedNormally).toBe(false);
    expect(r.iterations).toBe(3);
    expect(r.invocations).toHaveLength(3);
  });

  it('rejects tool args over 16 KB', async () => {
    const bigArgs = JSON.stringify({ blob: 'x'.repeat(20 * 1024) });
    const client = scriptedClient([
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_big',
                  type: 'function',
                  function: { name: 'get_asset_price', arguments: bigArgs },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ finish_reason: 'stop', message: { content: 'done', tool_calls: null } }],
      },
    ]);

    const { runWithTools } = await import('@/lib/services/ai/tool-runner');
    const r = await runWithTools({ systemPrompt: 't', userPrompt: 't', client });
    expect(r.invocations[0].ok).toBe(false);
    expect(r.invocations[0].error).toMatch(/16384 bytes/);
  });

  it('surfaces unknown-tool errors as observations, not crashes', async () => {
    const client = scriptedClient([
      {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_bad',
                  type: 'function',
                  function: { name: 'nonexistent_tool', arguments: '{}' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { finish_reason: 'stop', message: { content: 'recovered', tool_calls: null } },
        ],
      },
    ]);

    const { runWithTools } = await import('@/lib/services/ai/tool-runner');
    const r = await runWithTools({ systemPrompt: 't', userPrompt: 't', client });
    expect(r.finishedNormally).toBe(true);
    expect(r.invocations[0].ok).toBe(false);
    expect(r.invocations[0].error).toMatch(/unknown tool/);
    expect(r.finalText).toBe('recovered');
  });
});
