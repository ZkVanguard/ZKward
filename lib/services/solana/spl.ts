/**
 * Minimal SPL Token + Associated Token Account instruction builders.
 *
 * Replaces @solana/spl-token: its @solana/buffer-layout-utils dependency
 * pulls bigint-buffer — a native install-script package with an unpatched
 * HIGH buffer-overflow advisory — which the supply-chain gate blocks. The
 * pool needs four fixed-layout instructions; these match spl-token 0.4.x
 * byte-for-byte (differential-tested before removal; known-answer tests pin
 * the encodings, incl. the real devnet vault ATA).
 *
 * Shared by server (vault signer) and browser (wallet deposit builder), so
 * it imports only @solana/web3.js and the `buffer` module.
 */
import { Buffer } from 'buffer';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

// SPL Token program instruction discriminators
const IX_TRANSFER = 3;
const IX_MINT_TO = 7;
// Associated Token Account program: 0 = Create, 1 = CreateIdempotent
const ATA_CREATE_IDEMPOTENT = 1;

const U64_MAX = 0xffff_ffff_ffff_ffffn;

function u64Instruction(discriminator: number, amount: bigint): Buffer {
  if (amount < 0n || amount > U64_MAX) throw new RangeError(`u64 out of range: ${amount}`);
  const data = new Uint8Array(9);
  data[0] = discriminator;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  return Buffer.from(data);
}

/** ATA address. Rejects off-curve owners like spl-token (a PDA can't sign for its account). */
export function getAssociatedTokenAddressSync(mint: PublicKey, owner: PublicKey): PublicKey {
  if (!PublicKey.isOnCurve(owner.toBuffer())) {
    throw new Error(`token owner ${owner.toBase58()} is off-curve`);
  }
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

export function createAssociatedTokenAccountIdempotentInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([ATA_CREATE_IDEMPOTENT]),
  });
}

export function createTransferInstruction(
  source: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: u64Instruction(IX_TRANSFER, amount),
  });
}

export function createMintToInstruction(
  mint: PublicKey,
  destination: PublicKey,
  authority: PublicKey,
  amount: bigint,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: u64Instruction(IX_MINT_TO, amount),
  });
}
