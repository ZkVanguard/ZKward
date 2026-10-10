/**
 * Shared types for LLM provider modules
 */

// Message types for conversation
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  tokensUsed?: number;
  model?: string;
  confidence?: number;
  sources?: string[];
  actionExecuted?: boolean;
  actionResult?: unknown;
}

export interface StreamChunk {
  delta: string;
  done: boolean;
}

// Interfaces for dynamically-imported AI client SDKs
export interface ChatCompletionResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { total_tokens: number; input_tokens?: number; output_tokens?: number };
}

export interface ChatClient {
  chat: {
    completions: {
      create(params: Record<string, unknown>): Promise<ChatCompletionResponse>;
    };
  };
}

export interface AnthropicContentBlock {
  type: string;
  text: string;
}

export interface AnthropicResponse {
  content: AnthropicContentBlock[];
  usage?: { input_tokens: number; output_tokens: number };
}

export interface AnthropicClient {
  messages: {
    create(params: Record<string, unknown>): Promise<AnthropicResponse>;
  };
}

export interface HedgeAction {
  id: string;
  label: string;
  type: string;
  params: Record<string, unknown>;
}
