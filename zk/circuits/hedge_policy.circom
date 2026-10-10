pragma circom 2.1.9;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/bitify.circom";

/*
 * Hedge policy proof, version 2 of the hedge commitment.
 *
 * Statement: "I know a hedge whose Poseidon commitment is `commitment`, and
 * that hedge is inside the vault's rules":
 *   - its asset is on the allow-list and its side is long or short;
 *   - its leverage is at least 1 and at most `leverageCap`;
 *   - its notional is at most `notionalCapCents`;
 *   - its notional is not understated: notional >= size * entry price.
 *
 * Public:  commitment, leverageCap, notionalCapCents.
 * Private: everything about the hedge itself.
 *
 * What this does NOT say: that the order sent to a venue is this hedge. The
 * commitment is recorded with the hedge before the order; the opening can be
 * shown to an auditor. The circuit binds the rules to the commitment, and
 * nothing else.
 *
 * Units (the same on every asset, so one circuit covers them all):
 *   sizeMicro         asset units x 1e6
 *   entryPriceCents   USD cents per one asset unit
 *   notionalCents     USD cents
 *   leverageX         whole multiples
 *
 * Every private value is range-checked before it is compared: the
 * comparison gadgets are only sound for inputs that fit their bit width.
 */
template HedgePolicy() {
    // ── public ──
    signal input commitment;
    signal input leverageCap;
    signal input notionalCapCents;

    // ── private ──
    signal input assetCode;        // 1 BTC, 2 ETH, 3 SUI, 4 SOL (never renumber)
    signal input sideCode;         // 0 long, 1 short
    signal input sizeMicro;
    signal input leverageX;
    signal input entryPriceCents;
    signal input notionalCents;
    signal input portfolioId;
    signal input timestampMs;
    signal input salt;

    // 1. The commitment opens to exactly these values.
    component hash = Poseidon(9);
    hash.inputs[0] <== assetCode;
    hash.inputs[1] <== sideCode;
    hash.inputs[2] <== sizeMicro;
    hash.inputs[3] <== leverageX;
    hash.inputs[4] <== entryPriceCents;
    hash.inputs[5] <== notionalCents;
    hash.inputs[6] <== portfolioId;
    hash.inputs[7] <== timestampMs;
    hash.inputs[8] <== salt;
    commitment === hash.out;

    // 2. Asset on the allow-list: (a-1)(a-2)(a-3)(a-4) = 0.
    signal a12;
    signal a34;
    a12 <== (assetCode - 1) * (assetCode - 2);
    a34 <== (assetCode - 3) * (assetCode - 4);
    a12 * a34 === 0;

    // 3. Side is a bit.
    sideCode * (sideCode - 1) === 0;

    // 4. Ranges. Widths: leverage 8 bits, money and size 64 bits.
    component levBits = Num2Bits(8);
    levBits.in <== leverageX;
    component capBits = Num2Bits(8);
    capBits.in <== leverageCap;
    component sizeBits = Num2Bits(64);
    sizeBits.in <== sizeMicro;
    component priceBits = Num2Bits(64);
    priceBits.in <== entryPriceCents;
    component notionalBits = Num2Bits(64);
    notionalBits.in <== notionalCents;
    component notionalCapBits = Num2Bits(64);
    notionalCapBits.in <== notionalCapCents;
    component pidBits = Num2Bits(32);
    pidBits.in <== portfolioId;
    component tsBits = Num2Bits(64);
    tsBits.in <== timestampMs;
    component saltBits = Num2Bits(248);
    saltBits.in <== salt;

    // 5. 1 <= leverage <= cap.
    component levAtLeastOne = GreaterEqThan(8);
    levAtLeastOne.in[0] <== leverageX;
    levAtLeastOne.in[1] <== 1;
    levAtLeastOne.out === 1;
    component levUnderCap = LessEqThan(8);
    levUnderCap.in[0] <== leverageX;
    levUnderCap.in[1] <== leverageCap;
    levUnderCap.out === 1;

    // 6. notional <= cap.
    component notionalUnderCap = LessEqThan(64);
    notionalUnderCap.in[0] <== notionalCents;
    notionalUnderCap.in[1] <== notionalCapCents;
    notionalUnderCap.out === 1;

    // 7. The notional is not understated: size * price <= notional * 1e6.
    //    size * price < 2^128 and notional * 1e6 < 2^84: both fit 130 bits,
    //    far inside the field.
    signal exposure;
    exposure <== sizeMicro * entryPriceCents;
    component notionalCoversExposure = LessEqThan(130);
    notionalCoversExposure.in[0] <== exposure;
    notionalCoversExposure.in[1] <== notionalCents * 1000000;
    notionalCoversExposure.out === 1;
}

component main {public [commitment, leverageCap, notionalCapCents]} = HedgePolicy();
