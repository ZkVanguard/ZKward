/**
 * Live agent status chat — asks the ZkWard status oracle (ASI + tools)
 * about platform state and current agent activity.
 *
 * Backed by /api/agents/live-chat which runs a bounded tool-use loop
 * over the 6 read-only agent tools (interpretations, hedges, prices,
 * cron_state, postmortem stats, treasury). Read-only — the oracle
 * cannot open trades or move funds.
 */
'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Bot, User, Loader2, Wrench, AlertCircle } from 'lucide-react';

interface ToolCall {
  tool: string;
  ok: boolean;
  latencyMs: number;
  argsPreview: string;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  elapsedMs?: number;
  error?: boolean;
}

const QUICK_PROMPTS = [
  'Why did the trader stop opening positions?',
  'How is BTC doing right now?',
  'What did our last 5 hedges do?',
  'Is our AI predicting correctly this week?',
  'Can we afford another training run?',
];

export function AgentLiveChat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/agents/live-chat', { method: 'GET' })
      .then(r => r.json())
      .then(j => setReady(!!j.ready))
      .catch(() => setReady(false));
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, pending]);

  const send = useCallback(async (raw: string) => {
    const text = raw.trim();
    if (!text || pending) return;
    const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', content: text };
    setMessages(m => [...m, userMsg]);
    setInput('');
    setPending(true);
    try {
      const r = await fetch('/api/agents/live-chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const j = await r.json();
      setMessages(m => [
        ...m,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: j.answer || j.error || '(no response)',
          toolCalls: j.toolCalls,
          elapsedMs: j.elapsedMs,
          error: !r.ok || !j.healthy,
        },
      ]);
    } catch (e) {
      setMessages(m => [
        ...m,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          content: e instanceof Error ? e.message : 'Network error',
          error: true,
        },
      ]);
    } finally {
      setPending(false);
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
    <div className="bg-system-bg-primary rounded-ios-xl border border-separator-opaque/40 shadow-ios-1 overflow-hidden">
      <div className="border-b border-separator-opaque/40 px-5 py-4">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-ios-blue" />
          <h3 className="text-headline font-semibold text-label-primary">Ask the status oracle</h3>
        </div>
        <p className="text-footnote text-label-tertiary mt-1">
          Read-only. Grounds every answer in live DB state via the 6 agent tools.
        </p>
      </div>

      <div ref={scrollRef} className="max-h-[420px] min-h-[220px] overflow-y-auto px-5 py-4 space-y-4">
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
          <div key={m.id} className={`flex gap-3 ${m.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div
              className={`w-8 h-8 rounded-ios flex items-center justify-center flex-shrink-0 ${
                m.role === 'user'
                  ? 'bg-ios-blue/10 text-ios-blue'
                  : m.error
                  ? 'bg-ios-red/10 text-red-700'
                  : 'bg-ios-green/10 text-ios-green'
              }`}
            >
              {m.role === 'user' ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4" />}
            </div>
            <div className={`flex-1 min-w-0 ${m.role === 'user' ? 'text-right' : ''}`}>
              <div
                className={`inline-block max-w-[95%] px-4 py-2.5 rounded-ios text-body leading-relaxed whitespace-pre-wrap ${
                  m.role === 'user'
                    ? 'bg-ios-blue text-white'
                    : m.error
                    ? 'bg-ios-red/10 text-red-700'
                    : 'bg-system-bg-secondary text-label-primary'
                }`}
              >
                {m.content}
              </div>
              {m.toolCalls && m.toolCalls.length > 0 && (
                <div className="mt-2 text-caption-1 text-label-tertiary flex flex-wrap gap-x-3 gap-y-1">
                  <span className="inline-flex items-center gap-1">
                    <Wrench className="w-3 h-3" />
                    {m.toolCalls.length} tool call{m.toolCalls.length === 1 ? '' : 's'} · {m.elapsedMs}ms
                  </span>
                  {m.toolCalls.map((t, i) => (
                    <span
                      key={i}
                      className={`inline-flex items-center gap-1 font-mono ${
                        t.ok ? 'text-ios-green' : 'text-red-700'
                      }`}
                    >
                      {t.tool}({t.ok ? 'ok' : 'err'})
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {pending && (
          <div className="flex gap-3">
            <div className="w-8 h-8 rounded-ios bg-ios-green/10 text-ios-green flex items-center justify-center flex-shrink-0">
              <Loader2 className="w-4 h-4 animate-spin" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="inline-block px-4 py-2.5 rounded-ios bg-system-bg-secondary text-label-tertiary text-body">
                Querying live state...
              </div>
            </div>
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
        className="border-t border-separator-opaque/40 px-5 py-4 flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about hedges, treasury, signals, cron state..."
          disabled={pending || ready !== true}
          className="flex-1 px-3 py-2 rounded-ios bg-system-bg-secondary text-label-primary placeholder-label-tertiary border border-separator-opaque/40 focus:border-ios-blue focus:outline-none text-body disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={pending || !input.trim() || ready !== true}
          className="px-4 py-2 rounded-ios bg-ios-blue text-white font-medium text-callout disabled:opacity-40 disabled:cursor-not-allowed hover:bg-ios-blue/90 transition-colors flex items-center gap-2"
        >
          <Send className="w-4 h-4" />
          Ask
        </button>
      </form>
    </div>
  );
}
