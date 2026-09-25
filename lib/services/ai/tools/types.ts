/**
 * Shared type for the Layer 3 agent tool registry.
 * Extracted from agent-tools.ts so per-domain tool files can import
 * just what they need without pulling in the full registry.
 */

/** OpenAI-tool-use compatible schema. */
export interface AgentTool<TArgs = Record<string, unknown>, TResult = unknown> {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  execute: (args: TArgs) => Promise<TResult>;
}
