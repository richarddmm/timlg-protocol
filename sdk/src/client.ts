import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { 
  getPdaConfig, 
  getPdaRound, 
  getPdaTicket, 
  getPdaTIMLGVault, 
  getPdaTreasurySol, 
  getPdaTokenomics,
  getPdaRewardFeePool,
  getPdaUserStats
} from "./pdas.js";
import { computeCommitment, randomBytes32, bytesToHex, hexToBytes } from "./utils/crypto.js";
import idl from "./idl/timlg_protocol.json" with { type: "json" };
import type { TimlgProtocol } from "./types/timlg_protocol.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export interface Receipt {
  roundId: number;
  guess: number;
  nonce: string;
  salt: string;
  commitment: string;
  ticketPda: string;
}

/**
 * Base class for all TIMLG tools.
 */
export class TimlgBase {
  public program: anchor.Program<any>;
  public connection: Connection;

  constructor(program: anchor.Program<any>) {
    this.program = program;
    this.connection = program.provider.connection;
  }

  async fetchRound(roundId: number) {
    const roundPda = getPdaRound(this.program.programId, roundId);
    return (this.program.account as any).round.fetch(roundPda);
  }

  async fetchUserStats(user: PublicKey) {
    const statsPda = getPdaUserStats(this.program.programId, user);
    return (this.program.account as any).userStats.fetch(statsPda);
  }

  async fetchConfig() {
    const configPda = getPdaConfig(this.program.programId);
    return (this.program.account as any).config.fetch(configPda);
  }
}

/**
 * Tool for the Player (Ticket Manager).
 */
export class TimlgPlayer extends TimlgBase {
  async commit(
    roundId: number,
    guess: number,
    options: { nonce?: number; salt?: Uint8Array; timlgMint: PublicKey; userTimlgAta: PublicKey }
  ): Promise<{ signature: string; receipt: Receipt }> {
    const user = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const nonce = options.nonce ?? Math.floor(Math.random() * 1_000_000_000);
    const salt = options.salt ?? randomBytes32();
    const commitment = await computeCommitment(roundId, user, nonce, guess, salt);

    const configPda = getPdaConfig(this.program.programId);
    const roundPda = getPdaRound(this.program.programId, roundId);
    const ticketPda = getPdaTicket(this.program.programId, roundId, user, nonce);
    const userStatsPda = getPdaUserStats(this.program.programId, user);
    const timlgVaultPda = getPdaTIMLGVault(this.program.programId, roundId);
    const treasurySolPda = getPdaTreasurySol(this.program.programId);

    const tx = await (this.program.methods as any)
      .commitTicket(new anchor.BN(roundId), new anchor.BN(nonce), Array.from(commitment))
      .accounts({
        config: configPda,
        round: roundPda,
        ticket: ticketPda,
        user: user,
        userStats: userStatsPda,
        timlgMint: options.timlgMint,
        timlgVault: timlgVaultPda,
        userTimlgAta: options.userTimlgAta,
        treasurySol: treasurySolPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();

    return {
      signature: tx,
      receipt: {
        roundId,
        guess,
        nonce: nonce.toString(),
        salt: bytesToHex(salt),
        commitment: bytesToHex(commitment),
        ticketPda: ticketPda.toBase58(),
      },
    };
  }

  async reveal(receipt: Receipt): Promise<string> {
    const user = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const roundPda = getPdaRound(this.program.programId, receipt.roundId);

    return (this.program.methods as any)
      .revealTicket(
        new anchor.BN(receipt.roundId),
        new anchor.BN(receipt.nonce),
        receipt.guess,
        Array.from(hexToBytes(receipt.salt))
      )
      .accounts({
        config: configPda,
        round: roundPda,
        ticket: new PublicKey(receipt.ticketPda),
        user,
      } as any)
      .rpc();
  }

  async claim(
    receipt: Receipt, 
    options: { timlgMint: PublicKey; userTimlgAta: PublicKey }
  ): Promise<string> {
    const user = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const tokenomicsPda = getPdaTokenomics(this.program.programId, configPda);
    const rewardFeePoolPda = getPdaRewardFeePool(this.program.programId, tokenomicsPda);
    const roundPda = getPdaRound(this.program.programId, receipt.roundId);
    const timlgVaultPda = getPdaTIMLGVault(this.program.programId, receipt.roundId);
    const userStatsPda = getPdaUserStats(this.program.programId, user);

    return (this.program.methods as any)
      .claimReward(new anchor.BN(receipt.roundId), new anchor.BN(receipt.nonce))
      .accounts({
        config: configPda,
        tokenomics: tokenomicsPda,
        round: roundPda,
        ticket: new PublicKey(receipt.ticketPda),
        user: user,
        userStats: userStatsPda,
        timlgMint: options.timlgMint,
        timlgVault: timlgVaultPda,
        userTimlgAta: options.userTimlgAta,
        rewardFeePool: rewardFeePoolPda,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  async closeTicket(receipt: Receipt): Promise<string> {
    const user = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const roundPda = getPdaRound(this.program.programId, receipt.roundId);
    const userStatsPda = getPdaUserStats(this.program.programId, user);

    return (this.program.methods as any)
      .closeTicket(new anchor.BN(receipt.roundId), new anchor.BN(receipt.nonce))
      .accounts({
        config: configPda,
        round: roundPda,
        ticket: new PublicKey(receipt.ticketPda),
        user,
        userStats: userStatsPda,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  async refundTicket(roundId: number, options: { timlgMint: PublicKey; userTimlgAta: PublicKey; ticketPda: PublicKey }): Promise<string> {
    const user = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const roundPda = getPdaRound(this.program.programId, roundId);
    const timlgVaultPda = getPdaTIMLGVault(this.program.programId, roundId);
    const userStatsPda = getPdaUserStats(this.program.programId, user);

    return (this.program.methods as any)
      .recoverFunds(new anchor.BN(roundId))
      .accounts({
        config: configPda,
        round: roundPda,
        ticket: options.ticketPda,
        user,
        userTokenAccount: options.userTimlgAta,
        timlgVault: timlgVaultPda,
        userStats: userStatsPda,
        timlgMint: options.timlgMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }
}

/**
 * Tool for the Supervisor (Operator).
 */
export class TimlgSupervisor extends TimlgBase {
  async createRoundAuto(): Promise<string> {
    const admin = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    // Note: The round ID is determined by the program state
    return (this.program.methods as any)
      .createRoundAuto()
      .accounts({
        config: configPda,
        admin,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  async finalizeRound(roundId: number): Promise<string> {
    const admin = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const roundPda = getPdaRound(this.program.programId, roundId);
    return (this.program.methods as any)
      .finalizeRound(new anchor.BN(roundId))
      .accounts({
        round: roundPda,
        admin,
      } as any)
      .rpc();
  }

  async settleRoundTokens(roundId: number, options: { timlgMint: PublicKey }): Promise<string> {
    const admin = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const roundPda = getPdaRound(this.program.programId, roundId);
    const timlgVaultPda = getPdaTIMLGVault(this.program.programId, roundId);

    return (this.program.methods as any)
      .settleRoundTokens(new anchor.BN(roundId))
      .accounts({
        config: configPda,
        round: roundPda,
        timlgVault: timlgVaultPda,
        timlgMint: options.timlgMint,
        admin,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
  }
}

/**
 * Tool for the Admin (Maintenance).
 */
export class TimlgAdmin extends TimlgBase {
  async setPause(paused: boolean): Promise<string> {
    const admin = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    return (this.program.methods as any)
      .setPause(paused)
      .accounts({
        config: configPda,
        admin,
      } as any)
      .rpc();
  }
}

/**
 * Universal Client that provides access to all tools.
 */
export class TimlgClient extends TimlgBase {
  public player: TimlgPlayer;
  public supervisor: TimlgSupervisor;
  public admin: TimlgAdmin;

  constructor(program: anchor.Program<any>) {
    super(program);
    this.player = new TimlgPlayer(program);
    this.supervisor = new TimlgSupervisor(program);
    this.admin = new TimlgAdmin(program);
  }
}
