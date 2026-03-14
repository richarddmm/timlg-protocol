import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";
import { Buffer } from "node:buffer";
import * as anchor from "@coral-xyz/anchor";

/**
 * Converts bytes to hex string.
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/**
 * Converts hex string to bytes.
 */
export function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

/**
 * Generates 32 random bytes.
 */
export function randomBytes32(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Computes the commitment hash for a ticket.
 * Standard TIMLG Commit-Reveal hash: sha256(round_id || user_pubkey || nonce || guess || salt)
 */
export async function computeCommitment(
  roundId: number | bigint,
  user: PublicKey,
  nonce: number | bigint,
  guess: number,
  salt: Uint8Array
): Promise<Uint8Array> {
  const roundIdBuffer = Buffer.alloc(8);
  roundIdBuffer.writeBigUInt64LE(BigInt(roundId));

  const nonceBuffer = Buffer.alloc(8);
  nonceBuffer.writeBigUInt64LE(BigInt(nonce));

  const guessBuffer = Buffer.alloc(1);
  guessBuffer.writeUint8(guess);

  const data = Buffer.concat([
    roundIdBuffer,
    user.toBuffer(),
    nonceBuffer,
    guessBuffer,
    salt,
  ]);

  return sha256(data);
}
