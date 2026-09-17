/**
 * Live agent status chat — asks the ZkWard status oracle (ASI + tools).
 * Read-only. Grounds every answer in live DB state via 6 agent tools.
 */
'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Bot, User, Loader2, Wrench, AlertCircle, ChevronDown } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ToolCall {
  tool: string;
  ok: boolean;
  latencyMs: number;
  argsPreview?: string;
  pending?: boolean;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  elapsedMs?: number;
  error?: boolean;
  streaming?: boolean;
  rateLimited?: boolean;
}

const QUICK_PROMPTS = [
  'Why did the trader stop opening positions?',
  'How is BTC doing right now?',
  'What did our last 5 hedges do?',
  'Is our AI predicting correctly this week?',
];

function AssistantMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        h1: ({ children }) => <h1 className="text-title-3 font-semibold text-label-primary mt-4 mb-2 first:mt-0">{children}</h1>,
        h2: ({ children }) => <h2 className="text-headline font-semibold text-label-primary mt-3 mb-2 first:mt-0">{children}</h2>,
        h3: ({ children }) => <h3 className="text-callout font-semibold text-label-primary mt-3 mb-1.5 first:mt-0">{children}</h3>,
        h4: ({ children }) => <h4 className="text-footnote font-semibold text-label-secondary mt-2 mb-1 first:mt-0">{children}</h4>,
        p: ({ children }) => <p className="text-body text-label-primary leading-relaxed mb-2 last:mb-0">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold text-label-primary">{children}</strong>,
        em: ({ children }) => <em className="text-label-secondary italic">{children}</em>,
        ul: ({ children }) => <ul className="list-disc pl-5 mb-2 last:mb-0 space-y-1 text-body text-label-primary">{children}</ul>,
        ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 last:mb-0 space-y-1 text-body text-label-primary">{children}</ol>,
        li: ({ children }) => <li className="leading-relaxed">{children}</li>,
        code: ({ className, children }) => {
          if (!className) {
            return <code className="px-1.5 py-0.5 rounded bg-system-bg-tertiary text-caption-1 font-mono text-ios-blue">{children}</code>;
          }
          return <code className={className}>{children}</code>;
        },
        pre: ({ children }) => <pre className="my-2 p-3 rounded-ios bg-system-bg-tertiary border border-separator-opaque/40 overflow-x-auto text-caption-1 font-mono">{children}</pre>,
        table: ({ children }) => (
          <div className="overflow-x-auto my-3 rounded-ios border border-separator-opaque/40">
            <table className="min-w-full text-caption-1">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-system-bg-secondary">{children}</thead>,
        tbody: ({ children }) => <tbody className="divide-y divide-separator-opaque/40 bg-system-bg-primary">{children}</tbody>,
        tr: ({ children }) => <tr>{children}</tr>,
        th: ({ children }) => <th className="px-3 py-1.5 text-left font-semibold text-label-primary whitespace-nowrap">{children}</th>,
        td: ({ children }) => <td className="px-3 py-1.5 text-label-primary">{children}</td>,
        blockquote: ({ children }) => <blockquote className="border-l-2 border-ios-blue pl-3 my-2 italic text-label-secondary">{children}</blockquote>,
        hr: () => <hr className="my-3 border-separator-opaque/40" />,
        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-ios-blue underline underline-offset-2 hover:opacity-80">{children}</a>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export function AgentLiveChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch('/api/agents/live-chat')
      .then(r => r.json())
      .then(j => setReady(!!j.ready))
      .catch(() => setReady(false));
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, pending]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [input]);

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || pending) return;
    const userId = `u-${Date.now()}`;
    const assistantId = `a-${Date.now()}`;
    let historySnapshot: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    setMessages(m => {
      historySnapshot = m
        .filter(msg => !msg.error && msg.content)
        .slice(-10)
        .map(msg => ({ role: msg.role, content: msg.content }));
      return [
        ...m,
        { id: userId, role: 'user', content: text },
        { id: assistantId, role: 'assistant', content: '', toolCalls: [], streaming: true },
      ];
    });
    setInput('');
    setPending(true);

    const patch = (updater: (msg: Message) => Message) => {
      setMessages(m => m.map(msg => (msg.id === assistantId ? updater(msg) : msg)));
    };

    try {
      const r = await fetch('/api/agents/live-chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text, history: historySnapshot }),
      });

      if (r.status === 429) {
        patch(msg => ({
          ...msg,
          content: 'Rate limited. Please wait ~30s before asking again.',
          error: true,
          rateLimited: true,
          streaming: false,
        }));
        return;
      }
      if (!r.ok || !r.body) {
        patch(msg => ({
          ...msg,
          content: `Request failed (HTTP ${r.status}).`,
          error: true,
          streaming: false,
        }));
        return;
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
          if (!line) continue;
          let event: {
            type: string;
            delta?: string;
            tool?: string;
            ok?: boolean;
            latencyMs?: number;
            argsPreview?: string;
            error?: string;
            elapsedMs?: number;
            message?: string;
          };
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event.type === 'token' && typeof event.delta === 'string') {
            const delta = event.delta;
            patch(msg => ({ ...msg, content: msg.content + delta }));
          } else if (event.type === 'tool_start' && event.tool) {
            const tool = event.tool;
            const argsPreview = event.argsPreview || '';
            patch(msg => ({
              ...msg,
              toolCalls: [
                ...(msg.toolCalls || []),
                { tool, ok: false, latencyMs: 0, argsPreview, pending: true } as ToolCall & { pending?: boolean },
              ],
            }));
          } else if (event.type === 'tool_end' && event.tool) {
            const tool = event.tool;
            const ok = !!event.ok;
            const latencyMs = event.latencyMs ?? 0;
            patch(msg => {
              const list = [...(msg.toolCalls || [])];
              const idx = list.findIndex(
                (t) => t.tool === tool && (t as ToolCall & { pending?: boolean }).pending,
              );
              if (idx >= 0) {
                const prev = list[idx] as ToolCall & { pending?: boolean };
                list[idx] = { ...prev, ok, latencyMs, pending: false };
              } else {
                list.push({ tool, ok, latencyMs, argsPreview: '' });
              }
              return { ...msg, toolCalls: list };
            });
          } else if (event.type === 'done') {
            patch(msg => ({ ...msg, elapsedMs: event.elapsedMs, streaming: false }));
          } else if (event.type === 'error') {
            const errMessage = event.message || 'stream error';
            patch(msg => ({
              ...msg,
              content: msg.content || errMessage,
              error: true,
              streaming: false,
            }));
          }
        }
      }
    } catch (e) {
      patch(msg => ({
        ...msg,
        content: e instanceof Error ? e.message : 'Network error',
        error: true,
        streaming: false,
      }));
    } finally {
      setPending(false);
      patch(msg => (msg.streaming ? { ...msg, streaming: false } : msg));
    }
  }, [pending]);

  if (ready === false) {
    return (
      <div className="bg-system-bg-secondary rounded-ios-xl p-6 border border-separator-opaque/40 text-center">
        <AlertCircle className="w-6 h-6 text-ios-orange mx-auto mb-2" />
        <p className="text-callout text-label-secondary">
          Status oracle not configured (waiting on <code className="text-caption-1">ASI_API_KEY</code> in prod).
        </p>
      </div>
    );
  }

  return (
    <div className="bg-system-bg-primary rounded-ios-xl border border-separator-opaque/40 shadow-ios-1 overflow-hidden flex flex-col h-[min(80vh,720px)] min-h-[420px]">
      <div className="border-b border-separator-opaque/40 px-4 sm:px-5 py-3 sm:py-4 flex-shrink-0">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-ios-blue" />
          <h3 className="text-headline font-semibold text-label-primary">Ask the status oracle</h3>
          <span className="ml-auto text-caption-2 text-label-tertiary hidden sm:inline">
            read-only · 6 tools
          </span>
        </div>
        <p className="text-footnote text-label-tertiary mt-1">
          Grounds every answer in live DB state.
        </p>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 sm:px-5 py-4 space-y-4">
        {messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-callout text-label-tertiary">Try one of these:</p>
            <div className="flex flex-wrap gap-2">
              {QUICK_PROMPTS.map(p => (
                <button
                  key={p}
                  onClick={() => send(p)}
                  disabled={pending}
                  className="text-footnote px-3 py-1.5 rounded-full bg-system-bg-secondary border border-separator-opaque/40 text-label-secondary hover:text-label-primary hover:border-ios-blue/50 transition-colors disabled:opacity-50"
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map(m => (
          <div key={m.id} className={`flex gap-2 sm:gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div
              className={`w-7 h-7 sm:w-8 sm:h-8 rounded-ios flex items-center justify-center flex-shrink-0 ${
                m.role === 'user'
                  ? 'bg-ios-blue/10 text-ios-blue'
                  : m.error
                  ? 'bg-ios-red/10 text-red-700'
                  : 'bg-ios-green/10 text-ios-green'
              }`}
            >
              {m.role === 'user' ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
            </div>
            <div className={`min-w-0 max-w-[calc(100%-2.75rem)] sm:max-w-[calc(100%-3rem)] ${m.role === 'user' ? 'flex flex-col items-end' : 'flex-1'}`}>
              <div
                className={`px-3.5 py-2.5 rounded-ios ${
                  m.role === 'user'
                    ? 'inline-block max-w-full bg-ios-blue text-white text-body whitespace-pre-wrap break-words'
                    : m.error
                    ? `inline-block max-w-full ${m.rateLimited ? 'bg-ios-orange/10 text-orange-700' : 'bg-ios-red/10 text-red-700'} text-body whitespace-pre-wrap break-words`
                    : 'w-full bg-system-bg-secondary text-label-primary break-words'
                }`}
              >
                {m.role === 'assistant' && !m.error ? (
                  <>
                    {m.content ? <AssistantMarkdown content={m.content} /> : null}
                    {m.streaming && !m.content && (
                      <span className="inline-flex items-center gap-2 text-label-tertiary text-body">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>thinking…</span>
                      </span>
                    )}
                    {m.streaming && m.content && (
                      <span className="inline-block w-2 h-4 bg-ios-blue ml-0.5 align-middle animate-pulse" />
                    )}
                  </>
                ) : (
                  m.content
                )}
              </div>
              {m.toolCalls && m.toolCalls.length > 0 && (
                <details className="mt-2 text-caption-1 text-label-tertiary group" open={m.streaming}>
                  <summary className="inline-flex items-center gap-1 cursor-pointer hover:text-label-secondary select-none list-none">
                    <Wrench className="w-3 h-3" />
                    <span>
                      {m.toolCalls.length} tool call{m.toolCalls.length === 1 ? '' : 's'}
                      {m.elapsedMs ? ` · ${m.elapsedMs}ms` : ''}
                    </span>
                    <ChevronDown className="w-3 h-3 group-open:rotate-180 transition-transform" />
                  </summary>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 pl-4">
                    {m.toolCalls.map((t, i) => (
                      <span
                        key={i}
                        className={`inline-flex items-center gap-1 font-mono ${
                          t.pending ? 'text-label-tertiary' : t.ok ? 'text-ios-green' : 'text-red-700'
                        }`}
                      >
                        {t.pending && <Loader2 className="w-3 h-3 animate-spin" />}
                        {t.tool}
                        {t.pending ? '...' : `(${t.ok ? 'ok' : 'err'}) ${t.latencyMs}ms`}
                      </span>
                    ))}
                  </div>
                </details>
              )}
            </div>
          </div>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="border-t border-separator-opaque/40 px-3 sm:px-5 py-3 flex gap-2 items-end flex-shrink-0 bg-system-bg-primary"
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(input);
            }
          }}
          rows={1}
          placeholder="Ask about hedges, treasury, signals... (Enter to send, Shift+Enter for newline)"
          disabled={pending || ready !== true}
          className="flex-1 px-3 py-2 rounded-ios bg-system-bg-secondary text-label-primary placeholder-label-tertiary border border-separator-opaque/40 focus:border-ios-blue focus:outline-none text-body disabled:opacity-50 resize-none max-h-[180px] min-h-[38px] leading-snug"
        />
        <button
          type="submit"
          disabled={pending || !input.trim() || ready !== true}
          className="px-3 sm:px-4 py-2 rounded-ios bg-ios-blue text-white font-medium text-callout disabled:opacity-40 disabled:cursor-not-allowed hover:bg-ios-blue/90 transition-colors flex items-center gap-2 flex-shrink-0 min-h-[38px]"
          aria-label="Send"
        >
          {pending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          <span className="hidden sm:inline">{pending ? 'Sending' : 'Ask'}</span>
        </button>
      </form>
    </div>
  );
}
