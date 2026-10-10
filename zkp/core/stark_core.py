"""
STARK building blocks: field, extension field, NTT, Merkle tree, transcript, FRI folding.

Everything a STARK needs that is not specific to one statement. The protocol
that uses these is in `hedge_stark.py`. Design follows:

  - ethSTARK Documentation v1.2 (IACR ePrint 2021/582): the overall recipe
  - DEEP-FRI (ePrint 2019/336): out-of-domain sampling
  - FRI (ePrint 2018/828): the low-degree test

Field: Goldilocks, p = 2^64 - 2^32 + 1. A 64-bit field is too small to draw
verifier challenges from (a cheating prover would succeed once in about 2^64
tries per challenge), so every challenge lives in the quadratic extension
K = Fp[u] / (u^2 - 7), which has about 2^128 elements.

Hash: SHA-256 everywhere. No other assumption: no pairings, no setup.
"""
import hashlib
from typing import List, Sequence, Tuple

P = 0xFFFFFFFF00000001          # 2^64 - 2^32 + 1
GENERATOR = 7                   # generates the multiplicative group of Fp
NONRESIDUE = 7                  # u^2 = 7 defines the extension
TWO_ADICITY = 32

# 7 is not a square mod p, so x^2 - 7 is irreducible and K is a field.
assert pow(NONRESIDUE, (P - 1) // 2, P) == P - 1

K = Tuple[int, int]             # a + b*u
K_ZERO: K = (0, 0)
K_ONE: K = (1, 0)


# ── Fp ───────────────────────────────────────────────────────────────

def inv(a: int) -> int:
    a %= P
    if a == 0:
        raise ZeroDivisionError("inverse of zero in Fp")
    return pow(a, P - 2, P)


def batch_inv(values: Sequence[int]) -> List[int]:
    """Inverses of many nonzero field elements with one exponentiation."""
    prefix = [1] * (len(values) + 1)
    for i, v in enumerate(values):
        prefix[i + 1] = prefix[i] * v % P
    acc = inv(prefix[-1])
    out = [0] * len(values)
    for i in range(len(values) - 1, -1, -1):
        out[i] = acc * prefix[i] % P
        acc = acc * values[i] % P
    return out


def root_of_unity(n: int) -> int:
    """A primitive n-th root of unity, n a power of two up to 2^32."""
    if n <= 0 or n & (n - 1) or n > (1 << TWO_ADICITY):
        raise ValueError(f"no root of unity of order {n}")
    return pow(GENERATOR, (P - 1) // n, P)


# ── K = Fp[u]/(u^2 - 7) ──────────────────────────────────────────────

def k_add(a: K, b: K) -> K:
    return ((a[0] + b[0]) % P, (a[1] + b[1]) % P)


def k_sub(a: K, b: K) -> K:
    return ((a[0] - b[0]) % P, (a[1] - b[1]) % P)


def k_mul(a: K, b: K) -> K:
    return ((a[0] * b[0] + NONRESIDUE * a[1] * b[1]) % P, (a[0] * b[1] + a[1] * b[0]) % P)


def k_scale(a: K, s: int) -> K:
    return (a[0] * s % P, a[1] * s % P)


def k_inv(a: K) -> K:
    norm = (a[0] * a[0] - NONRESIDUE * a[1] * a[1]) % P
    n = inv(norm)  # nonzero for a != 0, because 7 is not a square
    return (a[0] * n % P, (-a[1]) * n % P)


def k_pow(a: K, e: int) -> K:
    out = K_ONE
    while e:
        if e & 1:
            out = k_mul(out, a)
        a = k_mul(a, a)
        e >>= 1
    return out


def k_from(x: int) -> K:
    return (x % P, 0)


def k_bytes(a: K) -> bytes:
    return a[0].to_bytes(8, 'little') + a[1].to_bytes(8, 'little')


def fp_poly_at_k(coeffs: Sequence[int], x: K) -> K:
    """A polynomial with Fp coefficients at a point of K (Horner)."""
    acc = K_ZERO
    for c in reversed(coeffs):
        acc = k_mul(acc, x)
        acc = ((acc[0] + c) % P, acc[1])
    return acc


def k_poly_at_k(coeffs: Sequence[K], x: K) -> K:
    acc = K_ZERO
    for c in reversed(coeffs):
        acc = k_add(k_mul(acc, x), c)
    return acc


def k_poly_at_fp(coeffs: Sequence[K], x: int) -> K:
    re = im = 0
    for c in reversed(coeffs):
        re = (re * x + c[0]) % P
        im = (im * x + c[1]) % P
    return (re, im)


# ── NTT ──────────────────────────────────────────────────────────────

def ntt(values: Sequence[int], omega: int) -> List[int]:
    """Evaluate the polynomial with these coefficients on <omega> (size a power of two)."""
    a = list(values)
    n = len(a)
    if n & (n - 1):
        raise ValueError("NTT size must be a power of two")
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j |= bit
        if i < j:
            a[i], a[j] = a[j], a[i]
    length = 2
    while length <= n:
        step = pow(omega, n // length, P)
        half = length >> 1
        for start in range(0, n, length):
            w = 1
            for k in range(start, start + half):
                u = a[k]
                v = a[k + half] * w % P
                a[k] = (u + v) % P
                a[k + half] = (u - v) % P
                w = w * step % P
        length <<= 1
    return a


def intt(values: Sequence[int], omega: int) -> List[int]:
    """Coefficients of the polynomial with these values on <omega>."""
    n_inv = inv(len(values))
    return [v * n_inv % P for v in ntt(values, inv(omega))]


def coset_evaluate(coeffs: Sequence[int], size: int, shift: int) -> List[int]:
    """Values of a polynomial on the coset shift*<omega_size>."""
    if len(coeffs) > size:
        raise ValueError("polynomial does not fit the domain")
    scaled = [0] * size
    s = 1
    for i, c in enumerate(coeffs):
        scaled[i] = c * s % P
        s = s * shift % P
    return ntt(scaled, root_of_unity(size))


def coset_interpolate(values: Sequence[int], shift: int) -> List[int]:
    """Coefficients of the polynomial with these values on shift*<omega>."""
    coeffs = intt(values, root_of_unity(len(values)))
    s_inv = inv(shift)
    s = 1
    for i in range(len(coeffs)):
        coeffs[i] = coeffs[i] * s % P
        s = s * s_inv % P
    return coeffs


# ── Merkle tree (position-binding, domain-separated) ─────────────────
#
# A leaf hash commits to its own index, and a path is only sibling hashes:
# which side each sibling is on comes from the index's bits, never from the
# prover. Leaf and node hashes use different prefixes, so an inner node can
# never be passed off as a leaf.

def leaf_hash(index: int, data: bytes) -> bytes:
    return hashlib.sha256(b'\x00' + index.to_bytes(8, 'little') + data).digest()


def _node_hash(left: bytes, right: bytes) -> bytes:
    return hashlib.sha256(b'\x01' + left + right).digest()


class MerkleTree:
    def __init__(self, leaf_hashes: Sequence[bytes]):
        n = len(leaf_hashes)
        if n == 0 or n & (n - 1):
            raise ValueError("leaf count must be a power of two")
        self.layers: List[List[bytes]] = [list(leaf_hashes)]
        while len(self.layers[-1]) > 1:
            prev = self.layers[-1]
            self.layers.append([_node_hash(prev[i], prev[i + 1]) for i in range(0, len(prev), 2)])

    @property
    def root(self) -> bytes:
        return self.layers[-1][0]

    def open(self, index: int) -> List[bytes]:
        path = []
        for layer in self.layers[:-1]:
            path.append(layer[index ^ 1])
            index >>= 1
        return path


def merkle_verify(root: bytes, index: int, leaf: bytes, path: Sequence[bytes], depth: int) -> bool:
    """True when `leaf` (a leaf hash) is at `index` under `root`. The path length is fixed by the tree."""
    if len(path) != depth or index < 0 or index >> depth:
        return False
    node = leaf
    for sibling in path:
        if not isinstance(sibling, (bytes, bytearray)) or len(sibling) != 32:
            return False
        node = _node_hash(sibling, node) if index & 1 else _node_hash(node, sibling)
        index >>= 1
    return node == root


# ── Fiat-Shamir transcript ───────────────────────────────────────────
#
# Prover and verifier run the same transcript over the same messages, so the
# verifier derives every challenge itself. Nothing random is ever read from
# a proof.

class Transcript:
    def __init__(self, statement: bytes):
        self.state = hashlib.sha256(b'zkward-stark-3\x00' + statement).digest()

    def absorb(self, label: bytes, data: bytes) -> None:
        self.state = hashlib.sha256(
            self.state + b'\x01' + len(label).to_bytes(2, 'little') + label + len(data).to_bytes(8, 'little') + data
        ).digest()

    def _draw(self) -> bytes:
        self.state = hashlib.sha256(self.state + b'\x02').digest()
        return hashlib.sha256(self.state + b'\x03').digest()

    def draw_fp(self) -> int:
        while True:
            v = int.from_bytes(self._draw()[:8], 'little')
            if v < P:           # rejected about once in 2^32 draws; keeps the value uniform
                return v

    def draw_k(self) -> K:
        return (self.draw_fp(), self.draw_fp())

    def draw_index(self, bound: int) -> int:
        """A uniform index below `bound`, a power of two."""
        return int.from_bytes(self._draw()[:8], 'little') & (bound - 1)

    def grind(self, bits: int) -> int:
        """Find and absorb a nonce whose hash with the state has `bits` leading zero bits."""
        nonce = 0
        while not self._pow_ok(nonce, bits):
            nonce += 1
        self.absorb(b'pow', nonce.to_bytes(8, 'little'))
        return nonce

    def check_grind(self, nonce: int, bits: int) -> bool:
        if not self._pow_ok(nonce, bits):
            return False
        self.absorb(b'pow', nonce.to_bytes(8, 'little'))
        return True

    def _pow_ok(self, nonce: int, bits: int) -> bool:
        digest = hashlib.sha256(self.state + b'\x04' + nonce.to_bytes(8, 'little')).digest()
        return int.from_bytes(digest, 'big') >> (256 - bits) == 0 if bits > 0 else True


# ── FRI folding ──────────────────────────────────────────────────────

INV2 = inv(2)


def fold_pair(a: K, b: K, beta: K, x: int) -> K:
    """
    One FRI fold. With a = f(x) and b = f(-x):
        f'(x^2) = (a + b)/2 + beta * (a - b)/(2x)
    """
    even = k_scale(k_add(a, b), INV2)
    odd = k_scale(k_sub(a, b), INV2 * inv(x) % P)
    return k_add(even, k_mul(beta, odd))


def fold_layer(values: Sequence[K], beta: K, shift: int) -> List[K]:
    """Fold a whole layer given on the coset shift*<omega>; the result lives on shift^2*<omega^2>."""
    m = len(values)
    half = m // 2
    omega_inv = inv(root_of_unity(m))
    x_inv = inv(shift)
    out: List[K] = []
    for i in range(half):
        a = values[i]
        b = values[i + half]
        d = INV2 * x_inv % P
        even = ((a[0] + b[0]) * INV2 % P, (a[1] + b[1]) * INV2 % P)
        odd = ((a[0] - b[0]) * d % P, (a[1] - b[1]) * d % P)
        out.append(k_add(even, k_mul(beta, odd)))
        x_inv = x_inv * omega_inv % P
    return out
