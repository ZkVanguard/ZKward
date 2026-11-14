/** Base58 (the Bitcoin alphabet), as Solana writes keys and signatures. Shared by the Solana pool and the perp venue client. */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** The inverse of `base58Encode`. Throws on a character outside the alphabet. */
export function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const ch of text) {
    const digit = B58.indexOf(ch);
    if (digit < 0) throw new Error('not base58');
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of text) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return new Uint8Array(bytes);
}

/** Base58, as Solana writes signatures and addresses. */
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}
