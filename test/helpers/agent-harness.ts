/**
 * Agent integration-test harness.
 *
 * The agent layer (LeadAgent + specialized agents) reaches the LLM only through
 * the singleton `llmProvider` in lib/ai/llm-provider.ts, pulled in via dynamic
 * `import()` at call time. That single seam lets us run the whole orchestration
 * layer deterministically offline — no API keys, no network — by replacing the
 * module with a controllable fake via `jest.doMock`.
 *
 * Usage:
 *   const llm = installMockLLM(() => JSON.stringify({ action: 'hedge' }));
 *   // ... drive an agent; it will receive the mocked response ...
 *   expect(llm.calls.at(-1)?.method).toBe('generateDirectResponse');
 *
 * Call installMockLLM() in beforeEach so every test gets a clean responder.
 */
import { jest } from '@jest/globals';
import type { LLMResponse } from '@/lib/ai/llm-types';

type LLMMethod = 'generateResponse' | 'generateDirectResponse';
type Responder = (prompt: string) => string | Partial<LLMResponse>;

export interface MockLLMHandle {
  /** Every LLM call the agents made, in order. */
  readonly calls: Array<{ method: LLMMethod; prompt: string }>;
  /** Swap the canned response strategy mid-test. */
  setResponder(fn: Responder): void;
  /** Clear recorded calls (responder unchanged). */
  reset(): void;
}

/**
 * Replace lib/ai/llm-provider with a fake whose generateResponse /
 * generateDirectResponse return whatever `responder(prompt)` yields (a string
 * becomes `{ content }`). Returns a handle to inspect calls / change behavior.
 */
export function installMockLLM(initial?: Responder): MockLLMHandle {
  let responder: Responder = initial ?? (() => '{}');
  const calls: Array<{ method: LLMMethod; prompt: string }> = [];

  const handle: MockLLMHandle = {
    calls,
    setResponder(fn) { responder = fn; },
    reset() { calls.length = 0; },
  };

  const make = (method: LLMMethod) =>
    async (prompt: string): Promise<LLMResponse> => {
      calls.push({ method, prompt });
      const out = responder(prompt);
      const part = typeof out === 'string' ? { content: out } : out;
      return { content: '', model: 'mock-llm', confidence: 0.9, ...part } as LLMResponse;
    };

  // Reset the module cache so the next `await import(...)` picks up this
  // factory, even if a prior test in the file already imported the real one.
  jest.resetModules();
  jest.doMock('@/lib/ai/llm-provider', () => ({
    llmProvider: {
      generateResponse: make('generateResponse'),
      generateDirectResponse: make('generateDirectResponse'),
    },
    // Keep the class export present so `import { LLMProvider }` still type-checks.
    LLMProvider: class {},
  }));

  // 2026-09-21: LeadAgent's parseNaturalLanguage was refactored to route
  // through `reason()` in lib/services/ai/reasoner (which uses runWithTools
  // + a provider-abstract ChatClient). Without mocking that path, tests
  // that drive LeadAgent hit "no ASI_API_KEY" and get an empty response,
  // forcing keyword-fallback and defeating the mock's purpose. Record the
  // reason() invocation as 'generateDirectResponse' so existing tests that
  // assert on that method name keep passing.
  jest.doMock('@/lib/services/ai/reasoner', () => ({
    reason: async (opts: { userPrompt: string; systemPrompt?: string }) => {
      calls.push({ method: 'generateDirectResponse', prompt: opts.userPrompt });
      const out = responder(opts.userPrompt);
      const text = typeof out === 'string' ? out : ((out as Partial<LLMResponse>).content ?? '');
      return { ok: true, text, elapsedMs: 0 };
    },
  }));

  return handle;
}

/**
 * Restore all module/function mocks. Call in afterAll so the LLM mock cannot
 * leak into other test files during a full `bun jest` run.
 */
export function restoreAgentMocks(): void {
  jest.dontMock('@/lib/ai/llm-provider');
  jest.dontMock('@/lib/services/ai/reasoner');
  jest.resetModules();
}
