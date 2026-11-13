/**
 * The agent orchestrator with a key that is not an EVM key: from 2026-09-22 its constructor threw
 * "invalid BytesLike value" and no agent cycle ran. It must start read-only instead, as with no key,
 * and never log the key.
 */
import { describe, it, expect, afterEach, jest } from '@jest/globals';

const warn = jest.fn();
jest.mock('@/lib/utils/logger', () => ({ logger: { info: jest.fn(), warn: (...a: unknown[]) => warn(...a), error: jest.fn(), debug: jest.fn() } }));

const KEYS = ['AGENT_PRIVATE_KEY', 'SERVER_PRIVATE_KEY', 'SERVER_WALLET_PRIVATE_KEY', 'PRIVATE_KEY'];
afterEach(() => { for (const k of KEYS) delete process.env[k]; });

describe('the orchestrator’s signer', () => {
  it('a key that is not an EVM key gives a read-only orchestrator, not a crash, and the key is not logged', async () => {
    process.env.AGENT_PRIVATE_KEY = '0xnot-a-hex-key-123';
    const { AgentOrchestrator } = await import('@/lib/services/agent-orchestrator');
    await AgentOrchestrator.resetInstance();
    expect(() => AgentOrchestrator.getInstance()).not.toThrow();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('read-only');
    expect(logged).not.toContain('not-a-hex-key');
  });
});
