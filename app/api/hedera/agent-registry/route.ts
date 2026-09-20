/**
 * HCS-14 agent registry — read-only lookup.
 *
 * Reads the Hedera Consensus Service topic where ZKward's x402 agents
 * publish their identity + capabilities. Discoverable by any other agent
 * that follows the HCS-14 shape.
 *
 * The registry is public-read / operator-write. Anyone can query it via
 * Mirror Node; only the operator key can publish new agent entries.
 *
 * GET /api/hedera/agent-registry
 *   → { topic, agents: [ { hcs_standard, agent_id, name, endpoints, ... } ] }
 *
 * Prize alignment (Hedera AI & Agentic Payments — extra points):
 *   ✓ "On-chain agent identity using ERC-8004 or HCS-14"
 *   ✓ "Agent discovery via UCP, or a directory that makes your service
 *      findable by other agents"
 */

import { NextResponse } from 'next/server';
import { logger } from '@/lib/utils/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 10;

const MIRROR_BASE = 'https://testnet.mirrornode.hedera.com/api/v1';

interface MirrorTopicMessage {
  message: string;              // base64
  consensus_timestamp: string;  // "1788753537.384874890"
  sequence_number: number;
  running_hash: string;
}

interface AgentRegistration {
  hcs_standard?: number;
  agent_id?: string;
  name?: string;
  version?: string;
  description?: string;
  endpoints?: Array<{
    protocol?: string;
    url?: string;
    price_usdc_micros?: string;
    facilitator?: string;
    network?: string;
  }>;
  capabilities?: string[];
  audit_topic?: string;
  operator?: string;
  registered_at?: string;
}

function decodeMessage(b64: string): AgentRegistration | null {
  try {
    const raw = Buffer.from(b64, 'base64').toString('utf-8');
    return JSON.parse(raw) as AgentRegistration;
  } catch {
    return null;
  }
}

function mirrorTimestampToDate(ts: string): Date {
  const secs = parseInt(ts.split('.')[0] ?? '0', 10);
  return new Date(secs * 1000);
}

export async function GET(): Promise<NextResponse> {
  const topic = (process.env.HCS_AGENT_REGISTRY_TOPIC || '').trim();
  if (!topic) {
    return NextResponse.json(
      { error: 'agent registry topic not configured' },
      { status: 503 },
    );
  }

  const url = `${MIRROR_BASE}/topics/${topic}/messages?limit=50&order=asc`;
  try {
    const r = await fetch(url, { next: { revalidate: 60 } });
    if (!r.ok) {
      return NextResponse.json(
        { error: `mirror returned ${r.status}`, topic },
        { status: 502 },
      );
    }
    const j = (await r.json()) as { messages?: MirrorTopicMessage[] };
    const agents = (j.messages ?? [])
      .map((m) => {
        const decoded = decodeMessage(m.message);
        if (!decoded) return null;
        return {
          ...decoded,
          _seq: m.sequence_number,
          _timestamp: mirrorTimestampToDate(m.consensus_timestamp).toISOString(),
          _running_hash: m.running_hash,
        };
      })
      .filter((a): a is NonNullable<typeof a> => a !== null);

    return NextResponse.json({
      topic,
      explorer: `https://hashscan.io/testnet/topic/${topic}`,
      count: agents.length,
      agents,
      spec: 'HCS-14 (Hedera Consensus Service — agent identity & discovery)',
      readMethod: 'Mirror Node REST (public, no auth)',
    }, {
      // Agent registrations are rare (publish-once); 5min edge cache is plenty.
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' },
    });
  } catch (e) {
    logger.warn('[agent-registry] fetch failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      { error: 'agent registry read failed', topic, detail: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}
