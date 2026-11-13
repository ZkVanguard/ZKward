/**
 * SUI JSON-RPC requests answered from gRPC and GraphQL.
 *
 * Why: providers dropped JSON-RPC one by one (the official fullnode in
 * 2026-07, the last two free providers by about 2026-11-06), and with the last
 * one every server read, signed pool transaction and browser read failed. The
 * code speaks JSON-RPC in about forty files, so this answers those requests
 * from the newer interfaces in the shape JSON-RPC returned, and no call site
 * changes: the server client's transport, the raw helper and the browser proxy
 * all route here.
 *
 * Objects are read as bytes over gRPC and decoded with their type's layout
 * from GraphQL (cached per type), then rendered as JSON-RPC rendered Move
 * values: a nested struct as { type, fields }, UID as { id }, ID and addresses
 * as 0x strings, Balance as its value, Option as its value or null, strings as
 * text, u64 and wider as decimal strings, byte vectors as arrays of numbers.
 *
 * A method or option not handled here throws. A request this cannot answer is
 * an error, never an empty result.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { deriveDynamicFieldID, fromBase58, fromBase64, normalizeSuiAddress, toBase58, toBase64 } from '@mysten/sui/utils';

export type SuiNetwork = 'mainnet' | 'testnet';

const GRPC_DEFAULT: Record<SuiNetwork, string> = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
};
const GRAPHQL: Record<SuiNetwork, string> = {
  mainnet: 'https://graphql.mainnet.sui.io/graphql',
  testnet: 'https://graphql.testnet.sui.io/graphql',
};
const TIMEOUT_MS = 10_000;
const CALL = { timeout: TIMEOUT_MS };

/** The gRPC endpoint: `SUI_<NET>_GRPC_URL` (a paid endpoint) when set, else the public fullnode. */
export function suiGrpcUrl(network: SuiNetwork): string {
  return (process.env[`SUI_${network.toUpperCase()}_GRPC_URL`] || '').trim() || GRPC_DEFAULT[network];
}

const clients = new Map<string, SuiGrpcClient>();
export function suiGrpcClient(network: SuiNetwork): SuiGrpcClient {
  const baseUrl = suiGrpcUrl(network);
  let c = clients.get(baseUrl);
  if (!c) {
    c = new SuiGrpcClient({ network, baseUrl });
    clients.set(baseUrl, c);
  }
  return c;
}

async function graphql<T>(network: SuiNetwork, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(GRAPHQL[network], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`SUI GraphQL HTTP ${res.status}`);
  const j = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (j.errors?.length) throw new Error(`SUI GraphQL: ${j.errors[0].message}`);
  if (!j.data) throw new Error('SUI GraphQL: no data');
  return j.data;
}

// ── Move layouts, BCS decoding and JSON-RPC rendering ─────────────────────

type Field = { name: string; layout: Layout };
export type Layout =
  | string
  | { vector: Layout }
  | { struct: { type: string; fields: Field[] } }
  | { enum: { type: string; variants: Array<{ name: string; fields: Field[] }> } };

const PRIMITIVE = /^(bool|u8|u16|u32|u64|u128|u256|address|signer)$/;
const layouts = new Map<string, Promise<Layout>>();

/** A type's layout; primitives and vectors of them locally, anything else from GraphQL once per type. */
export function layoutOf(network: SuiNetwork, type: string): Promise<Layout> {
  const t = type.trim();
  if (PRIMITIVE.test(t)) return Promise.resolve(t);
  const vec = /^vector<(.+)>$/.exec(t);
  if (vec && PRIMITIVE.test(vec[1].trim())) return Promise.resolve({ vector: vec[1].trim() });
  const key = `${network}|${t}`;
  let p = layouts.get(key);
  if (!p) {
    p = graphql<{ type: { layout: Layout } | null }>(network, 'query($t: String!) { type(type: $t) { layout } }', { t })
      .then((d) => {
        if (!d.type?.layout) throw new Error(`SUI GraphQL: no layout for ${t}`);
        return d.type.layout;
      });
    p.catch(() => layouts.delete(key));
    layouts.set(key, p);
  }
  return p;
}

/** JSON-RPC's type display: framework addresses short (0x2), ", " between type arguments. */
export function shortType(t: string): string {
  return t.replace(/0x0*([0-9a-fA-F]+)::/g, (_m, h: string) => `0x${h}::`).replace(/,\s*/g, ', ');
}

const baseName = (type: string) => shortType(type).replace(/<.*$/, '');

class Reader {
  private i = 0;
  constructor(private readonly b: Uint8Array) {}
  bytes(n: number): Uint8Array {
    if (this.i + n > this.b.length) throw new Error('BCS: ran out of bytes');
    const s = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return s;
  }
  uleb(): number {
    let v = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = this.bytes(1)[0];
      v += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80)) return v;
    }
  }
  uint(n: number): bigint {
    const s = this.bytes(n);
    let v = 0n;
    for (let k = n - 1; k >= 0; k--) v = (v << 8n) | BigInt(s[k]);
    return v;
  }
  done(): boolean {
    return this.i === this.b.length;
  }
}

const hex = (b: Uint8Array) => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
const UINT_BYTES: Record<string, number> = { u8: 1, u16: 2, u32: 4, u64: 8, u128: 16, u256: 32 };

function renderValue(r: Reader, layout: Layout): unknown {
  if (typeof layout === 'string') {
    if (layout === 'bool') return r.bytes(1)[0] === 1;
    if (layout === 'address' || layout === 'signer') return hex(r.bytes(32));
    const n = UINT_BYTES[layout];
    if (!n) throw new Error(`BCS: unknown layout ${layout}`);
    const v = r.uint(n);
    return n <= 4 ? Number(v) : v.toString();
  }
  if ('vector' in layout) {
    const len = r.uleb();
    return Array.from({ length: len }, () => renderValue(r, layout.vector));
  }
  if ('enum' in layout) {
    const variant = layout.enum.variants[r.uleb()];
    if (!variant) throw new Error(`BCS: bad variant of ${layout.enum.type}`);
    return { type: shortType(layout.enum.type), variant: variant.name, fields: renderFields(r, variant.fields) };
  }
  const { type, fields } = layout.struct;
  const v = renderFields(r, fields);
  switch (baseName(type)) {
    case '0x1::string::String':
    case '0x1::ascii::String':
      return new TextDecoder().decode(Uint8Array.from(v.bytes as number[]));
    case '0x2::url::Url':
      return v.url;
    case '0x2::object::ID':
      return v.bytes;
    case '0x2::object::UID':
      return { id: v.id };
    case '0x2::balance::Balance':
      return v.value;
    case '0x1::option::Option': {
      const vec = v.vec as unknown[];
      return vec.length ? vec[0] : null;
    }
    default:
      return { type: shortType(type), fields: v };
  }
}

function renderFields(r: Reader, fields: Field[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((f) => [f.name, renderValue(r, f.layout)]));
}

/** Decode BCS bytes of `layout` into a JSON-RPC rendered Move value. */
export function renderMove(bytes: Uint8Array, layout: Layout): unknown {
  const r = new Reader(bytes);
  const v = renderValue(r, layout);
  if (!r.done()) throw new Error('BCS: bytes left over after decoding');
  return v;
}

/** JSON-RPC's `parsedJson` for events: the same values without the { type, fields } wrappers. */
export function plainJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plainJson);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const inner = 'type' in o && 'fields' in o && typeof o.fields === 'object' ? (o.fields as Record<string, unknown>) : o;
    return Object.fromEntries(Object.entries(inner).map(([k, x]) => [k, plainJson(x)]));
  }
  return v;
}

/** BCS bytes of a JSON-RPC style value (a dynamic field name) under `layout`. */
export function encodeMove(layout: Layout, value: unknown, out: number[] = []): number[] {
  if (typeof layout === 'string') {
    if (layout === 'bool') out.push(value ? 1 : 0);
    else if (layout === 'address' || layout === 'signer') out.push(...fromHexBytes(normalizeSuiAddress(String(value))));
    else {
      const n = UINT_BYTES[layout];
      if (!n) throw new Error(`BCS: cannot encode ${layout}`);
      let x = BigInt(value as string | number);
      for (let k = 0; k < n; k++, x >>= 8n) out.push(Number(x & 0xffn));
    }
    return out;
  }
  if ('vector' in layout) {
    const items = layout.vector === 'u8' && typeof value === 'string' ? Array.from(new TextEncoder().encode(value)) : (value as unknown[]);
    let len = items.length;
    do {
      out.push((len & 0x7f) | (len > 0x7f ? 0x80 : 0));
      len = Math.floor(len / 128);
    } while (len > 0);
    for (const item of items) encodeMove(layout.vector, item, out);
    return out;
  }
  if ('enum' in layout) throw new Error(`BCS: cannot encode enum ${layout.enum.type}`);
  const name = baseName(layout.struct.type);
  let v = value as Record<string, unknown>;
  if (typeof value === 'string' && (name === '0x1::string::String' || name === '0x1::ascii::String')) v = { bytes: value };
  else if (typeof value === 'string' && name === '0x2::object::ID') v = { bytes: value };
  for (const f of layout.struct.fields) encodeMove(f.layout, v[f.name], out);
  return out;
}

function fromHexBytes(h: string): number[] {
  const s = h.replace(/^0x/, '');
  return Array.from({ length: s.length / 2 }, (_, i) => parseInt(s.slice(2 * i, 2 * i + 2), 16));
}

// ── Objects ───────────────────────────────────────────────────────────────

type GrpcObject = {
  objectId?: string; version?: bigint; digest?: string; objectType?: string; owner?: { kind?: number | string; address?: string; version?: bigint | string };
  previousTransaction?: string; storageRebate?: bigint; contents?: { name?: string; value?: Uint8Array }; hasPublicTransfer?: boolean; balance?: bigint;
};
type ObjectOptions = {
  showType?: boolean; showOwner?: boolean; showPreviousTransaction?: boolean; showContent?: boolean; showBcs?: boolean;
  showStorageRebate?: boolean; showDisplay?: boolean;
};

const OBJECT_MASK = { paths: ['object_id', 'version', 'digest', 'object_type', 'owner', 'previous_transaction', 'storage_rebate', 'contents', 'has_public_transfer'] };

// gRPC sends enums as numbers; GraphQL's JSON of the same messages sends their names.
const OWNER_KIND: Record<string, number> = { ADDRESS: 1, OBJECT: 2, SHARED: 3, IMMUTABLE: 4, CONSENSUS_ADDRESS: 5 };
const OUTPUT_STATE: Record<string, number> = { OUTPUT_OBJECT_STATE_DOES_NOT_EXIST: 1, OUTPUT_OBJECT_STATE_OBJECT_WRITE: 2, OUTPUT_OBJECT_STATE_PACKAGE_WRITE: 3 };
const ID_OPERATION: Record<string, number> = { NONE: 1, CREATED: 2, DELETED: 3 };
const en = (v: unknown, names: Record<string, number>) => (typeof v === 'string' ? names[v] ?? 0 : Number(v ?? 0));

export function renderOwner(o: GrpcObject['owner']): unknown {
  if (!o) return null;
  switch (en(o.kind, OWNER_KIND)) {
    case 1: return { AddressOwner: o.address };
    case 2: return { ObjectOwner: o.address };
    case 3: return { Shared: { initial_shared_version: Number(o.version) } };
    case 4: return 'Immutable';
    case 5: return { ConsensusAddressOwner: { owner: o.address, start_version: Number(o.version) } };
    default: return null;
  }
}

async function objectData(network: SuiNetwork, o: GrpcObject, opts: ObjectOptions = {}): Promise<Record<string, unknown>> {
  if (opts.showDisplay) throw new Error('SUI bridge: showDisplay is not supported');
  const isPackage = o.objectType === 'package';
  const type = o.objectType ? (isPackage ? 'package' : shortType(o.objectType)) : undefined;
  const data: Record<string, unknown> = { objectId: o.objectId, version: String(o.version ?? ''), digest: o.digest };
  if (opts.showType) data.type = type;
  if (opts.showOwner) data.owner = renderOwner(o.owner);
  if (opts.showPreviousTransaction) data.previousTransaction = o.previousTransaction;
  if (opts.showStorageRebate) data.storageRebate = String(o.storageRebate ?? 0n);
  if ((opts.showContent || opts.showBcs) && !isPackage) {
    if (!o.objectType || !o.contents?.value) throw new Error(`SUI bridge: object ${o.objectId} came back without contents`);
    if (opts.showContent) {
      const v = renderMove(o.contents.value, await layoutOf(network, o.objectType)) as { fields: Record<string, unknown> };
      data.content = { dataType: 'moveObject', type, hasPublicTransfer: !!o.hasPublicTransfer, fields: v.fields };
    }
    if (opts.showBcs) {
      data.bcs = { dataType: 'moveObject', type, hasPublicTransfer: !!o.hasPublicTransfer, version: Number(o.version), bcsBytes: toBase64(o.contents.value) };
    }
  } else if (opts.showContent && isPackage) {
    data.content = { dataType: 'package', disassembled: {} };
  }
  return data;
}

async function getObjects(network: SuiNetwork, ids: string[], opts: ObjectOptions = {}): Promise<unknown[]> {
  if (ids.length === 0) return [];
  const { response } = await suiGrpcClient(network).ledgerService.batchGetObjects(
    { requests: ids.map((objectId) => ({ objectId })), readMask: OBJECT_MASK }, CALL,
  );
  return Promise.all(response.objects.map(async (r, i) => {
    if (r.result.oneofKind === 'object') return { data: await objectData(network, r.result.object as GrpcObject, opts) };
    const err = r.result.oneofKind === 'error' ? r.result.error : undefined;
    // 5 is NOT_FOUND; any other status is a failed read, not a missing object.
    if (err?.code === 5) return { error: { code: 'notExists', object_id: ids[i] } };
    throw new Error(`SUI gRPC: object ${ids[i]}: ${err?.message ?? 'no result'}`);
  }));
}

const pageToken = (cursor: unknown) => (typeof cursor === 'string' && cursor ? fromBase64(cursor) : undefined);
const page = (token?: Uint8Array) => ({ nextCursor: token?.length ? toBase64(token) : null, hasNextPage: !!token?.length });

// ── Transactions ──────────────────────────────────────────────────────────

type GrpcChanged = {
  objectId?: string; outputState?: number | string; outputVersion?: bigint | string; outputDigest?: string; outputOwner?: GrpcObject['owner'];
  idOperation?: number | string;
};
// Over gRPC an abort sits in the errorDetails oneof; in JSON it is a plain `abort` field.
type GrpcError = { description?: string; command?: bigint | string; errorDetails?: { oneofKind?: string; abort?: { abortCode?: bigint } }; abort?: { abortCode?: string } };
type GrpcEffects = {
  status?: { success?: boolean; error?: GrpcError };
  epoch?: bigint | string; gasUsed?: Record<string, bigint | string | undefined>; transactionDigest?: string; gasObject?: GrpcChanged; eventsDigest?: string;
  dependencies?: string[]; lamportVersion?: bigint | string; changedObjects?: GrpcChanged[];
};
type GrpcExecuted = {
  digest?: string; transaction?: { sender?: string; kind?: { data?: { oneofKind?: string } } }; signatures?: Array<{ bcs?: { value?: Uint8Array } }>;
  effects?: GrpcEffects; events?: { events?: Array<{ packageId?: string; module?: string; sender?: string; eventType?: string; contents?: { value?: Uint8Array } }> };
  checkpoint?: bigint; timestamp?: { seconds?: bigint; nanos?: number }; balanceChanges?: Array<{ address?: string; coinType?: string; amount?: string }>;
};
type TxOptions = { showEffects?: boolean; showEvents?: boolean; showBalanceChanges?: boolean; showInput?: boolean; showObjectChanges?: boolean; showRawInput?: boolean; showRawEffects?: boolean };

const TX_MASK = { paths: ['digest', 'transaction', 'signatures', 'effects', 'events', 'balance_changes', 'checkpoint', 'timestamp'] };
// Execute reads its mask against the executed transaction itself: the mainnet node refuses `transaction.effects`
// and the like with "invalid read_mask path" (measured 2026-11-13), which failed every signed transaction.
// Simulate answers with the transaction one level down and adds the command outputs.
const EXEC_MASK = TX_MASK;
const SIM_MASK = { paths: [...TX_MASK.paths.map((x) => `transaction.${x}`), 'command_outputs'] };
export const GRPC_MASKS = { tx: TX_MASK, exec: EXEC_MASK, sim: SIM_MASK } as const;

function errorText(e: GrpcError | undefined): string {
  if (!e) return 'unknown failure';
  const abort = e.errorDetails?.oneofKind === 'abort' ? e.errorDetails.abort?.abortCode : e.abort?.abortCode;
  const text = e.description || 'execution failed';
  const where = e.command !== undefined ? ` in command ${e.command}` : '';
  return abort !== undefined && !text.includes(String(abort)) ? `${text} (abort code ${abort})${where}` : `${text}${where}`;
}

export function renderEffects(e: GrpcEffects): Record<string, unknown> {
  const changed = e.changedObjects ?? [];
  const written = (c: GrpcChanged) => ({
    owner: renderOwner(c.outputOwner),
    reference: { objectId: c.objectId, version: Number(c.outputVersion), digest: c.outputDigest },
  });
  const g = e.gasUsed ?? {};
  // outputState 2 is an object write; idOperation 2 created, 3 deleted, 1 none.
  return {
    messageVersion: 'v1',
    status: e.status?.success ? { status: 'success' } : { status: 'failure', error: errorText(e.status?.error) },
    executedEpoch: String(e.epoch ?? ''),
    gasUsed: {
      computationCost: String(g.computationCost ?? 0n),
      storageCost: String(g.storageCost ?? 0n),
      storageRebate: String(g.storageRebate ?? 0n),
      nonRefundableStorageFee: String(g.nonRefundableStorageFee ?? 0n),
    },
    transactionDigest: e.transactionDigest,
    created: changed.filter((c) => en(c.idOperation, ID_OPERATION) === 2 && en(c.outputState, OUTPUT_STATE) === 2).map(written),
    mutated: changed.filter((c) => en(c.idOperation, ID_OPERATION) === 1 && en(c.outputState, OUTPUT_STATE) === 2).map(written),
    deleted: changed.filter((c) => en(c.idOperation, ID_OPERATION) === 3).map((c) => ({ objectId: c.objectId, version: Number(e.lamportVersion), digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })),
    gasObject: e.gasObject ? written(e.gasObject) : undefined,
    eventsDigest: e.eventsDigest,
    dependencies: e.dependencies ?? [],
  };
}

async function renderEvents(network: SuiNetwork, t: GrpcExecuted, timestampMs?: string): Promise<unknown[]> {
  return Promise.all((t.events?.events ?? []).map(async (ev, i) => ({
    id: { txDigest: t.digest, eventSeq: String(i) },
    packageId: ev.packageId,
    transactionModule: ev.module,
    sender: ev.sender,
    type: ev.eventType ? shortType(ev.eventType) : undefined,
    parsedJson: ev.eventType && ev.contents?.value ? plainJson(renderMove(ev.contents.value, await layoutOf(network, ev.eventType))) : undefined,
    bcsEncoding: 'base58',
    bcs: ev.contents?.value ? toBase58(ev.contents.value) : undefined,
    timestampMs,
  })));
}

async function txResponse(network: SuiNetwork, t: GrpcExecuted, opts: TxOptions = {}): Promise<Record<string, unknown>> {
  if (opts.showObjectChanges || opts.showRawInput || opts.showRawEffects) {
    throw new Error('SUI bridge: showObjectChanges, showRawInput and showRawEffects are not supported');
  }
  const timestampMs = t.timestamp?.seconds !== undefined
    ? String(Number(t.timestamp.seconds) * 1000 + Math.floor((t.timestamp.nanos ?? 0) / 1e6))
    : undefined;
  const out: Record<string, unknown> = { digest: t.digest };
  if (opts.showInput) {
    const kind = t.transaction?.kind?.data?.oneofKind;
    out.transaction = {
      data: { messageVersion: 'v1', sender: t.transaction?.sender, transaction: { kind: kind ? kind[0].toUpperCase() + kind.slice(1) : 'Unknown' } },
      txSignatures: (t.signatures ?? []).map((s) => (s.bcs?.value ? toBase64(s.bcs.value) : '')),
    };
  }
  if (opts.showEffects) {
    if (!t.effects) throw new Error(`SUI gRPC: transaction ${t.digest} came back without effects`);
    out.effects = renderEffects(t.effects);
  }
  if (opts.showEvents) out.events = await renderEvents(network, t, timestampMs);
  if (opts.showBalanceChanges) {
    out.balanceChanges = (t.balanceChanges ?? []).map((b) => ({
      owner: { AddressOwner: b.address }, coinType: b.coinType ? shortType(b.coinType) : undefined, amount: b.amount,
    }));
  }
  if (timestampMs) out.timestampMs = timestampMs;
  if (t.checkpoint !== undefined) out.checkpoint = String(t.checkpoint);
  return out;
}

/**
 * A transaction the fullnode has pruned (it keeps about two weeks), read from
 * GraphQL: its effects there are the gRPC effects message as JSON.
 */
async function archivedTransaction(network: SuiNetwork, digest: string): Promise<GrpcExecuted> {
  type Node = { sender: { address: string } | null; transactionModule: { name: string; package: { address: string } } | null; contents: { bcs: string; type: { repr: string } } };
  const d = await graphql<{ transaction: null | {
    digest: string; sender: { address: string } | null; kind: { __typename: string } | null;
    effects: { timestamp: string | null; checkpoint: { sequenceNumber: number } | null; effectsJson: GrpcEffects;
      balanceChangesJson: GrpcExecuted['balanceChanges'] | null; events: { pageInfo: { hasNextPage: boolean }; nodes: Node[] } } | null;
  } }>(
    network,
    `query($d: String!) { transaction(digest: $d) { digest sender { address } kind { __typename }
      effects { timestamp checkpoint { sequenceNumber } effectsJson balanceChangesJson
        events(first: 50) { pageInfo { hasNextPage } nodes { sender { address } transactionModule { name package { address } } contents { bcs type { repr } } } } } } }`,
    { d: digest },
  );
  const t = d.transaction;
  if (!t?.effects) throw new Error(`SUI: transaction ${digest} not found`);
  if (t.effects.events.pageInfo.hasNextPage) throw new Error(`SUI GraphQL: transaction ${digest} has more than 50 events`);
  const ms = t.effects.timestamp ? Date.parse(t.effects.timestamp) : NaN;
  const kind = t.kind?.__typename;
  return {
    digest: t.digest,
    transaction: { sender: t.sender?.address, kind: { data: { oneofKind: kind ? kind[0].toLowerCase() + kind.slice(1) : undefined } } },
    effects: t.effects.effectsJson,
    events: { events: t.effects.events.nodes.map((e) => ({
      packageId: e.transactionModule?.package.address, module: e.transactionModule?.name, sender: e.sender?.address,
      eventType: e.contents.type.repr, contents: { value: fromBase64(e.contents.bcs) },
    })) },
    checkpoint: t.effects.checkpoint ? BigInt(t.effects.checkpoint.sequenceNumber) : undefined,
    timestamp: Number.isFinite(ms) ? { seconds: BigInt(Math.floor(ms / 1000)), nanos: (ms % 1000) * 1e6 } : undefined,
    balanceChanges: t.effects.balanceChangesJson ?? [],
  };
}

async function getTransactions(network: SuiNetwork, digests: string[], opts: TxOptions): Promise<Array<Record<string, unknown>>> {
  if (digests.length === 0) return [];
  const { response } = await suiGrpcClient(network).ledgerService.batchGetTransactions({ digests, readMask: TX_MASK }, CALL);
  return Promise.all(response.transactions.map(async (r, i) => {
    if (r.result.oneofKind === 'transaction') return txResponse(network, r.result.transaction as GrpcExecuted, opts);
    const err = r.result.oneofKind === 'error' ? r.result.error : undefined;
    // 5 is NOT_FOUND: pruned from the fullnode, or not yet executed (waitForTransaction polls on).
    if (err?.code !== 5) throw new Error(`SUI gRPC: transaction ${digests[i]}: ${err?.message ?? 'no result'}`);
    return txResponse(network, await archivedTransaction(network, digests[i]), opts);
  }));
}

async function archivedCheckpoint(network: SuiNetwork, seq: number): Promise<unknown> {
  const d = await graphql<{ checkpoint: null | { digest: string; sequenceNumber: number; timestamp: string; networkTotalTransactions: number;
    previousCheckpointDigest: string | null; epoch: { epochId: number } | null; transactions: { pageInfo: { hasNextPage: boolean }; nodes: Array<{ digest: string }> } } }>(
    network,
    `query($s: UInt53!) { checkpoint(sequenceNumber: $s) { digest sequenceNumber timestamp networkTotalTransactions previousCheckpointDigest
      epoch { epochId } transactions(first: 50) { pageInfo { hasNextPage } nodes { digest } } } }`,
    { s: seq },
  );
  const c = d.checkpoint;
  if (!c) throw new Error(`SUI: checkpoint ${seq} not found`);
  if (c.transactions.pageInfo.hasNextPage) throw new Error(`SUI GraphQL: checkpoint ${seq} has more than 50 transactions`);
  return {
    epoch: String(c.epoch?.epochId ?? ''), sequenceNumber: String(c.sequenceNumber), digest: c.digest,
    networkTotalTransactions: String(c.networkTotalTransactions), previousDigest: c.previousCheckpointDigest ?? undefined,
    timestampMs: String(Date.parse(c.timestamp)), transactions: c.transactions.nodes.map((t) => t.digest),
  };
}

type GrpcSignatureBody = { type?: number; typeName?: string; typeParameterInstantiation: GrpcSignatureBody[]; typeParameter?: number };
const PRIMITIVE_NAMES = ['', 'Address', 'Bool', 'U8', 'U16', 'U32', 'U64', 'U128', 'U256'];

/** gRPC's open signature as JSON-RPC's normalized Move type (the transaction builder reads these). */
export function normalizedType(b: GrpcSignatureBody | undefined, reference?: number): unknown {
  if (!b) throw new Error('SUI gRPC: Move signature without a body');
  let t: unknown;
  if (b.type && b.type >= 1 && b.type <= 8) t = PRIMITIVE_NAMES[b.type];
  else if (b.type === 9) t = { Vector: normalizedType(b.typeParameterInstantiation[0]) };
  else if (b.type === 10) {
    const [address, module, name] = (b.typeName ?? '').split('::');
    t = { Struct: { address, module, name, typeArguments: b.typeParameterInstantiation.map((x) => normalizedType(x)) } };
  } else if (b.type === 11) t = { TypeParameter: b.typeParameter ?? 0 };
  else throw new Error(`SUI gRPC: unknown Move signature type ${b.type}`);
  return reference === 1 ? { Reference: t } : reference === 2 ? { MutableReference: t } : t;
}

/** A dev-inspect runs a transaction kind as `sender` with no gas and no checks. */
async function devInspect(network: SuiNetwork, sender: string, kindB64: string, gasPrice?: unknown): Promise<unknown> {
  const { Transaction } = await import('@mysten/sui/transactions');
  const grpc = suiGrpcClient(network);
  const tx = Transaction.fromKind(fromBase64(kindB64));
  tx.setSender(sender);
  tx.setGasPayment([]);
  tx.setGasBudget(50_000_000_000);
  tx.setGasPrice(gasPrice ? BigInt(gasPrice as string) : BigInt((await grpc.core.getReferenceGasPrice()).referenceGasPrice));
  // The kind's inputs are resolved already, so it builds with no client.
  const bytes = await tx.build();
  const { response } = await grpc.transactionExecutionService.simulateTransaction(
    { transaction: { bcs: { value: bytes } }, readMask: SIM_MASK, checks: 1 /* DISABLED */, doGasSelection: false }, CALL,
  );
  const t = response.transaction as GrpcExecuted;
  const out = await txResponse(network, t, { showEffects: true, showEvents: true });
  const out2 = (o: { value?: { name?: string; value?: Uint8Array } }) => [Array.from(o.value?.value ?? []), o.value?.name ? shortType(o.value.name) : ''];
  return {
    effects: out.effects,
    events: out.events,
    results: response.commandOutputs.map((c) => ({
      returnValues: c.returnValues.map(out2),
      mutableReferenceOutputs: c.mutatedByRef.map((m) => [m.argument, ...out2(m)]),
    })),
    error: t.effects?.status?.success ? undefined : errorText(t.effects?.status?.error),
  };
}

// ── The methods ───────────────────────────────────────────────────────────

/** Answer one SUI JSON-RPC request; throws when it cannot. */
export async function callSuiJsonRpc(network: SuiNetwork, method: string, params: unknown[] = []): Promise<unknown> {
  const grpc = suiGrpcClient(network);
  const p = params as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (method) {
    case 'sui_getObject':
      return (await getObjects(network, [p[0]], p[1]))[0];
    case 'sui_multiGetObjects':
      return getObjects(network, p[0], p[1]);
    case 'suix_getDynamicFieldObject': {
      const [parentId, name] = p as [string, { type: string; value: unknown }];
      const key = Uint8Array.from(encodeMove(await layoutOf(network, name.type), name.value));
      const id = deriveDynamicFieldID(parentId, name.type, key);
      const [res] = (await getObjects(network, [id], { showContent: true, showType: true, showOwner: true })) as Array<{ error?: unknown }>;
      return res.error ? { error: { code: 'dynamicFieldNotFound', parent_object_id: parentId } } : res;
    }
    case 'suix_getDynamicFields': {
      const [parent, cursor, limit] = p;
      const { response } = await grpc.stateService.listDynamicFields(
        { parent, pageSize: limit ?? 50, pageToken: pageToken(cursor), readMask: { paths: ['kind', 'field_id', 'name', 'value_type', 'child_id', 'field_object'] } }, CALL,
      );
      const data = await Promise.all(response.dynamicFields.map(async (f) => {
        if (!f.name?.name || !f.name.value) throw new Error('SUI gRPC: dynamic field without a name');
        const isObject = f.kind === 2;
        return {
          name: { type: shortType(f.name.name), value: plainJson(renderMove(f.name.value, await layoutOf(network, f.name.name))) },
          bcsName: toBase58(f.name.value),
          type: isObject ? 'DynamicObject' : 'DynamicField',
          objectType: f.valueType ? shortType(f.valueType) : undefined,
          objectId: isObject ? f.childId : f.fieldId,
          version: Number(f.fieldObject?.version ?? 0n),
          digest: f.fieldObject?.digest,
        };
      }));
      return { data, ...page(response.nextPageToken) };
    }
    case 'suix_getOwnedObjects': {
      const [owner, query, cursor, limit] = p as [string, { filter?: Record<string, unknown>; options?: ObjectOptions } | null, unknown, number?];
      const filter = query?.filter;
      let objectType: string | undefined;
      if (filter && typeof filter.StructType === 'string') objectType = filter.StructType;
      else if (filter && !(Array.isArray(filter.MatchAll) && filter.MatchAll.length === 0)) {
        throw new Error(`SUI bridge: owned-object filter not supported: ${JSON.stringify(filter)}`);
      }
      const { response } = await grpc.stateService.listOwnedObjects(
        { owner, objectType, pageSize: limit ?? 50, pageToken: pageToken(cursor), readMask: OBJECT_MASK }, CALL,
      );
      const data = await Promise.all(response.objects.map(async (o) => ({ data: await objectData(network, o as GrpcObject, query?.options ?? {}) })));
      return { data, ...page(response.nextPageToken) };
    }
    case 'suix_getCoins': {
      const [owner, coinType = '0x2::sui::SUI', cursor, limit] = p;
      const { response } = await grpc.stateService.listOwnedObjects(
        { owner, objectType: `0x2::coin::Coin<${coinType}>`, pageSize: limit ?? 50, pageToken: pageToken(cursor), readMask: { paths: ['object_id', 'version', 'digest', 'balance', 'contents', 'previous_transaction'] } }, CALL,
      );
      const data = response.objects.map((o) => {
        // Coin is { id: UID, balance: u64 }: the balance follows the 32-byte id.
        const balance = o.balance ?? (o.contents?.value ? new Reader(o.contents.value.subarray(32)).uint(8) : undefined);
        if (balance === undefined) throw new Error(`SUI gRPC: coin ${o.objectId} came back without a balance`);
        return { coinType, coinObjectId: o.objectId, version: String(o.version), digest: o.digest, balance: String(balance), previousTransaction: o.previousTransaction };
      });
      return { data, ...page(response.nextPageToken) };
    }
    case 'suix_getBalance': {
      const [owner, coinType = '0x2::sui::SUI'] = p;
      const { response } = await grpc.stateService.getBalance({ owner, coinType }, CALL);
      return { coinType, totalBalance: String(response.balance?.balance ?? 0n), lockedBalance: {} };
    }
    case 'suix_getAllBalances': {
      const rows: unknown[] = [];
      let token: Uint8Array | undefined;
      do {
        const { response } = await grpc.stateService.listBalances({ owner: p[0], pageSize: 100, pageToken: token }, CALL);
        for (const b of response.balances) rows.push({ coinType: shortType(b.coinType ?? ''), totalBalance: String(b.balance ?? 0n), lockedBalance: {} });
        token = response.nextPageToken?.length ? response.nextPageToken : undefined;
      } while (token);
      return rows;
    }
    case 'suix_getCoinMetadata': {
      try {
        const { response } = await grpc.stateService.getCoinInfo({ coinType: p[0] }, CALL);
        const m = response.metadata;
        if (!m) return null;
        return { decimals: m.decimals, name: m.name, symbol: m.symbol, description: m.description, iconUrl: m.iconUrl || null, id: m.id ?? null };
      } catch (e) {
        if ((e as { code?: string }).code === 'NOT_FOUND') return null;
        throw e;
      }
    }
    case 'sui_getNormalizedMoveFunction': {
      const [packageId, moduleName, name] = p as [string, string, string];
      const { response } = await grpc.movePackageService.getFunction({ packageId, moduleName, name }, CALL);
      const f = response.function;
      if (!f) throw new Error(`SUI gRPC: no function ${packageId}::${moduleName}::${name}`);
      const ABILITY = ['', 'Copy', 'Drop', 'Store', 'Key'];
      return {
        visibility: ['', 'Private', 'Public', 'Friend'][f.visibility ?? 0] || 'Private',
        isEntry: !!f.isEntry,
        typeParameters: f.typeParameters.map((tp) => ({ abilities: tp.constraints.map((a) => ABILITY[a]) })),
        parameters: f.parameters.map((x) => normalizedType(x.body as GrpcSignatureBody, x.reference)),
        return: f.returns.map((x) => normalizedType(x.body as GrpcSignatureBody, x.reference)),
      };
    }
    case 'suix_getReferenceGasPrice':
      return String((await grpc.core.getReferenceGasPrice()).referenceGasPrice);
    case 'sui_getChainIdentifier': {
      const { response } = await grpc.ledgerService.getServiceInfo({}, CALL);
      if (!response.chainId) throw new Error('SUI gRPC: no chain id');
      // JSON-RPC's identifier is the first four bytes of the genesis checkpoint digest.
      return hex(fromBase58(response.chainId).subarray(0, 4)).slice(2);
    }
    case 'sui_getLatestCheckpointSequenceNumber': {
      const { response } = await grpc.ledgerService.getServiceInfo({}, CALL);
      return String(response.checkpointHeight);
    }
    case 'sui_getCheckpoint':
    case 'sui_getTotalTransactionBlocks': {
      const checkpointId = method === 'sui_getCheckpoint'
        ? (/^\d+$/.test(String(p[0])) ? { oneofKind: 'sequenceNumber' as const, sequenceNumber: BigInt(p[0]) } : { oneofKind: 'digest' as const, digest: String(p[0]) })
        : { oneofKind: undefined };
      let response;
      try {
        ({ response } = await grpc.ledgerService.getCheckpoint({ checkpointId, readMask: { paths: ['sequence_number', 'digest', 'summary', 'contents'] } }, CALL));
      } catch (e) {
        // Pruned from the fullnode: checkpoint 0 is how the SDK reads the chain id.
        if ((e as { code?: string }).code !== 'NOT_FOUND' || checkpointId.oneofKind !== 'sequenceNumber') throw e;
        return archivedCheckpoint(network, Number(checkpointId.sequenceNumber));
      }
      const c = response.checkpoint;
      const s = c?.summary;
      if (!c || !s) throw new Error('SUI gRPC: checkpoint came back empty');
      if (method === 'sui_getTotalTransactionBlocks') return String(s.totalNetworkTransactions);
      return {
        epoch: String(s.epoch), sequenceNumber: String(c.sequenceNumber), digest: c.digest, networkTotalTransactions: String(s.totalNetworkTransactions),
        previousDigest: s.previousDigest, timestampMs: String(Number(s.timestamp?.seconds ?? 0n) * 1000 + Math.floor((s.timestamp?.nanos ?? 0) / 1e6)),
        transactions: (c.contents?.transactions ?? []).map((t) => t.transaction),
      };
    }
    case 'sui_getTransactionBlock':
      return (await getTransactions(network, [p[0]], p[1] ?? {}))[0];
    case 'sui_multiGetTransactionBlocks':
      return getTransactions(network, p[0], p[1] ?? {});
    case 'sui_executeTransactionBlock': {
      const [txB64, signatures, opts] = p as [string, string[], TxOptions?];
      const { response } = await grpc.transactionExecutionService.executeTransaction({
        transaction: { bcs: { value: fromBase64(txB64) } },
        signatures: signatures.map((s) => ({ bcs: { value: fromBase64(s) }, signature: { oneofKind: undefined } })),
        readMask: EXEC_MASK,
      }, CALL);
      if (!response.transaction) throw new Error('SUI gRPC: execution returned no transaction');
      // The fullnode answers once the transaction is final and executed locally.
      return { ...(await txResponse(network, response.transaction as GrpcExecuted, opts ?? {})), confirmedLocalExecution: true };
    }
    case 'sui_dryRunTransactionBlock': {
      const { response } = await grpc.transactionExecutionService.simulateTransaction(
        { transaction: { bcs: { value: fromBase64(p[0]) } }, readMask: SIM_MASK, checks: 0 /* ENABLED */, doGasSelection: false }, CALL,
      );
      if (!response.transaction) throw new Error('SUI gRPC: simulation returned no transaction');
      const out = await txResponse(network, response.transaction as GrpcExecuted, { showEffects: true, showEvents: true, showBalanceChanges: true });
      return { ...out, objectChanges: [], input: undefined };
    }
    case 'sui_devInspectTransactionBlock':
      return devInspect(network, p[0], p[1], p[2]);
    case 'suix_queryEvents': {
      const [query, cursor, limit, descending] = p as [{ MoveEventType?: string }, string | null, number?, boolean?];
      if (!query?.MoveEventType) throw new Error(`SUI bridge: event filter not supported: ${JSON.stringify(query)}`);
      const n = limit ?? 50;
      const d = await graphql<{ events: { pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
        nodes: Array<{ sequenceNumber: number; timestamp: string | null; sender: { address: string } | null; transaction: { digest: string } | null;
          transactionModule: { name: string; package: { address: string } } | null; contents: { json: unknown; type: { repr: string } } }> } }>(
        network,
        `query($t: String!, $n: Int!, $c: String) { events(${descending ? 'last: $n, before: $c' : 'first: $n, after: $c'}, filter: { type: $t }) {
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
          nodes { sequenceNumber timestamp sender { address } transaction { digest } transactionModule { name package { address } } contents { json type { repr } } } } }`,
        { t: query.MoveEventType, n, c: cursor ?? null },
      );
      const nodes = descending ? [...d.events.nodes].reverse() : d.events.nodes;
      const more = descending ? d.events.pageInfo.hasPreviousPage : d.events.pageInfo.hasNextPage;
      return {
        data: nodes.map((e) => ({
          id: { txDigest: e.transaction?.digest, eventSeq: String(e.sequenceNumber) },
          packageId: e.transactionModule?.package.address, transactionModule: e.transactionModule?.name, sender: e.sender?.address,
          type: shortType(e.contents.type.repr), parsedJson: e.contents.json, timestampMs: e.timestamp ? String(Date.parse(e.timestamp)) : undefined,
        })),
        nextCursor: more ? (descending ? d.events.pageInfo.startCursor : d.events.pageInfo.endCursor) : null,
        hasNextPage: more,
      };
    }
    case 'suix_queryTransactionBlocks': {
      const [query, cursor, limit, descending] = p as [{ filter?: { FromAddress?: string }; options?: TxOptions }, string | null, number?, boolean?];
      const from = query?.filter?.FromAddress;
      if (!from) throw new Error(`SUI bridge: transaction filter not supported: ${JSON.stringify(query?.filter)}`);
      const d = await graphql<{ transactions: { pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }; nodes: Array<{ digest: string }> } }>(
        network,
        `query($a: SuiAddress!, $n: Int!, $c: String) { transactions(${descending ? 'last: $n, before: $c' : 'first: $n, after: $c'}, filter: { sentAddress: $a }) {
          pageInfo { hasNextPage hasPreviousPage startCursor endCursor } nodes { digest } } }`,
        { a: from, n: limit ?? 50, c: cursor ?? null },
      );
      const digests = d.transactions.nodes.map((t) => t.digest);
      const more = descending ? d.transactions.pageInfo.hasPreviousPage : d.transactions.pageInfo.hasNextPage;
      return {
        data: await getTransactions(network, descending ? digests.reverse() : digests, query.options ?? {}),
        nextCursor: more ? (descending ? d.transactions.pageInfo.startCursor : d.transactions.pageInfo.endCursor) : null,
        hasNextPage: more,
      };
    }
    default:
      throw new Error(`SUI bridge: ${method} is not available`);
  }
}

/** The bridge as a JSON-RPC HTTP exchange: the raw helper and the browser proxy speak this. */
export async function suiJsonRpcResponse(network: SuiNetwork, body: string): Promise<Response> {
  let req: { id?: unknown; method?: unknown; params?: unknown };
  try {
    req = JSON.parse(body);
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
  }
  if (Array.isArray(req) || typeof req.method !== 'string') {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }, { status: 400 });
  }
  try {
    const result = await callSuiJsonRpc(network, req.method, Array.isArray(req.params) ? req.params : []);
    return Response.json({ jsonrpc: '2.0', id: req.id ?? null, result });
  } catch (e) {
    // A failed read is a failure: 502, so a caller that checks the status and
    // one that checks `error` both stop.
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ jsonrpc: '2.0', id: req.id ?? null, error: { code: -32000, message } }, { status: 502 });
  }
}
