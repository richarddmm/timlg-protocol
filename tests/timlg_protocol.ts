import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { TIMLGMvp } from "../target/types/timlg_protocol";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

describe("timlg_protocol - MVP-0", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.TIMLGMvp as Program<TIMLGMvp>;

  it("initialize_config + create_round", async () => {
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    await program.methods
      .initializeConfig(new BN(1), new BN(200), new BN(200))
      .accounts({
        config: configPda,
        admin: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const slot = await provider.connection.getSlot();

    const roundId = new BN(1);
    const [roundPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("round"), roundId.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    await program.methods
      .createRound(roundId, new BN(12345), new BN(slot + 300), new BN(slot + 600))
      .accounts({
        config: configPda,
        round: roundPda,
        admin: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const round = await program.account.round.fetch(roundPda);
    if (round.roundId.toString() !== "1") throw new Error("round_id mismatch");
  });
});
