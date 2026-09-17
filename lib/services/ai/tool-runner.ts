/**
 * Tool-use runner for Layer 3 specialized agents.
 *
 * Wraps OpenAI-compatible chat-completions tool-use API into a bounded
 * loop:
 *   1. Send messages + tool schemas
 *   2. If model returns tool_calls, execute each, append observations
 *   3. Loop until finish_reason=stop or maxIterations
 *
 * ## Provider chain (ASI-only — this stack has no OpenAI dependency)
 *
 *   1. Injected client (tests)
 *   2. ASI:One — Fetch.ai's LLM, OpenAI-compat API. Tool-use capable.
 *      ENV: ASI_API_KEY. Model: ASI_MODEL (default asi1-mini).
 *      URL: ASI_API_URL (default https://api.asi1.ai/v1).
 *   3. No-op — key not set, callers get empty finalText.
 *
 * The `openai` npm package is used as a THIN CLIENT for ASI's OpenAI-
 * compat API (custom baseURL). We never call api.openai.com.
 *
 * ## Why not the fine-tuned Qwen 2.5 7B
 *
 * That model is fine-tuned to emit ONE narrow JSON schema. Multi-turn
 * tool-call syntax conflicts with its training objective; reliability
 * craters. Empirically measured this session: 0 tool_calls emitted,
 * hallucinated summary returned. Keep the fine-tune as a Layer 1
 * specialist that tools *call*, not a Layer 3 reasoner that calls tools.
 *
 * ## Safety
 *
 *   - maxIterations (default 5) caps runaway loops
 *   - All tools are read-only per agent-tools.ts contract
 *   - Tool arg JSON capped at 16 KB before execution
 *   - Failed tools surface as `{ ok: false, error }` observation, never throw
 */

import { CONSTITUTION_PREAMBLE } from './model-constitution';
import {
  DEFAULT_AGENT_TOOLS,
  toolByName,
  toolsToOpenAiSchema,
  runTool,
  type AgentTool,
} from './agent-tools';
import { logger } from '@/lib/utils/logger';

const MAX_TOOL_ARG_BYTES = 16 * 1024;
const DEFAULT_MAX_ITERATIONS = 5;

interface ResolvedProvider {
  client: ChatClient;
  model: string;
  name: string;
}

/** Resolve provider from env. ASI-only — this stack does NOT use OpenAI. */
async function resolveProvider(): Promise<ResolvedProvider | null> {
  const asiKey = (process.env.ASI_API_KEY || '').trim();
  if (!asiKey) return null;
  const OpenAI = (await import('openai')).default;
  const asiUrl = (process.env.ASI_API_URL || 'https://api.asi1.ai/v1').trim();
  const asiModel = (process.env.ASI_MODEL || 'asi1-mini').trim();
  const raw = new OpenAI({ apiKey: asiKey, baseURL: asiUrl });
  return { client: raw as unknown as ChatClient, model: asiModel, name: 'asi' };
}

export interface ToolInvocation {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  result?: unknown;
  error?: string;
  latencyMs: number;
}

export interface RunWithToolsResult {
  finalText: string;
  invocations: ToolInvocation[];
  iterations: number;
  finishedNormally: boolean;
}

/** Minimal client shape we need — lets tests inject a stub without
 *  monkey-patching the openai module. Real callers omit and get the
 *  auto-instantiated OpenAI client. */
export interface ChatClient {
  chat: {
    completions: {
      create: (payload: {
        model: string;
        messages: Array<Record<string, unknown>>;
        tools: unknown[];
        tool_choice: 'auto' | 'none';
      }) => Promise<{
        choices: Array<{
          finish_reason?: string;
          message: {
            content?: string | null;
            tool_calls?: Array<{
              id: string;
              type: 'function';
              function: { name?: string; arguments?: string };
            }> | null;
          };
        }>;
      }>;
    };
  };
}

/** Prior conversation turn — plain string content only. Tool call replay
 *  isn't supported (would require full round-trip storage); the chat is
 *  designed to re-fetch fresh state each user turn instead. */
export interface HistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface RunWithToolsOptions {
  systemPrompt: string;
  userPrompt: string;
  tools?: AgentTool[];
  model?: string;
  maxIterations?: number;
  /** Prior conversation turns to prepend before the current user prompt. */
  priorMessages?: HistoryTurn[];
  /** Optional injected chat client. When absent, tries OPENAI_API_KEY. */
  client?: ChatClient;
}

// ── Streaming variant ─────────────────────────────────────────────────

export type StreamEvent =
  | { type: 'iteration'; n: number }
  | { type: 'token'; delta: string }
  | { type: 'tool_start'; tool: string; argsPreview: string }
  | { type: 'tool_end'; tool: string; ok: boolean; latencyMs: number; error?: string }
  | { type: 'done'; elapsedMs: number; iterations: number; finalText: string }
  | { type: 'error'; message: string };

interface StreamingChatClient {
  chat: {
    completions: {
      create: (payload: {
        model: string;
        messages: Array<Record<string, unknown>>;
        tools: unknown[];
        tool_choice: 'auto' | 'none';
        stream: true;
      }) => Promise<AsyncIterable<{
        choices: Array<{
          finish_reason?: string | null;
          delta: {
            content?: string | null;
            tool_calls?: Array<{
              index: number;
              id?: string;
              type?: 'function';
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      }>>;
    };
  };
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

/** Main entry point. Returns text + everything the agent looked up. */
export async function runWithTools(opts: RunWithToolsOptions): Promise<RunWithToolsResult> {
  const tools = opts.tools ?? DEFAULT_AGENT_TOOLS;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  let client: ChatClient;
  let model: string;
  let providerName = 'injected';

  if (opts.client) {
    client = opts.client;
    model = opts.model ?? 'injected';
  } else {
    const resolved = await resolveProvider();
    if (!resolved) {
      logger.warn('[ToolRunner] ASI_API_KEY unset — tool-use disabled, returning no-op');
      return {
        finalText: '',
        invocations: [],
        iterations: 0,
        finishedNormally: false,
      };
    }
    client = resolved.client;
    model = opts.model ?? resolved.model;
    providerName = resolved.name;
    logger.info('[ToolRunner] using provider', { provider: providerName, model });
  }

  const messages: Array<Record<string, unknown>> = [
    {
      role: 'system',
      content: `${CONSTITUTION_PREAMBLE}\n\n────\n\n${opts.systemPrompt}`,
    },
    ...(opts.priorMessages ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: opts.userPrompt },
  ];

  const openAiTools = toolsToOpenAiSchema(tools);
  const invocations: ToolInvocation[] = [];
  let finishedNormally = false;
  let finalText = '';

  for (let iter = 1; iter <= maxIterations; iter++) {
    const resp = await client.chat.completions.create({
      model,
      messages,
      tools: openAiTools,
      tool_choice: 'auto',
    });
    const choice = resp.choices[0];
    if (!choice) break;

    const msg = choice.message;
    // Append the assistant turn (may contain tool_calls).
    messages.push({
      role: 'assistant',
      content: msg.content ?? '',
      ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
    });

    if (choice.finish_reason === 'stop' || !msg.tool_calls || msg.tool_calls.length === 0) {
      finalText = msg.content ?? '';
      finishedNormally = true;
      return { finalText, invocations, iterations: iter, finishedNormally };
    }

    // Dispatch every tool call.
    for (const call of msg.tool_calls) {
      const name = call.function?.name;
      const argsJson = call.function?.arguments ?? '{}';
      let args: Record<string, unknown> = {};

      if (argsJson.length > MAX_TOOL_ARG_BYTES) {
        invocations.push({
          tool: name ?? 'unknown',
          args: {},
          ok: false,
          error: `tool args exceeded ${MAX_TOOL_ARG_BYTES} bytes`,
          latencyMs: 0,
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: 'args too large' }),
        });
        continue;
      }

      try {
        args = JSON.parse(argsJson);
      } catch {
        invocations.push({
          tool: name ?? 'unknown',
          args: {},
          ok: false,
          error: 'unparseable arguments',
          latencyMs: 0,
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: 'unparseable arguments' }),
        });
        continue;
      }

      const tool = toolByName(tools, name ?? '');
      if (!tool) {
        invocations.push({
          tool: name ?? 'unknown',
          args,
          ok: false,
          error: `unknown tool: ${name}`,
          latencyMs: 0,
        });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: `unknown tool: ${name}` }),
        });
        continue;
      }

      const t0 = Date.now();
      const result = await runTool(tool, args);
      const latencyMs = Date.now() - t0;

      if (result.ok) {
        invocations.push({ tool: tool.name, args, ok: true, result: result.result, latencyMs });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result.result).slice(0, 32 * 1024),
        });
      } else {
        invocations.push({ tool: tool.name, args, ok: false, error: result.error, latencyMs });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: result.error }),
        });
      }
    }
  }

  logger.warn('[ToolRunner] hit maxIterations without stop', {
    maxIterations,
    invocationCount: invocations.length,
  });
  return { finalText, invocations, iterations: maxIterations, finishedNormally };
}

// ── Streaming entry point ─────────────────────────────────────────────

/**
 * Streaming variant — yields StreamEvents so callers can display tokens
 * as they arrive. Behaviour otherwise mirrors runWithTools: same tool
 * dispatch, same iteration cap, same message accumulation.
 */
export async function* runWithToolsStream(
  opts: RunWithToolsOptions,
): AsyncGenerator<StreamEvent, void, void> {
  const started = Date.now();
  const tools = opts.tools ?? DEFAULT_AGENT_TOOLS;
  const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  const resolved = await resolveProvider();
  if (!resolved) {
    logger.warn('[ToolRunner:stream] ASI_API_KEY unset — no-op stream');
    yield {
      type: 'done',
      elapsedMs: Date.now() - started,
      iterations: 0,
      finalText: '',
    };
    return;
  }
  const client = resolved.client as unknown as StreamingChatClient;
  const model = opts.model ?? resolved.model;

  const messages: Array<Record<string, unknown>> = [
    {
      role: 'system',
      content: `${CONSTITUTION_PREAMBLE}\n\n────\n\n${opts.systemPrompt}`,
    },
    ...(opts.priorMessages ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: opts.userPrompt },
  ];
  const openAiTools = toolsToOpenAiSchema(tools);
  let finalText = '';

  for (let iter = 1; iter <= maxIterations; iter++) {
    yield { type: 'iteration', n: iter };

    let stream;
    try {
      stream = await client.chat.completions.create({
        model,
        messages,
        tools: openAiTools,
        tool_choice: 'auto',
        stream: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[ToolRunner:stream] provider error', { error: msg });
      yield { type: 'error', message: msg };
      yield {
        type: 'done',
        elapsedMs: Date.now() - started,
        iterations: iter,
        finalText,
      };
      return;
    }

    let assistantContent = '';
    const accumulated: AccumulatedToolCall[] = [];
    let finishReason: string | null | undefined;

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;

      if (delta.content) {
        assistantContent += delta.content;
        yield { type: 'token', delta: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!accumulated[idx]) {
            accumulated[idx] = { id: '', name: '', argumentsJson: '' };
          }
          if (tc.id) accumulated[idx].id = tc.id;
          if (tc.function?.name) accumulated[idx].name += tc.function.name;
          if (tc.function?.arguments) accumulated[idx].argumentsJson += tc.function.arguments;
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason;
      }
    }

    const toolCalls = accumulated.filter((c) => c.name);
    messages.push({
      role: 'assistant',
      content: assistantContent,
      ...(toolCalls.length > 0
        ? {
            tool_calls: toolCalls.map((c) => ({
              id: c.id,
              type: 'function',
              function: { name: c.name, arguments: c.argumentsJson || '{}' },
            })),
          }
        : {}),
    });

    if (toolCalls.length === 0 || finishReason === 'stop') {
      finalText = assistantContent;
      yield {
        type: 'done',
        elapsedMs: Date.now() - started,
        iterations: iter,
        finalText,
      };
      return;
    }

    for (const call of toolCalls) {
      const argsJson = call.argumentsJson || '{}';
      let args: Record<string, unknown> = {};

      if (argsJson.length > MAX_TOOL_ARG_BYTES) {
        yield {
          type: 'tool_end',
          tool: call.name,
          ok: false,
          latencyMs: 0,
          error: `args exceeded ${MAX_TOOL_ARG_BYTES} bytes`,
        };
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: 'args too large' }),
        });
        continue;
      }

      try {
        args = JSON.parse(argsJson);
      } catch {
        yield {
          type: 'tool_end',
          tool: call.name,
          ok: false,
          latencyMs: 0,
          error: 'unparseable arguments',
        };
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: 'unparseable arguments' }),
        });
        continue;
      }

      yield {
        type: 'tool_start',
        tool: call.name,
        argsPreview: argsJson.slice(0, 200),
      };

      const tool = toolByName(tools, call.name);
      if (!tool) {
        yield {
          type: 'tool_end',
          tool: call.name,
          ok: false,
          latencyMs: 0,
          error: `unknown tool: ${call.name}`,
        };
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: `unknown tool: ${call.name}` }),
        });
        continue;
      }

      const t0 = Date.now();
      const result = await runTool(tool, args);
      const latencyMs = Date.now() - t0;

      if (result.ok) {
        yield { type: 'tool_end', tool: tool.name, ok: true, latencyMs };
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result.result).slice(0, 32 * 1024),
        });
      } else {
        yield { type: 'tool_end', tool: tool.name, ok: false, latencyMs, error: result.error };
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({ error: result.error }),
        });
      }
    }
  }

  logger.warn('[ToolRunner:stream] hit maxIterations without stop', { maxIterations });
  yield {
    type: 'done',
    elapsedMs: Date.now() - started,
    iterations: maxIterations,
    finalText,
  };
}
