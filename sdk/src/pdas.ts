import { PublicKey } from "@solana/web3.js";
import { Buffer } from "node:buffer";

/**
 * Derives the Config PDA.
 */
export function getPdaConfig(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("config_v3")], programId);
  return pda;
}

/**
 * Derives the Round Registry PDA.
 */
export function getPdaRoundRegistry(programId: PublicKey, configPda: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("round_registry_v3"), configPda.toBuffer()],
    programId
  );
  return pda;
}

/**
 * Derives the Round PDA for a specific round ID.
 */
export function getPdaRound(programId: PublicKey, roundId: number | bigint): PublicKey {
  const roundLe = Buffer.alloc(8);
  roundLe.writeBigUInt64LE(BigInt(roundId));
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("round_v3"), roundLe],
    programId
  );
  return pda;
}

/**
 * Derives the Ticket PDA for a specific user and nonce.
 */
export function getPdaTicket(
  programId: PublicKey,
  roundId: number | bigint,
  user: PublicKey,
  nonce: number | bigint
): PublicKey {
  const roundLe = Buffer.alloc(8);
  roundLe.writeBigUInt64LE(BigInt(roundId));
  const nonceLe = Buffer.alloc(8);
  nonceLe.writeBigUInt64LE(BigInt(nonce));
  
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ticket_v3"), roundLe, user.toBuffer(), nonceLe],
    programId
  );
  return pda;
}

/**
 * Derives the Vault PDA (USDC-like) for a specific round.
 */
export function getPdaVault(programId: PublicKey, roundId: number | bigint): PublicKey {
  const roundLe = Buffer.alloc(8);
  roundLe.writeBigUInt64LE(BigInt(roundId));
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_v3"), roundLe],
    programId
  );
  return pda;
}

/**
 * Derives the TIMLG Vault PDA for a specific round.
 */
export function getPdaTIMLGVault(programId: PublicKey, roundId: number | bigint): PublicKey {
  const roundLe = Buffer.alloc(8);
  roundLe.writeBigUInt64LE(BigInt(roundId));
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("timlg_vault_v3"), roundLe],
    programId
  );
  return pda;
}

/**
 * Derives the Tokenomics PDA.
 */
export function getPdaTokenomics(programId: PublicKey, configPda: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("tokenomics_v3"), configPda.toBuffer()],
    programId
  );
  return pda;
}

/**
 * Derives the Treasury SOL PDA.
 */
export function getPdaTreasurySol(programId: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from("treasury_sol_v3")], programId);
  return pda;
}

/**
 * Derives the Reward Fee Pool PDA.
 */
export function getPdaRewardFeePool(programId: PublicKey, tokenomicsPda: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("reward_fee_pool_v3"), tokenomicsPda.toBuffer()],
    programId
  );
  return pda;
}

/**
 * Derives the UserStats PDA.
 */
export function getPdaUserStats(programId: PublicKey, user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_stats_v3"), user.toBuffer()],
    programId
  );
  return pda;
}
