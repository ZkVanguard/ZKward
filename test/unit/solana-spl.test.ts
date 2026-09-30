/**
 * Known-answer tests for the local SPL instruction builders (spl.ts).
 * Pins the exact encodings spl-token 0.4.x produced — differential-tested
 * byte-identical over 2,000 random cases before the dependency was removed.
 */
import { describe, it, expect } from '@jest/globals';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  createMintToInstruction,
} from '@/lib/services/solana/spl';

const VAULT = new PublicKey('5sbvfzEwweu8YDKpnPeMuvL13Xwq4XER5CkJcKJQfcVM');
const MINT = new PublicKey('UqvJ6qknca1wwF2gL2zQrCp7LRRzdHzyaqn7P57YxQP');
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const pk = () => Keypair.generate().publicKey;

describe('spl builders', () => {
  it('derives the real devnet vault ATA (chain-verified address)', () => {
    expect(getAssociatedTokenAddressSync(MINT, VAULT).toBase58()).toBe(
      'Ajzhp3AXQEwt9KiEsrqremjVjJX4AFCgQNX8H8uZe9oa',
    );
  });

  it('rejects off-curve (PDA) owners like spl-token', () => {
    const pda = getAssociatedTokenAddressSync(MINT, VAULT); // ATAs are PDAs → off-curve
    expect(() => getAssociatedTokenAddressSync(MINT, pda)).toThrow(/off-curve/);
  });

  it('transfer: discriminator 3 + u64 LE amount, [src w, dst w, owner s]', () => {
    const [s, d, o] = [pk(), pk(), pk()];
    const ix = createTransferInstruction(s, d, o, 50_000_000_000n);
    expect(ix.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(hex(ix.data)).toBe('03' + '00743ba40b000000');
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [s.toBase58(), false, true],
      [d.toBase58(), false, true],
      [o.toBase58(), true, false],
    ]);
  });

  it('mintTo: discriminator 7, [mint w, dst w, authority s]', () => {
    const [m, d, a] = [pk(), pk(), pk()];
    const ix = createMintToInstruction(m, d, a, 1n);
    expect(hex(ix.data)).toBe('07' + '0100000000000000');
    expect(ix.keys.map((k) => [k.isSigner, k.isWritable])).toEqual([
      [false, true],
      [false, true],
      [true, false],
    ]);
  });

  it('u64 bounds: max encodes, negative and overflow throw', () => {
    const [a, b, c] = [pk(), pk(), pk()];
    expect(hex(createTransferInstruction(a, b, c, 2n ** 64n - 1n).data)).toBe('03ffffffffffffffff');
    expect(() => createTransferInstruction(a, b, c, -1n)).toThrow(RangeError);
    expect(() => createTransferInstruction(a, b, c, 2n ** 64n)).toThrow(RangeError);
  });

  it('ATA create-idempotent: data [1], six keys in program order', () => {
    const [payer, ata, owner, mint] = [pk(), pk(), pk(), pk()];
    const ix = createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint);
    expect(ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(true);
    expect(hex(ix.data)).toBe('01');
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [payer.toBase58(), true, true],
      [ata.toBase58(), false, true],
      [owner.toBase58(), false, false],
      [mint.toBase58(), false, false],
      [SystemProgram.programId.toBase58(), false, false],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
    ]);
  });
});
