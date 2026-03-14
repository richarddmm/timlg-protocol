import * as anchor from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { 
  getPdaConfig, 
  getPdaRound, 
  getPdaTicket, 
  getPdaTIMLGVault, 
  getPdaTreasurySol, 
  getPdaTokenomics,
  getPdaRewardFeePool
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

export class TimlgClient {
  public program: anchor.Program<any>;
  public connection: Connection;

  constructor(program: anchor.Program<any>) {
    this.program = program;
    this.connection = program.provider.connection;
  }

  /**
   * Commits a ticket to a round.
   */
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
    const timlgVaultPda = getPdaTIMLGVault(this.program.programId, roundId);
    const treasurySolPda = getPdaTreasurySol(this.program.programId);

    const tx = await (this.program.methods as any)
      .commitTicket(new anchor.BN(roundId), new anchor.BN(nonce), Array.from(commitment))
      .accounts({
        config: configPda,
        round: roundPda,
        ticket: ticketPda,
        user: user,
        timlgMint: options.timlgMint,
        timlgVault: timlgVaultPda,
        userTimlgAta: options.userTimlgAta,
        treasurySol: treasurySolPda,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any) // Use any temporarily if types are slightly off
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

  /**
   * Reveals a previously committed ticket.
   */
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

  /**
   * Claims reward for a winning ticket.
   */
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

    return (this.program.methods as any)
      .claimReward(new anchor.BN(receipt.roundId), new anchor.BN(receipt.nonce))
      .accounts({
        config: configPda,
        tokenomics: tokenomicsPda,
        round: roundPda,
        ticket: new PublicKey(receipt.ticketPda),
        user: user,
        timlgMint: options.timlgMint,
        timlgVault: timlgVaultPda,
        userTimlgAta: options.userTimlgAta,
        rewardFeePool: rewardFeePoolPda,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .rpc();
  }
}
