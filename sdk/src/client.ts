import * as anchor from "@coral-xyz/anchor";
import { BN } from "bn.js";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Keypair,
  Transaction,
  Ed25519Program,
  sendAndConfirmTransaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import { 
  getPdaConfig, 
  getPdaRound, 
  getPdaVault,
  getPdaTicket, 
  getPdaTIMLGVault, 
  getPdaTreasurySol, 
  getPdaTokenomics,
  getPdaRewardFeePool,
  getPdaReplicationPool,
  getPdaUserStats,
  getPdaRoundRegistry,
  getPdaTreasury,
  getPdaGlobalStats
} from "./pdas.js";
import { computeCommitment, randomBytes32, bytesToHex, hexToBytes } from "./utils/crypto.js";
import idl from "./idl/timlg_protocol.json" with { type: "json" };
import type { TimlgProtocol } from "./types/timlg_protocol.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// Helper to handle BN creation consistently
const toBN = (val: number | bigint | string) => new BN(val.toString());

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

  async fetchRoundRegistry() {
    const configPda = getPdaConfig(this.program.programId);
    const registryPda = getPdaRoundRegistry(this.program.programId, configPda);
    return (this.program.account as any).roundRegistry.fetch(registryPda);
  }

  async fetchTokenomics(configPda: PublicKey) {
    const tokenomicsPda = getPdaTokenomics(this.program.programId, configPda);
    return (this.program.account as any).tokenomics.fetch(tokenomicsPda);
  }

  async fetchTicket(ticketPda: PublicKey) {
    return (this.program.account as any).ticket.fetchNullable(ticketPda);
  }

  async fetchGlobalStats() {
    const gsPda = getPdaGlobalStats(this.program.programId);
    return (this.program.account as any).globalStats.fetch(gsPda);
  }

  /** Returns the current confirmed slot without exposing the raw connection. */
  async getSlot(): Promise<number> {
    return this.connection.getSlot("confirmed");
  }

  async getBalances(user: PublicKey, timlgMint: PublicKey) {
    const sol = await this.connection.getBalance(user);
    const userAta = anchor.utils.token.associatedAddress({ mint: timlgMint, owner: user });
    let tmlg = "0";
    try {
      const tokenBalance = await this.connection.getTokenAccountBalance(userAta);
      tmlg = tokenBalance.value.uiAmountString || "0";
    } catch (_) {}
    
    return {
      sol: sol / 1e9,
      tmlg: tmlg
    };
  }

  async getLatestRound() {
    const configPda = getPdaConfig(this.program.programId);
    const roundRegistryPda = getPdaRoundRegistry(this.program.programId, configPda);
    
    // 1. Fetch registry to know the current sequence
    const registry = await (this.program.account as any).roundRegistry.fetch(roundRegistryPda);
    const nextRoundId = registry.nextRoundId.toNumber();

    if (nextRoundId <= 1) return null;

    // 2. The active round is the one immediately preceding nextRoundId
    const activeRoundId = nextRoundId - 1;
    const roundPda = getPdaRound(this.program.programId, activeRoundId);
    
    try {
      // 3. Directly fetch the single relevant round, bypassing legacy accounts
      const data = await (this.program.account as any).round.fetch(roundPda);
      return { publicKey: roundPda, account: data };
    } catch (e) {
      console.error(`Error fetching round ${activeRoundId}:`, (e as Error).message);
      return null;
    }
  }
}

/**
 * Tool for the Player (Ticket Manager).
 */
export class TimlgPlayer extends TimlgBase {
  async commit(
    roundId: number,
    guess: number,
    options: { nonce?: number; salt?: Uint8Array; timlgMint: PublicKey; userTimlgAta?: PublicKey }
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
    const userTimlgAta = options.userTimlgAta ?? anchor.utils.token.associatedAddress({ mint: options.timlgMint, owner: user });

    const tx = await (this.program.methods as any)
      .commitTicket(toBN(roundId), toBN(nonce), Array.from(commitment))
      .accounts({
        config: configPda,
        round: roundPda,
        ticket: ticketPda,
        user: user,
        userStats: userStatsPda,
        timlgMint: options.timlgMint,
        timlgVault: timlgVaultPda,
        userTimlgAta: userTimlgAta,
        treasurySol: treasurySolPda,
        globalStats: getPdaGlobalStats(this.program.programId),
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

  async commitBatch(
    roundId: number,
    entries: { guess: number; nonce?: number; salt?: Uint8Array }[],
    options: { timlgMint: PublicKey; userTimlgAta?: PublicKey }
  ): Promise<{ signature: string; receipts: Receipt[] }> {
    const user = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const roundPda = getPdaRound(this.program.programId, roundId);
    const timlgVaultPda = getPdaTIMLGVault(this.program.programId, roundId);
    const treasurySolPda = getPdaTreasurySol(this.program.programId);
    const userStatsPda = getPdaUserStats(this.program.programId, user);
    const userTimlgAta = options.userTimlgAta ?? anchor.utils.token.associatedAddress({ mint: options.timlgMint, owner: user });

    const processedEntries = await Promise.all(
      entries.map(async (e) => {
        const nonce = e.nonce ?? Math.floor(Math.random() * 1_000_000_000);
        const salt = e.salt ?? randomBytes32();
        const commitment = await computeCommitment(roundId, user, nonce, e.guess, salt);
        return {
          guess: e.guess,
          nonce,
          salt,
          commitment,
          ticketPda: getPdaTicket(this.program.programId, roundId, user, nonce),
        };
      })
    );

    const anchorEntries = processedEntries.map((e) => ({
      user,
      nonce: toBN(e.nonce),
      commitment: Array.from(e.commitment),
    }));

    const tx = await (this.program.methods as any)
      .commitBatch(toBN(roundId), anchorEntries)
      .accounts({
        config: configPda,
        round: roundPda,
        timlgMint: options.timlgMint,
        timlgVault: timlgVaultPda,
        user,
        userStats: userStatsPda,
        userTimlgAta: userTimlgAta,
        treasurySol: treasurySolPda,
        globalStats: getPdaGlobalStats(this.program.programId),
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .remainingAccounts(
        processedEntries.map(e => ({
          pubkey: e.ticketPda,
          isWritable: true,
          isSigner: false,
        }))
      )
      .rpc();

    return {
      signature: tx,
      receipts: processedEntries.map((e) => ({
        roundId,
        guess: e.guess,
        nonce: e.nonce.toString(),
        salt: bytesToHex(e.salt),
        commitment: bytesToHex(e.commitment),
        ticketPda: e.ticketPda.toBase58(),
      })),
    };
  }

  async revealBatch(receipts: Receipt[]): Promise<string> {
    if (receipts.length === 0) return "";
    const first = receipts[0];
    if (!first) throw new Error("No receipts provided for revealBatch");

    const user = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const roundId = first.roundId;
    const roundPda = getPdaRound(this.program.programId, roundId);
    const userStatsPda = getPdaUserStats(this.program.programId, user);

    const anchorEntries = receipts.map((r) => ({
      user,
      nonce: toBN(r.nonce),
      guess: r.guess,
      salt: Array.from(hexToBytes(r.salt)),
    }));

    const ticketPdas = receipts.map(r => new PublicKey(r.ticketPda));

    return (this.program.methods as any)
      .revealBatch(toBN(roundId), anchorEntries)
      .accounts({
        config: configPda,
        round: roundPda,
        user,
        userStats: userStatsPda,
        globalStats: getPdaGlobalStats(this.program.programId),
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts(
        ticketPdas.map(pubkey => ({
          pubkey,
          isWritable: true,
          isSigner: false,
        }))
      )
      .rpc();
  }

  async reveal(receipt: Receipt): Promise<string> {
    const user = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const roundPda = getPdaRound(this.program.programId, receipt.roundId);

    return (this.program.methods as any)
      .revealTicket(
        toBN(receipt.roundId),
        toBN(receipt.nonce),
        receipt.guess,
        Array.from(hexToBytes(receipt.salt))
      )
      .accounts({
        config: configPda,
        round: roundPda,
        ticket: new PublicKey(receipt.ticketPda),
        user,
        globalStats: getPdaGlobalStats(this.program.programId),
      } as any)
      .rpc();
  }

  async claim(
    receipt: Receipt, 
    options: { timlgMint: PublicKey; userTimlgAta?: PublicKey }
  ): Promise<string> {
    const user = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const tokenomicsPda = getPdaTokenomics(this.program.programId, configPda);
    const rewardFeePoolPda = getPdaRewardFeePool(this.program.programId, tokenomicsPda);
    const roundPda = getPdaRound(this.program.programId, receipt.roundId);
    const timlgVaultPda = getPdaTIMLGVault(this.program.programId, receipt.roundId);
    const userStatsPda = getPdaUserStats(this.program.programId, user);
    const userTimlgAta = options.userTimlgAta ?? anchor.utils.token.associatedAddress({ mint: options.timlgMint, owner: user });

    return (this.program.methods as any)
      .claimReward(toBN(receipt.roundId), toBN(receipt.nonce))
      .accounts({
        config: configPda,
        tokenomics: tokenomicsPda,
        round: roundPda,
        ticket: new PublicKey(receipt.ticketPda),
        user: user,
        userStats: userStatsPda,
        timlgMint: options.timlgMint,
        timlgVault: timlgVaultPda,
        userTimlgAta: userTimlgAta,
        rewardFeePool: rewardFeePoolPda,
        globalStats: getPdaGlobalStats(this.program.programId),
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
      .closeTicket(toBN(receipt.roundId), toBN(receipt.nonce))
      .accounts({
        config: configPda,
        round: roundPda,
        ticket: new PublicKey(receipt.ticketPda),
        user,
        userStats: userStatsPda,
        globalStats: getPdaGlobalStats(this.program.programId),
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  async refundTicket(roundId: number, options: { timlgMint: PublicKey; userTimlgAta?: PublicKey; ticketPda: PublicKey }): Promise<string> {
    const user = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const roundPda = getPdaRound(this.program.programId, roundId);
    const timlgVaultPda = getPdaTIMLGVault(this.program.programId, roundId);
    const userStatsPda = getPdaUserStats(this.program.programId, user);
    const userTimlgAta = options.userTimlgAta ?? anchor.utils.token.associatedAddress({ mint: options.timlgMint, owner: user });

    return (this.program.methods as any)
      .recoverFunds(toBN(roundId))
      .accounts({
        config: configPda,
        round: roundPda,
        ticket: options.ticketPda,
        user,
        userTokenAccount: userTimlgAta,
        timlgVault: timlgVaultPda,
        userStats: userStatsPda,
        timlgMint: options.timlgMint,
        globalStats: getPdaGlobalStats(this.program.programId),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  async closeStats(): Promise<string> {
    const user = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const userStatsPda = getPdaUserStats(this.program.programId, user);

    return (this.program.methods as any)
      .closeUserStats()
      .accounts({
        userStats: userStatsPda,
        user,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }
}

/**
 * Tool for the Supervisor (Operator).
 */
export class TimlgSupervisor extends TimlgBase {
  async createRoundAuto(options: { 
    timlgMint: PublicKey,
    pulseIndexTarget?: number,
    commitDeadlineSlots?: number,
    revealDeadlineSlots?: number
  }): Promise<string> {
    const admin = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const roundRegistryPda = getPdaRoundRegistry(this.program.programId, configPda);
    
    // We assume the user wants standard 100/200 slot deadlines if not provided
    const pulseTarget = toBN(options.pulseIndexTarget ?? 0);
    const commitDeadline = toBN(options.commitDeadlineSlots ?? 100);
    const revealDeadline = toBN(options.revealDeadlineSlots ?? 200);

    // Note: Anchor will try to resolve PDAs automatically if possible, 
    // but some like 'round' and 'vault' depend on round_registry data.
    // In a professional SDK, we should fetch registry first or let anchor fail if they are missing.
    const opts = options as any;
    let mint = opts.timlgMint || opts.mint || opts.tokenMint;
    if (!mint) {
       const config = await this.fetchConfig();
       mint = config.timlgMint;
    }

    return (this.program.methods as any)
      .createRoundAuto(pulseTarget, commitDeadline, revealDeadline)
      .accounts({
        config: configPda,
        timlgMint: mint,
        roundRegistry: roundRegistryPda,
        globalStats: getPdaGlobalStats(this.program.programId),
        admin,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
  }

  async finalizeRound(roundId: number): Promise<string> {
    const admin = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const roundPda = getPdaRound(this.program.programId, roundId);
    return (this.program.methods as any)
      .finalizeRound(toBN(roundId))
      .accounts({
        round: roundPda,
        admin,
      } as any)
      .rpc();
  }

  /**
   * Fetches a batch of recent rounds and returns those that need a pulse set.
   * A round needs a pulse when: has tickets, pulse not set, still within reveal window.
   * @param lookback How many rounds back from the registry's nextRoundId to check (default 30)
   */
  async getRoundsNeedingPulse(lookback = 30): Promise<Array<{
    roundId: number;
    roundPda: PublicKey;
    pulseIndexTarget: number;
    committedCount: number;
    revealDeadlineSlot: number;
  }>> {
    const configPda = getPdaConfig(this.program.programId);
    const registryPda = getPdaRoundRegistry(this.program.programId, configPda);
    const registry = await (this.program.account as any).roundRegistry.fetch(registryPda);
    const nextRoundId = registry.nextRoundId.toNumber();

    // Build PDA list for the last `lookback` rounds
    const startId = Math.max(0, nextRoundId - lookback);
    const roundIds: number[] = [];
    for (let id = startId; id < nextRoundId; id++) roundIds.push(id);

    // Batch-fetch using getMultipleAccountsInfo
    const roundPdas = roundIds.map(id => getPdaRound(this.program.programId, id));
    const accountInfos = await this.connection.getMultipleAccountsInfo(roundPdas, "confirmed");
    const slot = await this.connection.getSlot("confirmed");

    const result: Array<{
      roundId: number;
      roundPda: PublicKey;
      pulseIndexTarget: number;
      committedCount: number;
      revealDeadlineSlot: number;
    }> = [];

    for (let i = 0; i < roundIds.length; i++) {
      const info = accountInfos[i];
      if (!info || !info.data) continue;
      try {
        const round = (this.program.account as any).round.coder.accounts.decode("round", info.data);
        const pulseSet: boolean = round.pulseSet;
        const committedCount: number = round.committedCount?.toNumber?.() ?? 0;
        const revealDeadlineSlot: number = round.revealDeadlineSlot?.toNumber?.() ?? 0;
        // Include: no pulse yet, has tickets, still within reveal window
        if (!pulseSet && committedCount > 0 && slot < revealDeadlineSlot) {
          result.push({
            roundId: round.roundId.toNumber(),
            roundPda: roundPdas[i]!,
            pulseIndexTarget: round.pulseIndexTarget.toNumber(),
            committedCount,
            revealDeadlineSlot,
          });
        }
      } catch (_) {
        // Skip rounds we can't decode (legacy format, etc.)
      }
    }

    return result.sort((a, b) => a.roundId - b.roundId);
  }

  /**
   * Sets the NIST pulse for a round using the oracle's Ed25519 keypair.
   * Builds the required dual-instruction transaction:
   *   1. Ed25519Program instruction (signature verification precompile)
   *   2. setPulseSigned program instruction
   *
   * @param roundId    The round to set the pulse for
   * @param pulseIndexTarget The NIST pulse index that was targeted (from the round account)
   * @param pulse      64-byte NIST pulse (outputValue)
   * @param oracleKeypair  The keypair whose pubkey is registered on-chain as the oracle
   * @param adminKeypair   The admin keypair required for the instruction
   * @param relayerKeypair Optional separate payer/relayer keypair (defaults to oracleKeypair)
   */
  async setPulseSigned(
    roundId: number,
    pulseIndexTarget: number,
    pulse: Uint8Array,
    oracleKeypair: Keypair,
    adminKeypair: Keypair,
    relayerKeypair?: Keypair
  ): Promise<string> {
    if (pulse.length !== 64) throw new Error(`pulse must be 64 bytes, got ${pulse.length}`);

    const programId = this.program.programId;
    const configPda = getPdaConfig(programId);
    const roundPda = getPdaRound(programId, roundId);
    const signer = relayerKeypair ?? oracleKeypair;

    // Build canonical message (must match programs/timlg_protocol/src/utils.rs::expected_pulse_msg)
    const roundIdLE = Buffer.alloc(8);
    roundIdLE.writeBigUInt64LE(BigInt(roundId));
    const targetLE = Buffer.alloc(8);
    targetLE.writeBigUInt64LE(BigInt(pulseIndexTarget));

    const msg = Buffer.concat([
      Buffer.from("timlg-protocol:pulse_v1", "utf8"),
      programId.toBytes(),
      roundIdLE,
      targetLE,
      Buffer.from(pulse),
    ]);

    // 1. Ed25519 pre-instruction
    const edIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: oracleKeypair.secretKey,
      message: msg,
    });

    // 2. setPulseSigned program instruction
    const setPulseIx = await (this.program.methods as any)
      .setPulseSigned(new BN(roundId), Array.from(pulse))
      .accounts({
        config: configPda,
        round: roundPda,
        globalStats: getPdaGlobalStats(programId),
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        admin: adminKeypair.publicKey,
      })
      .instruction();

    const tx = new Transaction().add(edIx, setPulseIx);
    
    // Signers list
    const signers = [signer];
    if (signer.publicKey.toBase58() !== adminKeypair.publicKey.toBase58()) {
      signers.push(adminKeypair);
    }

    const sig = await sendAndConfirmTransaction(
      this.connection,
      tx,
      signers,
      { commitment: "confirmed", skipPreflight: true }
    );
    return sig;
  }

  async settleRoundTokens(roundId: number, options: { timlgMint: PublicKey }): Promise<string> {
    const admin = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const roundPda = getPdaRound(this.program.programId, roundId);
    const timlgVaultPda = getPdaTIMLGVault(this.program.programId, roundId);
    const tokenomicsPda = getPdaTokenomics(this.program.programId, configPda);
    const treasuryPda = getPdaTreasury(this.program.programId); // Removed configPda
    const replicationPoolPda = getPdaReplicationPool(this.program.programId, tokenomicsPda); // Changed configPda to tokenomicsPda

    return (this.program.methods as any)
      .settleRoundTokens(toBN(roundId))
      .accounts({
        config: configPda,
        tokenomics: tokenomicsPda,
        round: roundPda,
        timlgMint: options.timlgMint,
        timlgVault: timlgVaultPda,
        treasury: treasuryPda,
        replicationPool: replicationPoolPda,
        payer: admin,
        admin,
        globalStats: getPdaGlobalStats(this.program.programId),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      } as any)
      .rpc();
  }

  /**
   * Sweeps unclaimed tokens after the claim grace period has passed.
   * Burns loser/unclaimed stakes (deflation) and clears the SOL vault.
   * Requires admin signer.
   */
  async sweepUnclaimed(roundId: number, options: { timlgMint: PublicKey }): Promise<string> {
    const admin = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const roundPda = getPdaRound(this.program.programId, roundId);
    const vaultPda = getPdaVault(this.program.programId, roundId);
    const timlgVaultPda = getPdaTIMLGVault(this.program.programId, roundId);
    const treasuryPda = getPdaTreasury(this.program.programId);

    return (this.program.methods as any)
      .sweepUnclaimed(toBN(roundId))
      .accounts({
        config: configPda,
        round: roundPda,
        vault: vaultPda,
        timlgVault: timlgVaultPda,
        treasury: treasuryPda,
        timlgMint: options.timlgMint,
        admin,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  /**
   * Closes a swept round account, recovering its rent to the admin.
   * The round must have been swept first via sweepUnclaimed().
   * Requires admin signer.
   */
  async closeRound(roundId: number, options: { timlgMint: PublicKey }): Promise<string> {
    const admin = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const roundPda = getPdaRound(this.program.programId, roundId);
    const timlgVaultPda = getPdaTIMLGVault(this.program.programId, roundId);

    return (this.program.methods as any)
      .closeRound(toBN(roundId))
      .accounts({
        config: configPda,
        round: roundPda,
        timlgVault: timlgVaultPda,
        timlgMint: options.timlgMint,
        admin,
        globalStats: getPdaGlobalStats(this.program.programId),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  /**
   * Recovers funds for any ticket on behalf of its owner (permissionless).
   * Anyone can call this after the recover timeout has passed.
   * The cranker (caller) is reimbursed with the SOL service fee.
   */
  async recoverFundsAnyone(
    roundId: number,
    ticketPda: PublicKey,
    ticketOwner: PublicKey,
    options: { timlgMint: PublicKey }
  ): Promise<string> {
    const cranker = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const roundPda = getPdaRound(this.program.programId, roundId);
    const timlgVaultPda = getPdaTIMLGVault(this.program.programId, roundId);
    const userStatsPda = getPdaUserStats(this.program.programId, ticketOwner);
    const userTokenAccount = anchor.utils.token.associatedAddress({
      mint: options.timlgMint,
      owner: ticketOwner,
    });

    return (this.program.methods as any)
      .recoverFundsAnyone(toBN(roundId))
      .accounts({
        config: configPda,
        round: roundPda,
        ticket: ticketPda,
        user: ticketOwner,
        userTokenAccount,
        timlgVault: timlgVaultPda,
        userStats: userStatsPda,
        timlgMint: options.timlgMint,
        cranker,
        globalStats: getPdaGlobalStats(this.program.programId),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  // ─── Discovery Helpers ───────────────────────────────────────────────────────

  /**
   * Internal batch-fetch helper shared by all discovery methods.
   * Returns decoded round data for the last `lookback` rounds.
   */
  private async _batchFetchRounds(lookback: number): Promise<Array<{
    roundId: number;
    roundPda: PublicKey;
    round: any;
  }>> {
    const configPda = getPdaConfig(this.program.programId);
    const registryPda = getPdaRoundRegistry(this.program.programId, configPda);
    const registry = await (this.program.account as any).roundRegistry.fetch(registryPda);
    const nextRoundId = registry.nextRoundId.toNumber();

    const startId = Math.max(0, nextRoundId - lookback);
    const roundIds: number[] = [];
    for (let id = startId; id < nextRoundId; id++) roundIds.push(id);

    const roundPdas = roundIds.map(id => getPdaRound(this.program.programId, id));
    const accountInfos = await this.connection.getMultipleAccountsInfo(roundPdas, "confirmed");

    const results: Array<{ roundId: number; roundPda: PublicKey; round: any }> = [];
    for (let i = 0; i < roundIds.length; i++) {
      const info = accountInfos[i];
      if (!info?.data) continue;
      try {
        const round = (this.program.account as any).round.coder.accounts.decode("round", info.data);
        results.push({ roundId: roundIds[i]!, roundPda: roundPdas[i]!, round });
      } catch (_) {}
    }
    return results;
  }

  /**
   * Returns finalized rounds that still need settle_round_tokens called.
   * @param lookback Rounds to scan back from registry tip (default 50)
   */
  async getRoundsNeedingSettle(lookback = 50): Promise<Array<{
    roundId: number;
    roundPda: PublicKey;
    committedCount: number;
  }>> {
    const rounds = await this._batchFetchRounds(lookback);
    return rounds
      .filter(({ round }) => round.finalized && !round.tokenSettled)
      .map(({ roundId, roundPda, round }) => ({
        roundId,
        roundPda,
        committedCount: round.committedCount?.toNumber?.() ?? 0,
      }))
      .sort((a, b) => a.roundId - b.roundId);
  }

  /**
   * Returns finalized+settled rounds that haven't been swept yet
   * and whose claim grace period has expired.
   * @param lookback Rounds to scan back (default 50)
   */
  async getRoundsReadyToSweep(lookback = 50): Promise<Array<{
    roundId: number;
    roundPda: PublicKey;
    revealDeadlineSlot: number;
  }>> {
    const [rounds, slot] = await Promise.all([
      this._batchFetchRounds(lookback),
      this.connection.getSlot("confirmed"),
    ]);
    return rounds
      .filter(({ round }) =>
        round.finalized &&
        round.tokenSettled &&
        !round.swept
      )
      .map(({ roundId, roundPda, round }) => ({
        roundId,
        roundPda,
        revealDeadlineSlot: round.revealDeadlineSlot?.toNumber?.() ?? 0,
      }))
      .sort((a, b) => a.roundId - b.roundId);
  }

  /**
   * Returns swept rounds that are ready to be closed (rent recovered).
   * @param lookback Rounds to scan back (default 50)
   */
  async getRoundsReadyToClose(lookback = 50): Promise<Array<{
    roundId: number;
    roundPda: PublicKey;
  }>> {
    const rounds = await this._batchFetchRounds(lookback);
    return rounds
      .filter(({ round }) => round.swept && !round.closed)
      .map(({ roundId, roundPda }) => ({ roundId, roundPda }))
      .sort((a, b) => a.roundId - b.roundId);
  }

  /**
   * Returns a comprehensive view of recent rounds in the pipeline.
   * Useful for the operator supervisor to decide what needs to be done.
   * @param lookback number of rounds to check (default 30)
   */
  async getActiveRoundsInPipeline(lookback = 30): Promise<Array<{
    roundId: number;
    roundPda: PublicKey;
    state: string;
    pulseSet: boolean;
    finalized: boolean;
    tokenSettled: boolean;
    swept: boolean;
    committedCount: number;
    winCount: number;
    revealDeadlineSlot: number;
  }>> {
    const rounds = await this._batchFetchRounds(lookback);
    const stateMap = ["Announced", "PulseSet", "Finalized"];
    
    return rounds.map(({ roundId, roundPda, round }) => ({
      roundId,
      roundPda,
      state: stateMap[round.state] || `Unknown(${round.state})`,
      pulseSet: !!round.pulseSet,
      finalized: !!round.finalized,
      tokenSettled: !!round.tokenSettled,
      swept: !!round.swept,
      committedCount: round.committedCount?.toNumber?.() ?? 0,
      winCount: round.winCount?.toNumber?.() ?? 0,
      revealDeadlineSlot: round.revealDeadlineSlot?.toNumber?.() ?? 0,
      pulseIndexTarget: round.pulseIndexTarget?.toNumber?.() ?? 0,
    })).sort((a, b) => b.roundId - a.roundId);
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

  async initConfig(options: {
    stakeAmount: number | bigint;
    commitWindowSlots: number | bigint;
    revealWindowSlots: number | bigint;
    timlgMint: PublicKey;
  }): Promise<string> {
    const admin = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const treasurySolPda = getPdaTreasurySol(this.program.programId);
    const treasuryPda = getPdaTreasury(this.program.programId);

    return (this.program.methods as any)
      .initializeConfig(
        toBN(options.stakeAmount),
        toBN(options.commitWindowSlots),
        toBN(options.revealWindowSlots)
      )
      .accounts({
        config: configPda,
        timlgMint: options.timlgMint,
        treasurySol: treasurySolPda,
        treasury: treasuryPda,
        admin,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
  }

  async initRoundRegistry(startRoundId: number | bigint): Promise<string> {
    const admin = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const roundRegistryPda = getPdaRoundRegistry(this.program.programId, configPda);

    return (this.program.methods as any)
      .initializeRoundRegistry(toBN(startRoundId))
      .accounts({
        config: configPda,
        roundRegistry: roundRegistryPda,
        admin,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
  }

  async initTokenomics(options: {
    rewardFeeBps: number;
    timlgMint: PublicKey;
  }): Promise<string> {
    const admin = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const tokenomicsPda = getPdaTokenomics(this.program.programId, configPda);
    const rewardFeePoolPda = getPdaRewardFeePool(this.program.programId, tokenomicsPda);
    const replicationPoolPda = getPdaReplicationPool(this.program.programId, tokenomicsPda);

    return (this.program.methods as any)
      .initializeTokenomics(options.rewardFeeBps)
      .accounts({
        config: configPda,
        timlgMint: options.timlgMint,
        tokenomics: tokenomicsPda,
        rewardFeePool: rewardFeePoolPda,
        replicationPool: replicationPoolPda,
        admin,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();
  }

  async setOraclePubkey(oraclePubkey: PublicKey): Promise<string> {
    const admin = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    return (this.program.methods as any)
      .setOraclePubkey(oraclePubkey)
      .accounts({
        config: configPda,
        admin,
      } as any)
      .rpc();
  }

  async initializeGlobalStats(): Promise<string> {
    const admin = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const globalStatsPda = getPdaGlobalStats(this.program.programId);

    return (this.program.methods as any)
      .initializeGlobalStats()
      .accounts({
        globalStats: globalStatsPda,
        admin,
        systemProgram: SystemProgram.programId,
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

  /**
   * Professional factory method to create a client by cluster name.
   */
  static async create(
    wallet: anchor.Wallet | Keypair,
    options: { 
      cluster: "mainnet-beta" | "devnet" | "localnet" | string,
      rpcUrl?: string,
      commitment?: anchor.web3.Commitment 
    }
  ): Promise<TimlgClient> {
    const anchorWallet = 'signTransaction' in wallet ? wallet as anchor.Wallet : new anchor.Wallet(wallet as Keypair);

    const urls: Record<string, string> = {
      "mainnet-beta": "https://api.mainnet-beta.solana.com",
      "devnet": "https://api.devnet.solana.com",
      "localnet": "http://127.0.0.1:8899"
    };

    const rpcUrl = options.rpcUrl || urls[options.cluster] || options.cluster;
    const connection = new Connection(rpcUrl, options.commitment || "confirmed");
    const provider = new anchor.AnchorProvider(connection, anchorWallet, {
      commitment: options.commitment || "confirmed"
    });

    // Program ID is fixed for the protocol
    const programId = new PublicKey("GeA3JqAjAWBCoW3JVDbdTjEoxfUaSgtHuxiAeGG5PrUP");
    const program = new anchor.Program(idl as any, provider);
    
    return new TimlgClient(program);
  }
}

