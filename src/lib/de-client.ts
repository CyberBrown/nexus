/**
 * DE (Distributed Electrons) Client
 *
 * Provides access to DE services via Cloudflare Service Binding.
 * DE handles all LLM operations - Nexus should never call LLM providers directly.
 *
 * Architecture:
 * - Nexus (The Brain) orchestrates and makes decisions
 * - DE (Arms & Legs) executes LLM calls, media processing, etc.
 *
 * DE text-gen API:
 * - POST /generate - Text generation with prompt
 * - GET /health - Health check
 */

import type { Env } from '../types/index.ts';

// ========================================
// Types
// ========================================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  model?: string;
  max_tokens?: number;
  temperature?: number;
}

export interface ChatCompletionResponse {
  content: string;
  model: string;
  tokens_used?: number;
}

export interface TextCompletionRequest {
  prompt: string;
  model?: string;
  max_tokens?: number;
  temperature?: number;
}

export interface TextCompletionResponse {
  text: string;
  model: string;
  tokens_used?: number;
}

export interface DEGenerateResponse {
  success: boolean;
  text: string;
  metadata: {
    provider: string;
    model: string;
    tokens_used: number;
    generation_time_ms: number;
  };
  request_id: string;
  timestamp: string;
}

export interface DEError {
  error: string;
  error_code?: string;
  request_id?: string;
}

// ========================================
// DE Client
// ========================================

export class DEClient {
  private binding: Fetcher;

  constructor(env: Env) {
    if (!env.DE) {
      throw new Error(
        'DE service binding not configured. Add [[services]] binding to wrangler.toml'
      );
    }
    this.binding = env.DE;
  }

  /**
   * Convert chat messages to a single prompt string
   * DE's text-gen service uses prompt-based generation
   */
  private messagesToPrompt(messages: ChatMessage[]): string {
    return messages
      .map((m) => {
        if (m.role === 'system') return `System: ${m.content}`;
        if (m.role === 'user') return `User: ${m.content}`;
        if (m.role === 'assistant') return `Assistant: ${m.content}`;
        return m.content;
      })
      .join('\n\n') + '\n\nAssistant:';
  }

  /**
   * Generate a chat completion via DE's text-gen service
   * Converts messages to prompt format for DE
   */
  async chatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const prompt = this.messagesToPrompt(request.messages);

    const response = await this.binding.fetch('https://de/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        model: request.model,
        max_tokens: request.max_tokens || 2000,
        temperature: request.temperature,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' })) as DEError;
      throw new Error(`DE chat completion failed: ${error.error || response.statusText}`);
    }

    const result = await response.json() as DEGenerateResponse;

    return {
      content: result.text,
      model: result.metadata.model,
      tokens_used: result.metadata.tokens_used,
    };
  }

  /**
   * Generate a text completion via DE's text-gen service
   */
  async textCompletion(request: TextCompletionRequest): Promise<TextCompletionResponse> {
    const response = await this.binding.fetch('https://de/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: request.prompt,
        model: request.model,
        max_tokens: request.max_tokens || 2000,
        temperature: request.temperature,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' })) as DEError;
      throw new Error(`DE text completion failed: ${error.error || response.statusText}`);
    }

    const result = await response.json() as DEGenerateResponse;

    return {
      text: result.text,
      model: result.metadata.model,
      tokens_used: result.metadata.tokens_used,
    };
  }

  /**
   * Health check for DE service
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.binding.fetch('https://de/health');
      return response.ok;
    } catch {
      return false;
    }
  }
}

// ========================================
// Helper Functions
// ========================================

/**
 * Create a DE client from environment
 * Returns null if DE binding is not configured (graceful degradation)
 */
export function createDEClient(env: Env): DEClient | null {
  try {
    return new DEClient(env);
  } catch {
    console.warn('DE service binding not available');
    return null;
  }
}

/**
 * Get DE client or throw if not available
 */
export function getDEClient(env: Env): DEClient {
  const client = createDEClient(env);
  if (!client) {
    throw new Error('DE service is required but not configured');
  }
  return client;
}
