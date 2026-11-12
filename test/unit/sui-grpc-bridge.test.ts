/**
 * The SUI JSON-RPC bridge: objects decoded from their bytes render exactly as
 * JSON-RPC rendered them (the code reads those shapes in about forty places),
 * dynamic field keys derive the same ids, effects read the same from gRPC and
 * from GraphQL's JSON, and nothing it cannot answer comes back empty.
 */
import { describe, it, expect, jest } from '@jest/globals';
import { bcs } from '@mysten/sui/bcs';
import { deriveDynamicFieldID } from '@mysten/sui/utils';
import {
  callSuiJsonRpc, encodeMove, normalizedType, plainJson, renderEffects, renderMove, renderOwner, shortType, type Layout,
} from '@/lib/services/sui/sui-grpc-bridge';

const A = `0x${'ab'.repeat(32)}`;
const UID: Layout = { struct: { type: `0x${'0'.repeat(63)}2::object::UID`, fields: [{ name: 'id', layout: { struct: { type: `0x${'0'.repeat(63)}2::object::ID`, fields: [{ name: 'bytes', layout: 'address' }] } } }] } };
const POOL: Layout = { struct: { type: `${A}::pool::Pool<${A}::usdc::USDC>`, fields: [
  { name: 'id', layout: UID },
  { name: 'balance', layout: { struct: { type: `0x${'0'.repeat(63)}2::balance::Balance<${A}::usdc::USDC>`, fields: [{ name: 'value', layout: 'u64' }] } } },
  { name: 'members', layout: { struct: { type: `0x${'0'.repeat(63)}2::table::Table<address,${A}::pool::Member>`, fields: [{ name: 'id', layout: UID }, { name: 'size', layout: 'u64' }] } } },
  { name: 'hedge_id', layout: { vector: 'u8' } },
  { name: 'pair', layout: 'u8' },
  { name: 'note', layout: { struct: { type: `0x${'0'.repeat(63)}1::string::String`, fields: [{ name: 'bytes', layout: { vector: 'u8' } }] } } },
  { name: 'maybe', layout: { struct: { type: `0x${'0'.repeat(63)}1::option::Option<u64>`, fields: [{ name: 'vec', layout: { vector: 'u64' } }] } } },
  { name: 'none', layout: { struct: { type: `0x${'0'.repeat(63)}1::option::Option<u64>`, fields: [{ name: 'vec', layout: { vector: 'u64' } }] } } },
  { name: 'paused', layout: 'bool' },
] } };

const bytes = bcs.struct('Pool', {
  id: bcs.Address, balance: bcs.u64(), members_id: bcs.Address, members_size: bcs.u64(), hedge_id: bcs.vector(bcs.u8()), pair: bcs.u8(),
  note: bcs.string(), maybe: bcs.option(bcs.u64()), none: bcs.option(bcs.u64()), paused: bcs.bool(),
}).serialize({ id: A, balance: 3157800n, members_id: A, members_size: 3n, hedge_id: [1, 2, 255], pair: 7, note: 'hi', maybe: 42n, none: null, paused: false }).toBytes();

describe('rendering Move values as JSON-RPC did', () => {
  const v = renderMove(bytes, POOL) as { type: string; fields: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

  it('wraps a struct in { type, fields }, with short framework addresses and ", " between type arguments', () => {
    expect(v.type).toBe(`${A}::pool::Pool<${A}::usdc::USDC>`);
    expect(v.fields.members.type).toBe(`0x2::table::Table<address, ${A}::pool::Member>`);
    expect(v.fields.members.fields).toEqual({ id: { id: A }, size: '3' });
  });

  it('renders UID as { id }, Balance as its value, u64 as a string, u8 as a number, bytes as numbers', () => {
    expect(v.fields.id).toEqual({ id: A });
    expect(v.fields.balance).toBe('3157800');
    expect(v.fields.pair).toBe(7);
    expect(v.fields.hedge_id).toEqual([1, 2, 255]);
  });

  it('renders String as text and Option as its value or null', () => {
    expect(v.fields.note).toBe('hi');
    expect(v.fields.maybe).toBe('42');
    expect(v.fields.none).toBeNull();
    expect(v.fields.paused).toBe(false);
  });

  it('refuses bytes that do not fit the layout', () => {
    expect(() => renderMove(bytes.subarray(0, 40), POOL)).toThrow(/ran out/);
    expect(() => renderMove(new Uint8Array([...bytes, 0]), POOL)).toThrow(/left over/);
  });

  it('event JSON drops the wrappers', () => {
    expect(plainJson(v)).toMatchObject({ members: { id: { id: A }, size: '3' }, balance: '3157800' });
  });

  it('shortens framework addresses only', () => {
    expect(shortType(`0x${'0'.repeat(63)}2::coin::Coin<0x${'0'.repeat(63)}2::sui::SUI>`)).toBe('0x2::coin::Coin<0x2::sui::SUI>');
    expect(shortType(`${A}::m::T`)).toBe(`${A}::m::T`);
  });
});

describe('dynamic field keys', () => {
  it('encode as BCS, so the field id matches the chain', () => {
    const key = Uint8Array.from(encodeMove('address', A));
    expect(deriveDynamicFieldID(A, 'address', key)).toBe(deriveDynamicFieldID(A, 'address', bcs.Address.serialize(A).toBytes()));
    const vec = Uint8Array.from(encodeMove({ vector: 'u8' }, Array.from(Buffer.from('external_nav_usdc'))));
    expect(Array.from(vec)).toEqual(Array.from(bcs.vector(bcs.u8()).serialize(Array.from(Buffer.from('external_nav_usdc'))).toBytes()));
  });
});

describe('effects and owners', () => {
  const grpc = {
    status: { success: false, error: { description: 'MoveAbort in deposit', command: 2n, errorDetails: { oneofKind: 'abort', abort: { abortCode: 7n } } } },
    gasUsed: { computationCost: 1000n, storageCost: 2000n, storageRebate: 500n, nonRefundableStorageFee: 5n },
    changedObjects: [
      { objectId: '0x1', idOperation: 2, outputState: 2, outputVersion: 9n, outputDigest: 'D1', outputOwner: { kind: 1, address: A } },
      { objectId: '0x2', idOperation: 1, outputState: 2, outputVersion: 9n, outputDigest: 'D2', outputOwner: { kind: 3, version: 5n } },
      { objectId: '0x3', idOperation: 3, outputState: 1 },
    ],
    lamportVersion: 9n,
  };
  // GraphQL sends the same message as JSON: enum names, integers as strings, the abort as a plain field.
  const json = {
    status: { success: false, error: { description: 'MoveAbort in deposit', command: '2', abort: { abortCode: '7' } } },
    gasUsed: { computationCost: '1000', storageCost: '2000', storageRebate: '500', nonRefundableStorageFee: '5' },
    changedObjects: [
      { objectId: '0x1', idOperation: 'CREATED', outputState: 'OUTPUT_OBJECT_STATE_OBJECT_WRITE', outputVersion: '9', outputDigest: 'D1', outputOwner: { kind: 'ADDRESS', address: A } },
      { objectId: '0x2', idOperation: 'NONE', outputState: 'OUTPUT_OBJECT_STATE_OBJECT_WRITE', outputVersion: '9', outputDigest: 'D2', outputOwner: { kind: 'SHARED', version: '5' } },
      { objectId: '0x3', idOperation: 'DELETED', outputState: 'OUTPUT_OBJECT_STATE_DOES_NOT_EXIST' },
    ],
    lamportVersion: '9',
  };

  it.each([['gRPC', grpc], ['GraphQL JSON', json]])('read the same from %s', (_name, e) => {
    const r = renderEffects(e as never) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(r.status).toEqual({ status: 'failure', error: 'MoveAbort in deposit (abort code 7) in command 2' });
    expect(r.gasUsed).toEqual({ computationCost: '1000', storageCost: '2000', storageRebate: '500', nonRefundableStorageFee: '5' });
    expect(r.created).toEqual([{ owner: { AddressOwner: A }, reference: { objectId: '0x1', version: 9, digest: 'D1' } }]);
    expect(r.mutated[0].owner).toEqual({ Shared: { initial_shared_version: 5 } });
    expect(r.deleted.map((d: { objectId: string }) => d.objectId)).toEqual(['0x3']);
  });

  it('owners as JSON-RPC wrote them', () => {
    expect(renderOwner({ kind: 2, address: A })).toEqual({ ObjectOwner: A });
    expect(renderOwner({ kind: 4 })).toBe('Immutable');
    expect(renderOwner(undefined)).toBeNull();
  });
});

describe('Move signatures for the transaction builder', () => {
  it('turn into JSON-RPC normalized types', () => {
    const pool = { type: 10, typeName: `${A}::pool::Pool`, typeParameterInstantiation: [{ type: 11, typeParameter: 0, typeParameterInstantiation: [] }] };
    expect(normalizedType(pool, 2)).toEqual({ MutableReference: { Struct: { address: A, module: 'pool', name: 'Pool', typeArguments: [{ TypeParameter: 0 }] } } });
    expect(normalizedType({ type: 9, typeParameterInstantiation: [{ type: 3, typeParameterInstantiation: [] }] })).toEqual({ Vector: 'U8' });
    expect(normalizedType({ type: 6, typeParameterInstantiation: [] }, 1)).toEqual({ Reference: 'U64' });
  });
});

describe('a request the bridge cannot answer', () => {
  it('throws, never answers empty', async () => {
    await expect(callSuiJsonRpc('mainnet', 'suix_noSuchMethod', [])).rejects.toThrow(/not available/);
  });
});

describe('the client every service uses', () => {
  it('sends its requests to the bridge', async () => {
    jest.resetModules();
    const call = jest.fn(async () => ({ data: { objectId: A, version: '1', digest: 'D' } }));
    jest.doMock('@/lib/services/sui/sui-grpc-bridge', () => ({ callSuiJsonRpc: call }));
    const { createFailoverSuiClient } = await import('@/lib/services/sui/sui-failover-transport');
    const r = await createFailoverSuiClient('mainnet').getObject({ id: A, options: { showContent: true } });
    expect(r.data?.objectId).toBe(A);
    expect(call).toHaveBeenCalledWith('mainnet', 'sui_getObject', [A, { showContent: true }]);
    jest.dontMock('@/lib/services/sui/sui-grpc-bridge');
  });
});
