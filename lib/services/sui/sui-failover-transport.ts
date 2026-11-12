/**
 * The SuiClient every service uses. Its requests are JSON-RPC in form and are
 * answered from gRPC and GraphQL by `sui-grpc-bridge.ts`: no public mainnet
 * provider serves JSON-RPC since about 2026-11-06, and the code reads the
 * JSON-RPC shapes in about forty places.
 *
 * Transactions are built by the SDK's JSON-RPC resolver through the same
 * bridge (gas price, coins, objects, Move signatures, a dry run for the
 * budget): this SDK version's gRPC client does not build transactions.
 */
import { SuiClient, type SuiTransport, type SuiTransportRequestOptions } from '@mysten/sui/client';
import { callSuiJsonRpc, type SuiNetwork } from '@/lib/services/sui/sui-grpc-bridge';

class GrpcBridgeTransport implements SuiTransport {
  constructor(private readonly network: SuiNetwork) {}

  request<T = unknown>(input: SuiTransportRequestOptions): Promise<T> {
    return callSuiJsonRpc(this.network, input.method, input.params) as Promise<T>;
  }

  async subscribe(): Promise<() => Promise<boolean>> {
    throw new Error('SUI subscriptions are not supported');
  }
}

/** The SuiClient for every service in this repo. */
export function createFailoverSuiClient(network: SuiNetwork = 'mainnet'): SuiClient {
  return new SuiClient({ transport: new GrpcBridgeTransport(network) });
}
