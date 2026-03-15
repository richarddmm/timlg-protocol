import * as anchor from "@coral-xyz/anchor";
import { BN } from "bn.js";
import { Connection, PublicKey, SystemProgram, Keypair } from "@solana/web3.js";
import { 
  getPdaConfig, 
  getPdaRound, 
  getPdaTicket, 
  getPdaTIMLGVault, 
  getPdaTreasurySol, 
  getPdaTokenomics,
  getPdaRewardFeePool,
  getPdaUserStats,
  getPdaRoundRegistry
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

  async fetchTicket(ticketPda: PublicKey) {
    return (this.program.account as any).ticket.fetchNullable(ticketPda);
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
    return (this.program.methods as any)
      .createRoundAuto(pulseTarget, commitDeadline, revealDeadline)
      .accounts({
        config: configPda,
        timlgMint: options.timlgMint,
        roundRegistry: roundRegistryPda,
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

  async settleRoundTokens(roundId: number, options: { timlgMint: PublicKey }): Promise<string> {
    const admin = (this.program.provider as anchor.AnchorProvider).wallet.publicKey;
    const configPda = getPdaConfig(this.program.programId);
    const roundPda = getPdaRound(this.program.programId, roundId);
    const timlgVaultPda = getPdaTIMLGVault(this.program.programId, roundId);

    return (this.program.methods as any)
      .settleRoundTokens(toBN(roundId))
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

  /**
   * Professional factory method to create a client by cluster name.
   */
  static async create(
    wallet: anchor.Wallet | Keypair,
    options: { 
      cluster: "mainnet-beta" | "devnet" | "localnet" | string,
      commitment?: anchor.web3.Commitment 
    }
  ): Promise<TimlgClient> {
    const anchorWallet = 'signTransaction' in wallet ? wallet as anchor.Wallet : new anchor.Wallet(wallet as Keypair);

    const urls: Record<string, string> = {
      "mainnet-beta": "https://api.mainnet-beta.solana.com",
      "devnet": "https://api.devnet.solana.com",
      "localnet": "http://127.0.0.1:8899"
    };

    const rpcUrl = urls[options.cluster] || options.cluster;
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
