const anchor = require("@coral-xyz/anchor");
const crypto = require("crypto");

function leU64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function deriveBitIndexV1(roundId, userPubkeyBytes) {
  const preimage = Buffer.concat([
    Buffer.from("bitindex"),
    leU64(roundId),
    userPubkeyBytes,
  ]);
  const h = crypto.createHash("sha256").update(preimage).digest();
  const v = h.readUInt16LE(0);
  return v % 512;
}

function getPulseBit(pulse64, bitIndex) {
  const idx = Number(bitIndex);
  const byteI = Math.floor(idx / 8);
  const bitI = idx % 8;
  return (pulse64[byteI] >> bitI) & 1;
}

describe("TIMLG canonicity vectors (v1)", () => {
  it("derive_bit_index v1 matches fixed vector", () => {
    // fixed values (stable regression)
    const roundId = 42;
    const user = new anchor.web3.PublicKey(
      "3ubbYD5VrSpQQW1GLWubkH9owvZK5GZVjvBnoADZSxpo"
    );

    // Expected with v1 formula:
    // sha256("bitindex" || le64(42) || user_bytes)[0..2] LE % 512
    const expected = 392;

    const got = deriveBitIndexV1(roundId, user.toBuffer());
    if (got !== expected) {
      throw new Error(`bitIndex mismatch: got=${got}, expected=${expected}`);
    }
  });

  it("get_pulse_bit uses LSB-first bit order inside each byte", () => {
    const pulse = Buffer.alloc(64, 0);
    pulse[0] = 0b00000001; // bit 0 = 1
    pulse[1] = 0b10000000; // bit 15 = 1 (byte1, bit7)

    if (getPulseBit(pulse, 0) !== 1) throw new Error("bit 0 should be 1");
    if (getPulseBit(pulse, 1) !== 0) throw new Error("bit 1 should be 0");
    if (getPulseBit(pulse, 7) !== 0) throw new Error("bit 7 should be 0");
    if (getPulseBit(pulse, 8) !== 0) throw new Error("bit 8 should be 0");
    if (getPulseBit(pulse, 15) !== 1) throw new Error("bit 15 should be 1");
  });
});
