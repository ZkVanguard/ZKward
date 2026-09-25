/**
 * Enhanced Chat Component with LLM Integration
 * Features: Streaming responses, typing indicators, better UX, Markdown rendering
 */

'use client';

import { useState, useRef, useEffect } from 'react';
import { logger } from '@/lib/utils/logger';
import { useApiAuth } from '@/lib/hooks/useApiAuth';
import { Send, Bot, User, Sparkles, TrendingUp, Shield, Zap, Copy, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ThinkingIndicator } from '@/components/chat/ThinkingIndicator';

interface ChatAction {
  id: string;
  label: string;
  type: string;
  params: Record<string, unknown>;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  streaming?: boolean;
  actions?: ChatAction[];
}

interface EnhancedChatProps {
  address?: string;
  onActionTrigger?: (action: string, params: Record<string, unknown>) => void;
  hideHeader?: boolean;
}

const QUICK_PROMPTS = [
  { label: 'Analyze portfolio', icon: TrendingUp, prompt: 'Analyze my portfolio and show key metrics' },
  { label: 'Check risk level', icon: Shield, prompt: 'What is my current risk level?' },
  { label: 'Explain x402', icon: Zap, prompt: 'Explain how x402 gasless transactions work' },
  { label: 'ZK Proofs?', icon: Sparkles, prompt: 'What are Zero-Knowledge proofs and how do you use them?' },
];

// Code block component with copy functionality
function CodeBlock({ children, className }: { children: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const language = className?.replace('language-', '') || 'text';
  
  const handleCopy = async () => {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group my-3">
      <div className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={handleCopy}
          className="p-1.5 rounded-md bg-white/10 hover:bg-white/20 transition-colors"
        >
          {copied ? (
            <Check className="w-4 h-4 text-emerald-400" />
          ) : (
            <Copy className="w-4 h-4 text-white/70" />
          )}
        </button>
      </div>
      <div className="text-xs text-white/50 px-4 py-1 bg-[#1e1e2e] rounded-t-lg border-b border-white/10">
        {language}
      </div>
      <pre className="bg-[#1e1e2e] text-[#cdd6f4] p-4 rounded-b-lg overflow-x-auto text-sm font-mono">
        <code>{children}</code>
      </pre>
    </div>
  );
}

// Markdown renderer component
function MarkdownContent({ content, isUser }: { content: string; isUser: boolean }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        // Headers
        h1: ({ children }) => (
          <h1 className={`text-xl font-bold mt-4 mb-2 ${isUser ? 'text-white' : 'text-[#1d1d1f]'}`}>
            {children}
          </h1>
        ),
        h2: ({ children }) => (
          <h2 className={`text-lg font-bold mt-3 mb-2 ${isUser ? 'text-white' : 'text-[#1d1d1f]'}`}>
            {children}
          </h2>
        ),
        h3: ({ children }) => (
          <h3 className={`text-base font-semibold mt-3 mb-1.5 ${isUser ? 'text-white' : 'text-[#1d1d1f]'}`}>
            {children}
          </h3>
        ),
        h4: ({ children }) => (
          <h4 className={`text-sm font-semibold mt-2 mb-1 ${isUser ? 'text-white' : 'text-[#6e6e73]'}`}>
            {children}
          </h4>
        ),
        // Paragraphs
        p: ({ children }) => (
          <p className={`mb-2 last:mb-0 leading-relaxed ${isUser ? 'text-white' : 'text-[#1d1d1f]'}`}>
            {children}
          </p>
        ),
        // Strong/Bold
        strong: ({ children }) => (
          <strong className={`font-semibold ${isUser ? 'text-white' : 'text-[#1d1d1f]'}`}>
            {children}
          </strong>
        ),
        // Emphasis/Italic
        em: ({ children }) => (
          <em className={isUser ? 'text-white/90' : 'text-[#6e6e73]'}>{children}</em>
        ),
        // Lists
        ul: ({ children }) => (
          <ul className={`list-disc list-inside mb-2 space-y-1 ${isUser ? 'text-white' : 'text-[#1d1d1f]'}`}>
            {children}
          </ul>
        ),
        ol: ({ children }) => (
          <ol className={`list-decimal list-inside mb-2 space-y-1 ${isUser ? 'text-white' : 'text-[#1d1d1f]'}`}>
            {children}
          </ol>
        ),
        li: ({ children }) => (
          <li className="ml-2">{children}</li>
        ),
        // Code blocks
        code: ({ className, children, ...props }) => {
          const isInline = !className;
          if (isInline) {
            return (
              <code 
                className={`px-1.5 py-0.5 rounded text-sm font-mono ${
                  isUser 
                    ? 'bg-white/20 text-white' 
                    : 'bg-[#f5f5f7] text-[#e74c3c] border border-[#e5e5ea]'
                }`}
                {...props}
              >
                {children}
              </code>
            );
          }
          return <CodeBlock className={className}>{String(children).replace(/\n$/, '')}</CodeBlock>;
        },
        pre: ({ children }) => <>{children}</>,
        // Tables
        table: ({ children }) => (
          <div className="overflow-x-auto my-3 rounded-lg border border-[#e5e5ea]">
            <table className="min-w-full divide-y divide-[#e5e5ea] text-sm">
              {children}
            </table>
          </div>
        ),
        thead: ({ children }) => (
          <thead className="bg-[#f5f5f7]">{children}</thead>
        ),
        tbody: ({ children }) => (
          <tbody className="divide-y divide-[#e5e5ea] bg-white">{children}</tbody>
        ),
        tr: ({ children }) => (
          <tr className="hover:bg-[#f5f5f7]/50 transition-colors">{children}</tr>
        ),
        th: ({ children }) => (
          <th className="px-3 py-2 text-left font-semibold text-[#1d1d1f] whitespace-nowrap">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="px-3 py-2 text-[#1d1d1f] whitespace-nowrap">{children}</td>
        ),
        // Blockquotes
        blockquote: ({ children }) => (
          <blockquote className={`border-l-4 pl-4 my-2 italic ${
            isUser 
              ? 'border-white/40 text-white/80' 
              : 'border-[#007AFF] text-[#6e6e73] bg-[#f5f5f7] py-2 pr-4 rounded-r-lg'
          }`}>
            {children}
          </blockquote>
        ),
        // Horizontal rule
        hr: () => (
          <hr className={`my-4 ${isUser ? 'border-white/20' : 'border-[#e5e5ea]'}`} />
        ),
        // Links
        a: ({ href, children }) => (
          <a 
            href={href} 
            target="_blank" 
            rel="noopener noreferrer"
            className={`underline underline-offset-2 hover:opacity-80 transition-opacity ${
              isUser ? 'text-white' : 'text-[#007AFF]'
            }`}
          >
            {children}
          </a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

export function EnhancedChat({ address, onActionTrigger, hideHeader = false }: EnhancedChatProps) {
  const { getAuthHeaders } = useApiAuth(address);

  const [messages, setMessages] = useState<Message[]>([
    {
      id: '0',
      role: 'assistant',
      content: `Welcome! I'm your AI-powered portfolio assistant with real LLM capabilities. 🤖\n\nI can help you with:\n• Portfolio analysis and risk assessment\n• Understanding DeFi concepts\n• Hedge strategy recommendations\n• Platform features and capabilities\n\nFeel free to ask me anything!`,
      timestamp: Date.now(),
    },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const sendMessage = async (text: string) => {
    if (!text.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);
    setIsTyping(true);

    try {
      const authHeaders = await getAuthHeaders();
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          message: text,
          conversationId: address || 'default',
          context: { address, timestamp: Date.now() },
        }),
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`Failed to get response: ${response.status} ${errBody.slice(0, 80)}`);
      }

      const data = await response.json();
      
      setIsTyping(false);

      // Parse actions from response if present
      let content = data.response;
      let actions: ChatAction[] | undefined;
      
      const actionMatch = content.match(/<!--ACTIONS:(.+?)-->/s);
      if (actionMatch) {
        try {
          actions = JSON.parse(actionMatch[1]);
          content = content.replace(/<!--ACTIONS:.+?-->/s, '').trim();
        } catch (e) {
          logger.error('Failed to parse actions', e instanceof Error ? e : undefined);
        }
      }

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content,
        timestamp: Date.now(),
        actions,
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      logger.error('Chat error', error instanceof Error ? error : undefined);
      setIsTyping(false);

      const msg = error instanceof Error ? error.message : '';
      let content = 'Sorry, I encountered an error. Please try again.';
      if (msg.includes('User rejected') || msg.includes('rejected the request')) {
        content = 'Sign-in declined. I need a wallet signature to talk to the AI backend. Try again and approve when prompted.';
      } else if (msg.includes('Wallet not connected')) {
        content = 'Please connect your wallet. The AI backend needs it to authenticate your session.';
      }
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleQuickPrompt = (prompt: string) => {
    setInput(prompt);
    inputRef.current?.focus();
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  return (
    <div className="flex flex-col h-full bg-white overflow-hidden">
      {/* Header - only show if not hidden by parent */}
      {!hideHeader && (
        <div className="flex-shrink-0 flex items-center justify-between p-3 sm:p-4 border-b border-[#e5e5ea] bg-gradient-to-r from-[#f5f5f7] to-white">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="w-10 h-10 rounded-xl bg-ios-blue flex items-center justify-center shadow-ios-2">
                <Bot className="w-5 h-5 text-white" />
              </div>
              <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-emerald-500 rounded-full border-2 border-white" />
            </div>
            <div>
              <h3 className="font-semibold text-[14px] text-[#1d1d1f]">ZK Vanguard AI</h3>
              <p className="text-[11px] text-[#86868b]">Powered by Advanced LLM</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-emerald-50 rounded-full">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </span>
            <span className="text-[11px] font-medium text-emerald-700">Online</span>
          </div>
        </div>
      )}

      {/* Quick Prompts */}
      <div className="flex-shrink-0 flex gap-2 p-2.5 overflow-x-auto border-b border-[#e5e5ea] bg-[#fafafa] scrollbar-thin scrollbar-thumb-[#e5e5ea] scrollbar-track-transparent">
        {QUICK_PROMPTS.map((prompt, idx) => (
          <button
            key={idx}
            onClick={() => handleQuickPrompt(prompt.prompt)}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-white hover:bg-[#f5f5f7] text-[#1d1d1f] rounded-lg border border-[#e5e5ea] hover:border-[#007AFF] whitespace-nowrap transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed group"
          >
            <prompt.icon className="w-3.5 h-3.5 text-[#86868b] group-hover:text-[#007AFF] transition-colors" />
            {prompt.label}
          </button>
        ))}
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 sm:p-4 space-y-3 bg-white">
        <AnimatePresence mode="popLayout">
          {messages.map((message) => (
            <motion.div
              key={message.id}
              initial={{ opacity: 0, y: 20, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div className={`flex gap-2.5 max-w-[85%] ${message.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
                {/* Avatar */}
                <div className={`flex-shrink-0 w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center ${
                  message.role === 'user'
                    ? 'bg-ios-blue'
                    : 'bg-ios-blue'
                }`}>
                  {message.role === 'user' ? (
                    <User className="w-4 h-4 text-white" />
                  ) : (
                    <Bot className="w-4 h-4 text-white" />
                  )}
                </div>

                {/* Message Bubble */}
                <div
                  className={`rounded-2xl px-3 py-2.5 sm:px-4 sm:py-3 ${
                    message.role === 'user'
                      ? 'bg-ios-blue text-white rounded-tr-sm'
                      : 'bg-[#f5f5f7] text-[#1d1d1f] rounded-tl-sm'
                  }`}
                >
                  <div className={`text-[13px] sm:text-sm leading-relaxed ${message.role === 'user' ? 'text-white' : 'text-[#1d1d1f]'}`}>
                    <MarkdownContent content={message.content} isUser={message.role === 'user'} />
                  </div>
                  
                  {/* Action Buttons */}
                  {message.actions && message.actions.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-black/5">
                      {message.actions.map((action) => (
                        <button
                          key={action.id}
                          onClick={() => {
                            if (onActionTrigger) {
                              onActionTrigger(action.type, action.params);
                            } else {
                              // Fallback: send as chat message
                              sendMessage(`/${action.type} ${JSON.stringify(action.params)}`);
                            }
                          }}
                          className={`px-2.5 py-1.5 text-[11px] font-medium rounded-lg transition-all duration-200 flex items-center gap-1 ${
                            action.type === 'hedge' 
                              ? 'bg-emerald-500 hover:bg-emerald-600 text-white'
                              : action.type === 'adjust'
                              ? 'bg-amber-500 hover:bg-amber-600 text-white'
                              : 'bg-[#007AFF] hover:bg-[#0066DD] text-white'
                          }`}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                  )}

                  <div className={`text-[10px] mt-1.5 flex items-center gap-1 ${message.role === 'user' ? 'text-white/60 justify-end' : 'text-[#86868b]'}`}>
                    {message.role === 'assistant' && <Sparkles className="w-2.5 h-2.5" />}
                    {new Date(message.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Typing Indicator */}
        {isTyping && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="flex justify-start"
          >
            <div className="flex gap-2.5">
              <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-ios-blue flex items-center justify-center">
                <Bot className="w-4 h-4 text-white" />
              </div>
              <div className="bg-[#f5f5f7] rounded-2xl rounded-tl-sm px-4 py-3">
                <ThinkingIndicator className="text-[11px]" />
              </div>
            </div>
          </motion.div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="flex-shrink-0 p-3 sm:p-4 border-t border-[#e5e5ea] bg-white">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Ask about your portfolio or DeFi..."
            disabled={isLoading}
            className="flex-1 px-3 py-2.5 sm:px-4 sm:py-3 bg-[#f5f5f7] border border-transparent rounded-xl focus:outline-none focus:bg-white focus:border-[#007AFF] text-[13px] sm:text-sm text-[#1d1d1f] placeholder-[#86868b] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          />
          <button
            onClick={() => sendMessage(input)}
            disabled={!input.trim() || isLoading}
            className="px-4 py-2.5 sm:px-5 sm:py-3 bg-[#007AFF] hover:bg-[#0066DD] disabled:bg-[#e5e5ea] disabled:cursor-not-allowed rounded-xl transition-all duration-200 active:scale-95"
          >
            <Send className="w-4 h-4 sm:w-5 sm:h-5 text-white" />
          </button>
        </div>
        <p className="text-[9px] sm:text-[10px] text-[#86868b] mt-2 text-center flex items-center justify-center gap-1">
          <Sparkles className="w-2.5 h-2.5" />
          Powered by ASI • Context-aware
        </p>
      </div>
    </div>
  );
}
