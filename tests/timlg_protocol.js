const {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getMint,
  setAuthority,
  AuthorityType,
  TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");

const anchor = require("@coral-xyz/anchor");
const {
  PublicKey,
  SystemProgram,
  Keypair,
  Transaction,
  Ed25519Program,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const BN = require("bn.js");
const crypto = require("crypto");

// --- Anchor bootstrap (TOP LEVEL) ---
anchor.setProvider(anchor.AnchorProvider.env());

const provider = anchor.getProvider();
const program = anchor.workspace.TIMLGMvp;

// --- mock-pulse availability guard (TOP LEVEL) ---
const HAS_MOCK_PULSE = typeof program.methods.setPulseMock === "function";

if (!HAS_MOCK_PULSE) {
  throw new Error(
    "set_pulse_mock is not available. Build/tests must be run with the cargo feature: mock-pulse"
  );
}

// --------------------
// Helpers
// --------------------
function leU64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
function sha256(buffers) {
  const h = crypto.createHash("sha256");
  for (const b of buffers) h.update(b);
  return h.digest();
}
function setBit(pulse, bitIndex, value) {
  const byteI = Math.floor(bitIndex / 8);
  const bitI = bitIndex % 8;
  if (value) pulse[byteI] |= (1 << bitI);
  else pulse[byteI] &= ~(1 << bitI);
}
function getBit(pulse, bitIndex) {
  const byteI = Math.floor(bitIndex / 8);
  const bitI = bitIndex % 8;
  return (pulse[byteI] >> bitI) & 1;
}

async function confirmSig(connection, sig, commitment = "confirmed") {
  await connection.confirmTransaction(sig, commitment);
  return sig;
}

async function rpcConfirmed(provider, rpcPromise) {
  const sig = await rpcPromise;
  await confirmSig(provider.connection, sig, "confirmed");
  return sig;
}

async function waitForAccountOwner(connection, pubkey, expectedOwner, commitment = "confirmed", tries = 40, delayMs = 200) {
  for (let i = 0; i < tries; i++) {
    const info = await connection.getAccountInfo(pubkey, commitment);
    if (info && info.owner && info.owner.equals(expectedOwner)) return info;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`Account ${pubkey.toBase58()} not ready (owner not ${expectedOwner.toBase58()})`);
}

async function expectTxFail(promiseFn, needle) {
  let ok = false;
  try {
    await promiseFn();
  } catch (e) {
    ok = true;
    const logs = (e && e.logs) ? e.logs.join("\n") : "";
    const msg = String(e) + "\n" + logs;
    if (needle && !msg.includes(needle)) {
      throw new Error(`Expected error to include "${needle}", got:\n${msg}`);
    }
  }
  if (!ok) throw new Error(`Expected tx to fail${needle ? ` with "${needle}"` : ""}, but it succeeded`);
}

async function waitForValidatorReady(connection) {
  const start = Date.now();
  const timeoutMs = 20000;

  while (Date.now() - start < timeoutMs) {
    try {
      // If the validator is really ready, Token Program account should be executable.
      const acc = await connection.getAccountInfo(TOKEN_PROGRAM_ID, "confirmed");
      if (acc && acc.executable) return;

      // Sometimes RPC is up but programs still not ready; keep polling.
    } catch (_) {
      // RPC not ready yet; keep polling.
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  throw new Error("Local validator not ready (Token Program not available after 20s)");
}

// Deriva PDAs que ahora exige create_round (punto 2)
function deriveRoundPdas(programId, roundId) {
  const rid = leU64(roundId);

  const [roundPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("round"), rid],
    programId
  );

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), rid],
    programId
  );

  const [timlgVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("timlg_vault"), rid],
    programId
  );

  return { roundPda, vaultPda, timlgVaultPda };
}

function deriveTicketPda(programId, roundId, userPubkey, nonce) {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ticket"), leU64(roundId), userPubkey.toBytes(), leU64(nonce)],
    programId
  );
  return pda;
}

// --------------------
// User Escrow helpers (P0 fix for gasless signed commits)
// --------------------
function deriveUserEscrowPdas(programId, userPk) {
  const [userEscrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_escrow"), userPk.toBytes()],
    programId
  );

  const [userEscrowAtaPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_escrow_vault"), userPk.toBytes()],
    programId
  );

  return { userEscrowPda, userEscrowAtaPda };
}

async function getTokenAmountRaw(connection, tokenAccountPk) {
  // returns raw amount as BigInt (decimals are raw too)
  const bal = await connection.getTokenAccountBalance(tokenAccountPk, "confirmed");
  return BigInt(bal.value.amount);
}

async function ensureUserEscrow(program, provider, { configPda, timlgMint, userPk }) {
  const { userEscrowPda, userEscrowAtaPda } = deriveUserEscrowPdas(program.programId, userPk);

  const esc = await program.account.userEscrow.fetchNullable(userEscrowPda);
  if (!esc) {
    await rpcConfirmed(
      provider,
      program.methods
        .initUserEscrow()
        .accounts({
          config: configPda,
          timlgMint,
          userEscrow: userEscrowPda,
          userEscrowAta: userEscrowAtaPda,
          user: userPk,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );
  }

  return { userEscrowPda, userEscrowAtaPda };
}

async function ensureEscrowFunds(program, provider, {
  configPda,
  timlgMint,
  userPk,
  userTIMLGAta,
  userEscrowPda,
  userEscrowAtaPda,
  neededRaw, // BigInt
}) {
  const connection = provider.connection;
  const currentRaw = await getTokenAmountRaw(connection, userEscrowAtaPda);

  if (currentRaw >= neededRaw) return;

  const delta = neededRaw - currentRaw;

  await rpcConfirmed(
    provider,
    program.methods
      .depositEscrow(new BN(delta.toString()))
      .accounts({
        config: configPda,
        timlgMint,
        userEscrow: userEscrowPda,
        userEscrowAta: userEscrowAtaPda,
        user: userPk,
        userTIMLGAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc()
  );
}

// --------------------
// Config bootstrap (punto 2)
// --------------------
let TIMLG_MINT = null;
let TREASURY_PDA = null;
let CONFIG_PDA = null;
let USER_TIMLG_ATA = null; // ✅ lo usaremos en commit_batch / commit_ticket

let tokenomicsPda = null;
let rewardFeePoolPda = null;
let replicationPoolPda = null;

function deriveTokenomicsPdas(programId, configPda) {
  const [tokenomics] = PublicKey.findProgramAddressSync(
    [Buffer.from("tokenomics"), configPda.toBytes()],
    programId
  );

  const [rewardFeePool] = PublicKey.findProgramAddressSync(
    [Buffer.from("reward_fee_pool"), tokenomics.toBytes()],
    programId
  );

  const [replicationPool] = PublicKey.findProgramAddressSync(
    [Buffer.from("replication_pool"), tokenomics.toBytes()],
    programId
  );

  return { tokenomicsPda: tokenomics, rewardFeePoolPda: rewardFeePool, replicationPoolPda: replicationPool };
}

async function ensureConfig(program, provider /*, configPdaIgnored */) {
  const connection = provider.connection;
  const admin = provider.wallet; // NodeWallet
  const payer = admin.payer;     // Keypair

  // 0) Config PDA
  [CONFIG_PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  // ✅ NUEVO: Treasury SOL PDA
  [TREASURY_SOL_PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury_sol")],
    program.programId
  );

  // 1) Si ya existe config, reusa mint/treasury y asegura ATA del user
  const cfg = await program.account.config.fetchNullable(CONFIG_PDA);
  if (cfg) {
    TIMLG_MINT = cfg.timlgMint;
    TREASURY_PDA = cfg.treasury;

    // ✅ En config nueva existe treasurySol; en config vieja no.
    // Si no existe, derivamos por seed (TREASURY_SOL_PDA ya derivado arriba)
    // y seguimos; si te interesa, puedes validarlo con `cfg.treasurySol` si existe.
    // eslint-disable-next-line no-prototype-builtins
    if (Object.prototype.hasOwnProperty.call(cfg, "treasurySol") && cfg.treasurySol) {
      TREASURY_SOL_PDA = cfg.treasurySol;
    }

    // ✅ asegura ATA del user (payer)
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,          // fee payer
      TIMLG_MINT,    // mint
      payer.publicKey // owner
    );
    USER_TIMLG_ATA = ata.address;

    // ✅ ARREGLO DEFINITIVO:
    // Si el mint viene de una ejecución vieja, puede que mintAuthority != CONFIG_PDA
    const mintInfo = await getMint(connection, TIMLG_MINT, "confirmed");
    const mintAuth = mintInfo.mintAuthority; // PublicKey | null

    // Si ya es CONFIG_PDA, perfecto.
    if (mintAuth && mintAuth.equals(CONFIG_PDA)) {
      return {
        configPda: CONFIG_PDA,
        timlgMint: TIMLG_MINT,
        treasuryPda: TREASURY_PDA,          // SPL treasury (TIMLG)
        treasurySolPda: TREASURY_SOL_PDA,   // ✅ SOL treasury
        userTIMLGAta: USER_TIMLG_ATA,
      };
    }

    // Si la autoridad actual es tu payer, podemos migrarla al PDA config
    if (mintAuth && mintAuth.equals(payer.publicKey)) {
      await setAuthority(
        connection,
        payer,                 // fee payer
        TIMLG_MINT,           // mint
        payer.publicKey,       // current authority
        AuthorityType.MintTokens,
        CONFIG_PDA,            // new authority
        [],                    // multisigners
        { commitment: "confirmed" }
      );

      // (Opcional) re-check
      const mintInfo2 = await getMint(connection, TIMLG_MINT, "confirmed");
      if (!mintInfo2.mintAuthority || !mintInfo2.mintAuthority.equals(CONFIG_PDA)) {
        throw new Error("setAuthority no dejó mintAuthority = CONFIG_PDA (inesperado).");
      }

      return {
        configPda: CONFIG_PDA,
        timlgMint: TIMLG_MINT,
        treasuryPda: TREASURY_PDA,          // SPL treasury (TIMLG)
        treasurySolPda: TREASURY_SOL_PDA,   // ✅ SOL treasury
        userTIMLGAta: USER_TIMLG_ATA,
      };
    }

    // Si la authority es otra (o null), no podemos arreglarlo desde aquí
    throw new Error(
      `TIMLG_MINT mintAuthority no coincide con CONFIG_PDA y tampoco es el payer. ` +
      `mintAuthority=${mintAuth ? mintAuth.toBase58() : "null"}, ` +
      `CONFIG_PDA=${CONFIG_PDA.toBase58()}, payer=${payer.publicKey.toBase58()}. ` +
      `Solución: resetear el validator/ledger.`
    );
  }

  // 2) Crea mint TIMLG (decimals = 0). (De momento la mint authority = payer)
  TIMLG_MINT = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    0,
    undefined,
    { commitment: "confirmed" }
  );

  // ✅ evita race: espera a que el mint exista y esté owned por Tokenkeg
  await waitForAccountOwner(connection, TIMLG_MINT, TOKEN_PROGRAM_ID, "confirmed");

  // 3) Treasury PDA (SPL)
  [TREASURY_PDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("treasury")],
    program.programId
  );

  // 4) ✅ crea ATA del usuario y MINTEA ANTES de initializeConfig
  // (porque initializeConfig transferirá la mint authority al PDA config)
  {
    const ata = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,          // fee payer
      TIMLG_MINT,    // mint
      payer.publicKey // owner
    );
    USER_TIMLG_ATA = ata.address;

    await mintTo(
      connection,
      payer,             // fee payer
      TIMLG_MINT,
      USER_TIMLG_ATA,
      payer,             // mint authority (todavía es payer)
      1_000_000          // cantidad para tests
    );
  }

  // 5) initialize_config (después de esto, el payer ya no debería ser mint authority)
  await rpcConfirmed(
    provider,
    program.methods
      .initializeConfig(
        new BN(1),   // stakeAmount
        new BN(100), // commitWindowSlots
        new BN(100)  // revealWindowSlots
      )
      .accounts({
        config: CONFIG_PDA,
        timlgMint: TIMLG_MINT,

        // ✅ NUEVO: treasury SOL PDA
        treasurySol: TREASURY_SOL_PDA,

        // SPL treasury (TIMLG)
        treasury: TREASURY_PDA,

        admin: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers([payer])
      .rpc()
  );

  // (Opcional) comprobar que ahora la mint authority es CONFIG_PDA
  const mintInfoAfter = await getMint(connection, TIMLG_MINT, "confirmed");
  if (!mintInfoAfter.mintAuthority || !mintInfoAfter.mintAuthority.equals(CONFIG_PDA)) {
    throw new Error(
      `initializeConfig no dejó mintAuthority=CONFIG_PDA. ` +
      `mintAuthority=${mintInfoAfter.mintAuthority ? mintInfoAfter.mintAuthority.toBase58() : "null"} ` +
      `CONFIG_PDA=${CONFIG_PDA.toBase58()}`
    );
  }

  return {
    configPda: CONFIG_PDA,
    timlgMint: TIMLG_MINT,
    treasuryPda: TREASURY_PDA,          // SPL treasury (TIMLG)
    treasurySolPda: TREASURY_SOL_PDA,   // ✅ SOL treasury
    userTIMLGAta: USER_TIMLG_ATA,
  };
}

async function ensureTokenomics(program, provider, { configPda, timlgMint } = {}) {
  // ✅ fallback seguro
  const cfgPda = configPda ?? CONFIG_PDA;
  const mint = timlgMint ?? TIMLG_MINT;

  if (!cfgPda) throw new Error("ensureTokenomics: configPda is null/undefined");
  if (!mint) throw new Error("ensureTokenomics: timlgMint is null/undefined");

  const { tokenomicsPda: t, rewardFeePoolPda: r, replicationPoolPda: p } =
    deriveTokenomicsPdas(program.programId, cfgPda);

  const existing = await program.account.tokenomics.fetchNullable(t);

  console.log("ensureTokenomics cfgPda:", (configPda ?? CONFIG_PDA)?.toBase58?.());
  console.log("ensureTokenomics mint:", (timlgMint ?? TIMLG_MINT)?.toBase58?.());

  if (!existing) {
    const payer = provider.wallet.payer;
    await rpcConfirmed(
      provider,
      program.methods
        .initializeTokenomics()
        .accounts({
          config: cfgPda,
          timlgMint: mint,
          tokenomics: t,
          rewardFeePool: r,
          replicationPool: p,
          admin: payer.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers([payer])
        .rpc()
    );
  }

  tokenomicsPda = t;
  rewardFeePoolPda = r;
  replicationPoolPda = p;

  return { tokenomicsPda, rewardFeePoolPda, replicationPoolPda };
}

async function ensureBoot(program, provider) {
  const cfg = await ensureConfig(program, provider);
  await ensureTokenomics(program, provider, {
    configPda: cfg.configPda,
    timlgMint: cfg.timlgMint,
  });
  return cfg;
}

// MUST match Rust expected_commit_msg():
// b"timlg-protocol:commit_v1" + program_id + round_id(le) + user + nonce(le) + commitment(32)
function expectedCommitMsg(programId, roundId, userPubkey, nonce, commitment32) {
  return Buffer.concat([
    Buffer.from("timlg-protocol:commit_v1", "utf8"),
    programId.toBytes(),
    leU64(roundId),
    userPubkey.toBytes(),
    leU64(nonce),
    Buffer.from(commitment32),
  ]);
}

function expectedPulseMsg(programId, roundId, pulseIndexTarget, pulse64) {
  return Buffer.concat([
    Buffer.from("timlg-protocol:pulse_v1", "utf8"),
    programId.toBytes(),
    leU64(roundId),
    leU64(pulseIndexTarget),
    Buffer.from(pulse64),
  ]);
}

function expectedRevealMsg(programId, roundId, userPubkey, nonce, guess, salt32) {
  return Buffer.concat([
    Buffer.from("timlg-protocol:reveal_v1", "utf8"),
    programId.toBytes(),
    leU64(roundId),
    userPubkey.toBytes(),
    leU64(nonce),
    Buffer.from([guess]),
    Buffer.from(salt32),
  ]);
}

// little-endian u64 buffer (8 bytes)
function leU64(n) {
  const bn = BigInt(n);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(bn, 0);
  return b;
}

// ------------------------------------------------------------
// Helpers MUST match programs/timlg_protocol/src/utils.rs
// ------------------------------------------------------------
function deriveBitIndex(roundId, userPubkey, nonce) {
  const d = sha256([
    Buffer.from("bitindex"),          // IMPORTANT: no underscore
    leU64(roundId),
    userPubkey.toBytes(),
    leU64(nonce),
  ]);
  return d.readUInt16LE(0) % 512;
}

function commitHash(roundId, userPubkey, nonce, guess, salt32) {
  if (!Buffer.isBuffer(salt32) || salt32.length !== 32) {
    throw new Error("salt must be Buffer(32)");
  }
  return sha256([
    Buffer.from("commit"),
    leU64(roundId),
    userPubkey.toBytes(),
    leU64(nonce),
    Buffer.from([guess & 0xff]),
    salt32,
  ]);
}

// set one bit inside a 64-byte pulse (bitIndex 0..511), value 0/1
function setBit(pulse64, bitIndex, value01) {
  const byteIndex = Math.floor(bitIndex / 8);
  const bit = bitIndex % 8;
  const mask = 1 << bit;
  if (value01) pulse64[byteIndex] |= mask;
  else pulse64[byteIndex] &= ~mask;
}

describe("timlg_protocol - BATCHING", () => {
  // Fuerza provider a "confirmed" para evitar carreras tipo PulseNotSet
  const envProvider = anchor.AnchorProvider.env();
  const provider = new anchor.AnchorProvider(
    envProvider.connection,
    envProvider.wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" }
  );
  anchor.setProvider(provider);

  if (typeof program.methods.setPulseMock !== "function") {
    throw new Error(
      "set_pulse_mock is not available. Run tests with: anchor test -- --features mock-pulse"
    );
  }

  before(async function () {
    this.timeout(30000);
    await waitForValidatorReady(provider.connection);
  });

  it("commit_batch + reveal_batch", async () => {
    const admin = provider.wallet.publicKey;

    const { configPda } = await ensureConfig(program, provider);

    const roundId = (Math.floor(Date.now() / 1000) + 1111) % 1000000;
    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot + 10;
    const revealDeadline = slot + 25;

    await rpcConfirmed(
      provider,
      program.methods
        .createRound(new BN(roundId), new BN(777), new BN(commitDeadline), new BN(revealDeadline))
        .accounts({
          config: configPda,
          timlgMint: TIMLG_MINT,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    const nonce1 = 1;
    const nonce2 = 2;
    const guess1 = 1;
    const guess2 = 0;
    const salt1 = Buffer.alloc(32, 7);
    const salt2 = Buffer.alloc(32, 9);

    const commitment1 = commitHash(roundId, admin, nonce1, guess1, salt1);
    const commitment2 = commitHash(roundId, admin, nonce2, guess2, salt2);

    const [ticket1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), leU64(roundId), admin.toBytes(), leU64(nonce1)],
      program.programId
    );
    const [ticket2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), leU64(roundId), admin.toBytes(), leU64(nonce2)],
      program.programId
    );

    // ✅ commit_batch ahora requiere timlgVault
    await rpcConfirmed(
      provider,
      program.methods
        .commitBatch(new BN(roundId), [
          { nonce: new BN(nonce1), commitment: Array.from(commitment1) },
          { nonce: new BN(nonce2), commitment: Array.from(commitment2) },
        ])
        .accounts({
          config: configPda,
          round: roundPda,
          timlgMint: TIMLG_MINT,
          timlgVault: timlgVaultPda, // ✅ NEW
          user: admin,
          userTIMLGAta: USER_TIMLG_ATA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: ticket1Pda, isSigner: false, isWritable: true },
          { pubkey: ticket2Pda, isSigner: false, isWritable: true },
        ])
        .rpc()
    );

    // set pulse (mock) after commit deadline
    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    const pulse = Buffer.alloc(64, 0xaa);
    await rpcConfirmed(
      provider,
      program.methods
        .setPulseMock(new BN(roundId), Array.from(pulse))
        .accounts({ config: configPda, round: roundPda, admin })
        .rpc()
    );

    // reveal_batch (no timlgVault needed aquí)
    await rpcConfirmed(
      provider,
      program.methods
        .revealBatch(new BN(roundId), [
          { nonce: new BN(nonce1), guess: guess1, salt: Array.from(salt1) },
          { nonce: new BN(nonce2), guess: guess2, salt: Array.from(salt2) },
        ])
        .accounts({
          config: configPda,
          round: roundPda,
          user: admin,
        })
        .remainingAccounts([
          { pubkey: ticket1Pda, isSigner: false, isWritable: true },
          { pubkey: ticket2Pda, isSigner: false, isWritable: true },
        ])
        .rpc()
    );
  });

  it("commit_batch_signed (relayer pays, user authorizes via ed25519)", async () => {
    const adminKp = provider.wallet.payer;
    const userKp = adminKp; // user = admin (simple)
    const user = userKp.publicKey;

    const relayer = anchor.web3.Keypair.generate();
    const sigAirdrop = await provider.connection.requestAirdrop(relayer.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(sigAirdrop, "confirmed");

    const { configPda } = await ensureConfig(program, provider);

    // round
    const roundId = (Math.floor(Date.now() / 1000) + 2222) % 1_000_000;
    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot + 20;
    const revealDeadline = slot + 40;
    const pulseIndexTarget = 4242;

    await rpcConfirmed(
      provider,
      program.methods
        .createRound(new BN(roundId), new BN(pulseIndexTarget), new BN(commitDeadline), new BN(revealDeadline))
        .accounts({
          config: configPda,
          timlgMint: TIMLG_MINT,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin: user,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    // escrow exists + fund it
    const { userEscrowPda, userEscrowAtaPda } = await ensureUserEscrow(program, provider, {
      configPda,
      timlgMint: TIMLG_MINT,
      userPk: user,
    });

    await ensureEscrowFunds(program, provider, {
      configPda,
      timlgMint: TIMLG_MINT, // ✅ IMPORTANTE (tu fallo anterior)
      userPk: user,
      userEscrowPda,
      userEscrowAtaPda,
      userTIMLGAta: USER_TIMLG_ATA,
      neededRaw: 1n, // ✅ solo 1 entry para evitar "tx too large"
    });

    // ✅ SOLO 1 ENTRY
    const nonce = 11;
    const salt = crypto.randomBytes(32);
    const guess = 1;
    const commitment = commitHash(roundId, user, nonce, guess, salt);

    const entries = [{ user, nonce: new BN(nonce), commitment: Array.from(commitment) }];

    const ticketPda = deriveTicketPda(program.programId, roundId, user, nonce);

    // ed25519 ix immediately before program ix
    const msg = expectedCommitMsg(program.programId, roundId, user, nonce, commitment);
    const edIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: userKp.secretKey,
      message: msg,
    });

    const progIx = await program.methods
      .commitBatchSigned(new BN(roundId), entries)
      .accounts({
        config: configPda,
        round: roundPda,
        timlgMint: TIMLG_MINT,
        timlgVault: timlgVaultPda,
        payer: relayer.publicKey,
        userEscrow: userEscrowPda,
        userEscrowAta: userEscrowAtaPda,
        user,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ticketPda, isWritable: true, isSigner: false }])
      .instruction();

    const tx = new anchor.web3.Transaction().add(edIx, progIx);
    tx.feePayer = relayer.publicKey;

    const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(relayer);

    const sig = await anchor.web3.sendAndConfirmTransaction(provider.connection, tx, [relayer], {
      commitment: "confirmed",
    });
    await provider.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

    const t = await program.account.ticket.fetch(ticketPda);
    if (Buffer.from(t.commitment).compare(commitment) !== 0) throw new Error("ticket commitment mismatch");
  });

  it("reveal_batch_signed (relayer pays, user authorizes via ed25519)", async () => {
    const adminKp = provider.wallet.payer;
    const userKp = adminKp;                 // user = admin
    const user = userKp.publicKey;

    const relayer = anchor.web3.Keypair.generate();
    const sigAirdrop = await provider.connection.requestAirdrop(relayer.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(sigAirdrop, "confirmed");

    const { configPda } = await ensureConfig(program, provider);

    // round
    const roundId = (Math.floor(Date.now() / 1000) + 3333) % 1_000_000;
    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot + 15;
    const revealDeadline = slot + 35;
    const pulseIndexTarget = 8080;

    await rpcConfirmed(
      provider,
      program.methods
        .createRound(
          new BN(roundId),
          new BN(pulseIndexTarget),
          new BN(commitDeadline),
          new BN(revealDeadline)
        )
        .accounts({
          config: configPda,
          timlgMint: TIMLG_MINT,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin: user,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    // commit 2 tickets normally (so the reveal-signed test only tests reveal path)
    let nonce1 = 21;
    let nonce2 = 22;
    while (deriveBitIndex(roundId, user, nonce1) === deriveBitIndex(roundId, user, nonce2)) {
      nonce2++;
    }

    const salt1 = crypto.randomBytes(32);
    const salt2 = crypto.randomBytes(32);
    const guess1 = 1;
    const guess2 = 0;

    const commitment1 = commitHash(roundId, user, nonce1, guess1, salt1);
    const commitment2 = commitHash(roundId, user, nonce2, guess2, salt2);

    const ticketPda1 = deriveTicketPda(program.programId, roundId, user, nonce1);
    const ticketPda2 = deriveTicketPda(program.programId, roundId, user, nonce2);

    await rpcConfirmed(
      provider,
      program.methods
        .commitBatch(new BN(roundId), [
          { nonce: new BN(nonce1), commitment: Array.from(commitment1) },
          { nonce: new BN(nonce2), commitment: Array.from(commitment2) },
        ])
        .accounts({
          config: configPda,
          round: roundPda,
          timlgMint: TIMLG_MINT,
          timlgVault: timlgVaultPda,
          user,
          userTIMLGAta: USER_TIMLG_ATA,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: ticketPda1, isWritable: true, isSigner: false },
          { pubkey: ticketPda2, isWritable: true, isSigner: false },
        ])
        .rpc()
    );

    // wait until after commitDeadline for setPulseMock
    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    // set pulse bits so both are winners
    const pulse = Buffer.alloc(64, 0);
    setBit(pulse, deriveBitIndex(roundId, user, nonce1), guess1);
    setBit(pulse, deriveBitIndex(roundId, user, nonce2), guess2);

    await rpcConfirmed(
      provider,
      program.methods
        .setPulseMock(new BN(roundId), Array.from(pulse))
        .accounts({ config: configPda, round: roundPda, admin: user })
        .rpc()
    );

    // reveal signed (relayer pays)
    const msg1 = expectedRevealMsg(program.programId, roundId, user, nonce1, guess1, salt1);
    const msg2 = expectedRevealMsg(program.programId, roundId, user, nonce2, guess2, salt2);

    const edIx1 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: userKp.secretKey,
      message: msg1,
    });
    const edIx2 = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: userKp.secretKey,
      message: msg2,
    });

    const revealIx = await program.methods
      .revealBatchSigned(new BN(roundId), [
        { user, nonce: new BN(nonce1), guess: guess1, salt: Array.from(salt1) },
        { user, nonce: new BN(nonce2), guess: guess2, salt: Array.from(salt2) },
      ])
      .accounts({
        config: configPda,
        round: roundPda,
        payer: relayer.publicKey,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts([
        { pubkey: ticketPda1, isWritable: true, isSigner: false },
        { pubkey: ticketPda2, isWritable: true, isSigner: false },
      ])
      .instruction();

    const tx = new anchor.web3.Transaction().add(edIx1, edIx2, revealIx);
    tx.feePayer = relayer.publicKey;

    const { blockhash, lastValidBlockHeight } = await provider.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.sign(relayer);

    const sig = await anchor.web3.sendAndConfirmTransaction(provider.connection, tx, [relayer], {
      commitment: "confirmed",
    });
    await provider.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");

    const t1 = await program.account.ticket.fetch(ticketPda1);
    const t2 = await program.account.ticket.fetch(ticketPda2);
    if (!t1.revealed || !t2.revealed) throw new Error("tickets should be revealed");

    if (!t1.win || !t2.win) throw new Error("expected both tickets to be winners (pulse bits were set accordingly)");
  });

  it("set_pulse_signed (oracle ed25519)", async () => {
    const adminKp = provider.wallet.payer;
    const admin = adminKp.publicKey;

    const oracle = Keypair.generate();
    const relayer = Keypair.generate();

    // fund relayer
    {
      const sig = await provider.connection.requestAirdrop(
        relayer.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await confirmSig(provider.connection, sig, "confirmed");
    }

    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
    await ensureConfig(program, provider, configPda);

    // Set oracle pubkey (admin only)
    await rpcConfirmed(
      provider,
      program.methods
        .setOraclePubkey(oracle.publicKey)
        .accounts({ config: configPda, admin })
        .rpc()
    );

    const roundId = (Math.floor(Date.now() / 1000) + 999) % 1000000;

    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot + 15;
    const pulseIndexTarget = 424242;

    await rpcConfirmed(
      provider,
      program.methods
        .createRound(
          new BN(roundId),
          new BN(pulseIndexTarget),
          new BN(commitDeadline),
          new BN(slot + 200)
        )
        .accounts({
          config: configPda,
          timlgMint: TIMLG_MINT,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    // Wait past commit deadline
    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const pulse = crypto.randomBytes(64);

    const msg = expectedPulseMsg(program.programId, roundId, pulseIndexTarget, pulse);
    const edIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: oracle.secretKey,
      message: msg,
    });

    const anchorIx = await program.methods
      .setPulseSigned(new BN(roundId), Array.from(pulse))
      .accounts({
        config: configPda,
        round: roundPda,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    const tx = new Transaction().add(edIx, anchorIx);
    tx.feePayer = relayer.publicKey;

    const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;

    tx.sign(relayer);

    await sendAndConfirmTransaction(provider.connection, tx, [relayer], {
      commitment: "confirmed",
    });

    const r = await program.account.round.fetch(roundPda);
    if (!r.pulseSet) throw new Error("setPulseSigned did not persist pulseSet=true");

    const onchainPulse = Buffer.from(r.pulse);
    if (!onchainPulse.equals(Buffer.from(pulse))) {
      throw new Error("on-chain pulse mismatch");
    }
  });

  it("finalize_round + sweep_unclaimed (to treasury_sol)", async () => {
    const adminKp = provider.wallet.payer;
    const admin = adminKp.publicKey;

    // ✅ Usa ensureConfig para obtener treasurySolPda (lamports) y treasuryPda (SPL)
    const { configPda, treasurySolPda } = await ensureConfig(program, provider);

    await rpcConfirmed(
      provider,
      program.methods
        .setClaimGraceSlots(new BN(0)) // para que el test no espere
        .accounts({ config: configPda, admin })
        .rpc()
    );

    const roundId = (Math.floor(Date.now() / 1000) + 5555) % 1000000;
    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot + 10;
    const revealDeadline = slot + 20;
    const pulseIndexTarget = 777;

    await rpcConfirmed(
      provider,
      program.methods
        .createRound(
          new BN(roundId),
          new BN(pulseIndexTarget),
          new BN(commitDeadline),
          new BN(revealDeadline)
        )
        .accounts({
          config: configPda,
          timlgMint: TIMLG_MINT,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    // fund vault so there's something to sweep
    const fundAmount = 200_000; // lamports
    await rpcConfirmed(
      provider,
      program.methods
        .fundVault(new BN(roundId), new BN(fundAmount))
        .accounts({
          config: configPda,
          round: roundPda,
          vault: vaultPda,
          funder: admin,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );

    // wait until after reveal deadline
    while ((await provider.connection.getSlot("confirmed")) <= revealDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    // ✅ finalize exige pulse_set = true -> setPulseMock antes
    // Nota: setPulseMock exige haber pasado commitDeadline
    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    await rpcConfirmed(
      provider,
      program.methods
        .setPulseMock(new BN(roundId), Array.from(Buffer.alloc(64, 0xaa)))
        .accounts({ config: configPda, round: roundPda, admin })
        .rpc()
    );

    const treasuryBefore = await provider.connection.getBalance(treasurySolPda, "confirmed");
    const vaultBefore = await provider.connection.getBalance(vaultPda, "confirmed");
    if (vaultBefore === 0) throw new Error("vault should have lamports before sweep");

    // finalize
    await rpcConfirmed(
      provider,
      program.methods
        .finalizeRound(new BN(roundId))
        .accounts({
          config: configPda,
          round: roundPda,
          admin,
        })
        .rpc()
    );

    // sweep -> ✅ ahora a treasurySol
    await rpcConfirmed(
      provider,
      program.methods
        .sweepUnclaimed(new BN(roundId))
        .accounts({
          config: configPda,
          round: roundPda,
          vault: vaultPda,
          treasurySol: treasurySolPda, // ✅ NUEVO (lamports PDA)
          admin,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );

    const treasuryAfter = await provider.connection.getBalance(treasurySolPda, "confirmed");
    const vaultAfter = await provider.connection.getBalance(vaultPda, "confirmed");

    if (vaultAfter !== 0) throw new Error("vault should be empty after sweep");
    if (treasuryAfter <= treasuryBefore) throw new Error("treasury_sol balance did not increase after sweep");

    const r = await program.account.round.fetch(roundPda);
    if (!r.finalized) throw new Error("round.finalized should be true");
  });

  it("grace period prevents early sweep (SweepTooEarly)", async () => {
    const adminKp = provider.wallet.payer;
    const admin = adminKp.publicKey;

    // ✅ Usa ensureConfig para obtener treasurySolPda
    const { configPda, treasurySolPda } = await ensureConfig(program, provider);

    // ✅ set grace slots > 0
    const graceSlots = 5;
    const sigSetGrace = await program.methods
      .setClaimGraceSlots(new BN(graceSlots))
      .accounts({ config: configPda, admin })
      .rpc();
    await provider.connection.confirmTransaction(sigSetGrace, "confirmed");

    const roundId = (Math.floor(Date.now() / 1000) + 9999) % 1000000;
    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot + 5;
    const revealDeadline = slot + 10;
    const pulseIndexTarget = 1234;

    // create round
    const sigCreate = await program.methods
      .createRound(
        new BN(roundId),
        new BN(pulseIndexTarget),
        new BN(commitDeadline),
        new BN(revealDeadline)
      )
      .accounts({
        config: configPda,
        timlgMint: TIMLG_MINT,
        round: roundPda,
        vault: vaultPda,
        timlgVault: timlgVaultPda,
        admin,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();
    await provider.connection.confirmTransaction(sigCreate, "confirmed");

    // fund vault so sweep has something to move
    const sigFund = await program.methods
      .fundVault(new BN(roundId), new BN(200_000))
      .accounts({
        config: configPda,
        round: roundPda,
        vault: vaultPda,
        funder: admin,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await provider.connection.confirmTransaction(sigFund, "confirmed");

    // wait until just after reveal deadline (so finalize is allowed)
    while ((await provider.connection.getSlot("confirmed")) <= revealDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    // ✅ finalize exige pulse_set=true -> setPulseMock antes de finalize
    // setPulseMock exige haber pasado commitDeadline
    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    await rpcConfirmed(
      provider,
      program.methods
        .setPulseMock(new BN(roundId), Array.from(Buffer.alloc(64, 0xaa)))
        .accounts({ config: configPda, round: roundPda, admin })
        .rpc()
    );

    // finalize
    const sigFinalize = await program.methods
      .finalizeRound(new BN(roundId))
      .accounts({
        config: configPda,
        round: roundPda,
        admin,
      })
      .rpc();
    await provider.connection.confirmTransaction(sigFinalize, "confirmed");

    // Read round from chain (source of truth) to compute sweep gate
    let round = await program.account.round.fetch(roundPda, "confirmed");
    const revealDeadlineOnchain = Number(round.revealDeadlineSlot);
    const minSweepSlot = revealDeadlineOnchain + graceSlots;

    // ❌ sweep too early: should fail with SweepTooEarly
    let threw = false;
    try {
      const sigEarly = await program.methods
        .sweepUnclaimed(new BN(roundId))
        .accounts({
          config: configPda,
          round: roundPda,
          vault: vaultPda,
          treasurySol: treasurySolPda, // ✅ NUEVO
          admin,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      // even if it returns a sig, force confirm to surface program error
      await provider.connection.confirmTransaction(sigEarly, "confirmed");
    } catch (e) {
      threw = true;
      const msg = String(e);
      if (!msg.includes("SweepTooEarly") && !msg.includes("grace period")) {
        throw new Error("Expected SweepTooEarly, got: " + msg);
      }
    }
    if (!threw) {
      throw new Error("Expected sweep to fail during grace period, but it succeeded");
    }

    // ✅ wait until grace period elapsed (using on-chain computed minSweepSlot)
    while ((await provider.connection.getSlot("confirmed")) <= minSweepSlot) {
      await new Promise((r) => setTimeout(r, 120));
    }

    // sweep should succeed
    const sigSweep = await program.methods
      .sweepUnclaimed(new BN(roundId))
      .accounts({
        config: configPda,
        round: roundPda,
        vault: vaultPda,
        treasurySol: treasurySolPda, // ✅ NUEVO
        admin,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    await provider.connection.confirmTransaction(sigSweep, "confirmed");

    const vaultAfter = await provider.connection.getBalance(vaultPda, "confirmed");
    if (vaultAfter !== 0) throw new Error("vault should be empty after successful sweep");

    // Fetch state at confirmed
    round = await program.account.round.fetch(roundPda, "confirmed");

    // ✅ robust checks (naming/typing safe)
    const sweptSlot =
      (round.sweptSlot ?? round.swept_slot ?? round.sweptslot ?? round.sweptSlot?.toNumber?.()) ??
      (round.sweptSlot?.toNumber?.() ?? 0);

    const sweptSlotNum =
      typeof sweptSlot === "number"
        ? sweptSlot
        : sweptSlot?.toNumber
          ? sweptSlot.toNumber()
          : Number(sweptSlot ?? 0);

    if (sweptSlotNum <= 0) {
      throw new Error("round.swept_slot should be > 0 after sweep");
    }

    const sweptBool = round.swept ?? round.isSwept ?? round.sweptBool;
    if (sweptBool === false) throw new Error("round.swept should be true after sweep");
  });

  it("commit → reveal → settle → claim_reward (balance checks, whitepaper-aligned)", async () => {
    const admin = provider.wallet.publicKey;

    const { configPda, timlgMint, treasuryPda, userTIMLGAta } = await ensureBoot(program, provider);

    const cfg = await program.account.config.fetch(configPda, "confirmed");
    const stakeBn = cfg.stakeAmount ?? cfg.stake_amount ?? cfg.stake ?? new BN(1);
    const stake = BigInt(stakeBn.toString());

    const before = BigInt((await provider.connection.getTokenAccountBalance(userTIMLGAta, "confirmed")).value.amount);

    const roundId = (Math.floor(Date.now() / 1000) + 2468) % 1000000;
    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot0 = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot0 + 10;
    const revealDeadline = slot0 + 25;
    const pulseIndexTarget = 4242;

    await rpcConfirmed(
      provider,
      program.methods
        .createRound(new BN(roundId), new BN(pulseIndexTarget), new BN(commitDeadline), new BN(revealDeadline))
        .accounts({
          config: configPda,
          timlgMint,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    // Two tickets: one WIN, one LOSE
    const nonce1 = 111;
    const guess1 = 1;
    const salt1 = Buffer.alloc(32, 7);

    const nonce2 = 222;
    const guess2 = 0;
    const salt2 = Buffer.alloc(32, 9);

    const commitment1 = commitHash(roundId, admin, nonce1, guess1, salt1);
    const commitment2 = commitHash(roundId, admin, nonce2, guess2, salt2);

    const [ticket1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), leU64(roundId), admin.toBytes(), leU64(nonce1)],
      program.programId
    );
    const [ticket2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), leU64(roundId), admin.toBytes(), leU64(nonce2)],
      program.programId
    );

    // Commit: transfers 2*stake to timlgVault
    await rpcConfirmed(
      provider,
      program.methods
        .commitBatch(new BN(roundId), [
          { nonce: new BN(nonce1), commitment: Array.from(commitment1) },
          { nonce: new BN(nonce2), commitment: Array.from(commitment2) },
        ])
        .accounts({
          config: configPda,
          round: roundPda,
          timlgMint,
          timlgVault: timlgVaultPda, // ✅ REQUIRED
          user: admin,
          userTIMLGAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: ticket1Pda, isSigner: false, isWritable: true },
          { pubkey: ticket2Pda, isSigner: false, isWritable: true },
        ])
        .rpc()
    );

    const afterCommit = BigInt((await provider.connection.getTokenAccountBalance(userTIMLGAta, "confirmed")).value.amount);
    if (afterCommit !== before - 2n * stake) {
      throw new Error(`afterCommit mismatch: got=${afterCommit} expected=${before - 2n * stake}`);
    }

    // Pulse such that ticket1 wins and ticket2 loses
    const bitIndex1 = deriveBitIndex(roundId, admin, nonce1);
    const bitIndex2 = deriveBitIndex(roundId, admin, nonce2);

    const pulse = Buffer.alloc(64, 0);
    setBit(pulse, bitIndex1, guess1);
    setBit(pulse, bitIndex2, 1 - guess2);

    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    await rpcConfirmed(
      provider,
      program.methods
        .setPulseMock(new BN(roundId), Array.from(pulse))
        .accounts({ config: configPda, round: roundPda, admin })
        .rpc()
    );

    await rpcConfirmed(
      provider,
      program.methods
        .revealBatch(new BN(roundId), [
          { nonce: new BN(nonce1), guess: guess1, salt: Array.from(salt1) },
          { nonce: new BN(nonce2), guess: guess2, salt: Array.from(salt2) },
        ])
        .accounts({ config: configPda, round: roundPda, user: admin })
        .remainingAccounts([
          { pubkey: ticket1Pda, isSigner: false, isWritable: true },
          { pubkey: ticket2Pda, isSigner: false, isWritable: true },
        ])
        .rpc()
    );

    while ((await provider.connection.getSlot("confirmed")) <= revealDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    await rpcConfirmed(
      provider,
      program.methods
        .finalizeRound(new BN(roundId))
        .accounts({ config: configPda, round: roundPda, admin })
        .rpc()
    );

    const supplyBeforeSettle = BigInt((await getMint(provider.connection, timlgMint, "confirmed")).supply.toString());

    await rpcConfirmed(
      provider,
      program.methods
        .settleRoundTokens(new BN(roundId))
        .accounts({
          config: configPda,
          round: roundPda,
          timlgMint,
          timlgVault: timlgVaultPda,
          treasury: treasuryPda,
          tokenomics: tokenomicsPda,
          replicationPool: replicationPoolPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: ticket1Pda, isSigner: false, isWritable: true },
          { pubkey: ticket2Pda, isSigner: false, isWritable: true },
        ])
        .rpc()
    );

    const supplyAfterSettle = BigInt((await getMint(provider.connection, timlgMint, "confirmed")).supply.toString());
    if (supplyAfterSettle !== supplyBeforeSettle - stake) {
      throw new Error(`supply after settle mismatch: got=${supplyAfterSettle} expected=${supplyBeforeSettle - stake}`);
    }

    // Claim winner: refund 1 + mint 1 -> back to before
    await rpcConfirmed(
      provider,
      program.methods
        .claimReward(new BN(roundId), new BN(nonce1))
        .accounts({
          config: configPda,
          round: roundPda,
          ticket: ticket1Pda,
          user: admin,
          timlgMint,
          timlgVault: timlgVaultPda,
          userTIMLGAta,

          tokenomics: tokenomicsPda,
          rewardFeePool: rewardFeePoolPda,

          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc()
    );

    const afterClaim = BigInt((await provider.connection.getTokenAccountBalance(userTIMLGAta, "confirmed")).value.amount);
    if (afterClaim !== before) {
      throw new Error(`afterClaim mismatch: got=${afterClaim} expected=${before}`);
    }
  });

  it("no-reveal stake goes to treasury SPL (settle)", async () => {
    const admin = provider.wallet.publicKey;

    const { configPda, timlgMint, treasuryPda, userTIMLGAta } = await ensureBoot(program, provider);

    const cfg = await program.account.config.fetch(configPda, "confirmed");
    const stakeBn = cfg.stakeAmount ?? cfg.stake_amount ?? cfg.stake ?? new BN(1);
    const stake = BigInt(stakeBn.toString());

    const roundId = (Math.floor(Date.now() / 1000) + 8642) % 1000000;
    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot0 = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot0 + 10;
    const revealDeadline = slot0 + 25;

    await rpcConfirmed(
      provider,
      program.methods
        .createRound(new BN(roundId), new BN(999), new BN(commitDeadline), new BN(revealDeadline))
        .accounts({
          config: configPda,
          timlgMint,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    const nonce1 = 101;
    const guess1 = 1;
    const salt1 = Buffer.alloc(32, 3);

    const nonce2 = 202; // no-reveal
    const guess2 = 0;
    const salt2 = Buffer.alloc(32, 5);

    const commitment1 = commitHash(roundId, admin, nonce1, guess1, salt1);
    const commitment2 = commitHash(roundId, admin, nonce2, guess2, salt2);

    const [ticket1Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), leU64(roundId), admin.toBytes(), leU64(nonce1)],
      program.programId
    );
    const [ticket2Pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ticket"), leU64(roundId), admin.toBytes(), leU64(nonce2)],
      program.programId
    );

    const treBefore = BigInt((await provider.connection.getTokenAccountBalance(treasuryPda, "confirmed")).value.amount);

    await rpcConfirmed(
      provider,
      program.methods
        .commitBatch(new BN(roundId), [
          { nonce: new BN(nonce1), commitment: Array.from(commitment1) },
          { nonce: new BN(nonce2), commitment: Array.from(commitment2) },
        ])
        .accounts({
          config: configPda,
          round: roundPda,
          timlgMint,
          timlgVault: timlgVaultPda, // ✅ REQUIRED
          user: admin,
          userTIMLGAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: ticket1Pda, isSigner: false, isWritable: true },
          { pubkey: ticket2Pda, isSigner: false, isWritable: true },
        ])
        .rpc()
    );

    // pulse: ticket1 wins
    const bitIndex1 = deriveBitIndex(roundId, admin, nonce1);
    const pulse = Buffer.alloc(64, 0);
    setBit(pulse, bitIndex1, guess1);

    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    await rpcConfirmed(
      provider,
      program.methods
        .setPulseMock(new BN(roundId), Array.from(pulse))
        .accounts({ config: configPda, round: roundPda, admin })
        .rpc()
    );

    // reveal only ticket1
    await rpcConfirmed(
      provider,
      program.methods
        .revealBatch(new BN(roundId), [{ nonce: new BN(nonce1), guess: guess1, salt: Array.from(salt1) }])
        .accounts({ config: configPda, round: roundPda, user: admin })
        .remainingAccounts([{ pubkey: ticket1Pda, isSigner: false, isWritable: true }])
        .rpc()
    );

    while ((await provider.connection.getSlot("confirmed")) <= revealDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    await rpcConfirmed(
      provider,
      program.methods
        .finalizeRound(new BN(roundId))
        .accounts({ config: configPda, round: roundPda, admin })
        .rpc()
    );

    await rpcConfirmed(
      provider,
      program.methods
        .settleRoundTokens(new BN(roundId))
        .accounts({
          config: configPda,
          round: roundPda,
          timlgMint,
          timlgVault: timlgVaultPda,
          treasury: treasuryPda,
          tokenomics: tokenomicsPda,
          replicationPool: replicationPoolPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: ticket1Pda, isSigner: false, isWritable: true },
          { pubkey: ticket2Pda, isSigner: false, isWritable: true },
        ])
        .rpc()
    );

    const treAfter = BigInt((await provider.connection.getTokenAccountBalance(treasuryPda, "confirmed")).value.amount);
    if (treAfter !== treBefore + stake) {
      throw new Error(`treasury did not receive no-reveal stake: got=${treAfter} expected=${treBefore + stake}`);
    }
  });

  it("hardening: replayed commit_batch_signed fails with TicketAlreadyExists", async () => {
    const adminKp = provider.wallet.payer;
    const userKp = adminKp;
    const user = userKp.publicKey;

    const relayer = anchor.web3.Keypair.generate();
    const sigAirdrop = await provider.connection.requestAirdrop(relayer.publicKey, 2_000_000_000);
    await provider.connection.confirmTransaction(sigAirdrop, "confirmed");

    const { configPda } = await ensureConfig(program, provider);

    // round
    const roundId = (Math.floor(Date.now() / 1000) + 9901) % 1_000_000;
    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot + 8;
    const revealDeadline = slot + 20;

    await rpcConfirmed(
      provider,
      program.methods
        .createRound(new BN(roundId), new BN(123), new BN(commitDeadline), new BN(revealDeadline))
        .accounts({
          config: configPda,
          timlgMint: TIMLG_MINT,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin: user,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    // escrow exists + fund it (1 entry)
    const { userEscrowPda, userEscrowAtaPda } = await ensureUserEscrow(program, provider, {
      configPda,
      timlgMint: TIMLG_MINT,
      userPk: user,
    });

    await ensureEscrowFunds(program, provider, {
      configPda,
      timlgMint: TIMLG_MINT,
      userPk: user,
      userEscrowPda,
      userEscrowAtaPda,
      userTIMLGAta: USER_TIMLG_ATA,
      neededRaw: 1n,
    });

    const nonce = 777;
    const salt = crypto.randomBytes(32);
    const guess = 1;
    const commitment = commitHash(roundId, user, nonce, guess, salt);

    const entries = [{ user, nonce: new BN(nonce), commitment: Array.from(commitment) }];
    const ticketPda = deriveTicketPda(program.programId, roundId, user, nonce);

    const msg = expectedCommitMsg(program.programId, roundId, user, nonce, commitment);
    const edIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: userKp.secretKey,
      message: msg,
    });

    const progIx = await program.methods
      .commitBatchSigned(new BN(roundId), entries)
      .accounts({
        config: configPda,
        round: roundPda,
        timlgMint: TIMLG_MINT,
        timlgVault: timlgVaultPda,
        payer: relayer.publicKey,
        userEscrow: userEscrowPda,
        userEscrowAta: userEscrowAtaPda,
        user,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ticketPda, isWritable: true, isSigner: false }])
      .instruction();

    // 1) first tx ok
    {
      const tx = new Transaction().add(edIx, progIx);
      tx.feePayer = relayer.publicKey;
      const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.sign(relayer);

      await sendAndConfirmTransaction(provider.connection, tx, [relayer], { commitment: "confirmed" });
    }

    // 2) replay same tx should fail with TicketAlreadyExists
    await expectTxFail(async () => {
      const edIx2 = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: userKp.secretKey,
        message: msg,
      });
      const tx2 = new Transaction().add(edIx2, progIx);
      tx2.feePayer = relayer.publicKey;
      const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
      tx2.recentBlockhash = blockhash;
      tx2.sign(relayer);

      await sendAndConfirmTransaction(provider.connection, tx2, [relayer], { commitment: "confirmed" });
    }, "TicketAlreadyExists");
  });

  it("hardening: settle rejects calls only after fully settled (RoundTokensAlreadySettled) and claim is one-shot (AlreadyClaimed)", async () => {
    const admin = provider.wallet.publicKey;

    const { configPda, timlgMint, treasuryPda, userTIMLGAta } = await ensureBoot(program, provider);

    const cfg = await program.account.config.fetch(configPda, "confirmed");
    const stakeBn = cfg.stakeAmount ?? cfg.stake_amount ?? new BN(1);
    const stake = BigInt(stakeBn.toString());

    const roundId = (Math.floor(Date.now() / 1000) + 9902) % 1_000_000;
    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot0 = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot0 + 8;
    const revealDeadline = slot0 + 18;

    await rpcConfirmed(
      provider,
      program.methods
        .createRound(new BN(roundId), new BN(555), new BN(commitDeadline), new BN(revealDeadline))
        .accounts({
          config: configPda,
          timlgMint,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    // commit 1 ticket
    const nonce = 1;
    const guess = 1;
    const salt = crypto.randomBytes(32);
    const commitment = commitHash(roundId, admin, nonce, guess, salt);
    const ticketPda = deriveTicketPda(program.programId, roundId, admin, nonce);

    const before = BigInt((await provider.connection.getTokenAccountBalance(userTIMLGAta, "confirmed")).value.amount);

    await rpcConfirmed(
      provider,
      program.methods
        .commitTicket(new BN(roundId), new BN(nonce), Array.from(commitment))
        .accounts({
          config: configPda,
          round: roundPda,
          timlgMint,
          timlgVault: timlgVaultPda,
          ticket: ticketPda,
          user: admin,
          userTIMLGAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );

    const afterCommit = BigInt((await provider.connection.getTokenAccountBalance(userTIMLGAta, "confirmed")).value.amount);
    if (afterCommit !== before - stake) throw new Error("commit stake mismatch");

    // wait >= commitDeadline then set pulse so ticket wins
    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }
    const bitIndex = deriveBitIndex(roundId, admin, nonce);
    const pulse = Buffer.alloc(64, 0);
    setBit(pulse, bitIndex, guess);

    await rpcConfirmed(
      provider,
      program.methods
        .setPulseMock(new BN(roundId), Array.from(pulse))
        .accounts({ config: configPda, round: roundPda, admin })
        .rpc()
    );

    // reveal
    await rpcConfirmed(
      provider,
      program.methods
        .revealTicket(new BN(roundId), new BN(nonce), guess, Array.from(salt))
        .accounts({ config: configPda, round: roundPda, ticket: ticketPda, user: admin })
        .rpc()
    );

    // wait > revealDeadline then finalize
    while ((await provider.connection.getSlot("confirmed")) <= revealDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    await rpcConfirmed(
      provider,
      program.methods
        .finalizeRound(new BN(roundId))
        .accounts({ config: configPda, round: roundPda, admin })
        .rpc()
    );

    // settle once OK
    await rpcConfirmed(
      provider,
      program.methods
        .settleRoundTokens(new BN(roundId))
        .accounts({
          config: configPda,
          round: roundPda,
          timlgMint,
          timlgVault: timlgVaultPda,
          treasury: treasuryPda,
          tokenomics: tokenomicsPda,
          replicationPool: replicationPoolPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([{ pubkey: ticketPda, isSigner: false, isWritable: true }])
        .rpc()
    );

    // settle again must fail
    await expectTxFail(async () => {
      await program.methods
        .settleRoundTokens(new BN(roundId))
        .accounts({
          config: configPda,
          round: roundPda,
          timlgMint,
          timlgVault: timlgVaultPda,
          treasury: treasuryPda,
          tokenomics: tokenomicsPda,
          replicationPool: replicationPoolPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([{ pubkey: ticketPda, isSigner: false, isWritable: true }])
        .rpc();
    }, "RoundTokensAlreadySettled");

    // claim once OK (refund + mint)
    await rpcConfirmed(
      provider,
      program.methods
        .claimReward(new BN(roundId), new BN(nonce))
        .accounts({
          config: configPda,
          round: roundPda,
          ticket: ticket1Pda,
          user: admin,
          timlgMint,
          timlgVault: timlgVaultPda,
          userTIMLGAta,

          tokenomics: tokenomicsPda,
          rewardFeePool: rewardFeePoolPda,

          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc()
    );

    // claim again must fail
    await expectTxFail(async () => {
      await program.methods
        .claimReward(new BN(roundId), new BN(nonce))
        .accounts({
          config: configPda,
          round: roundPda,
          ticket: ticket1Pda,
          user: admin,
          timlgMint,
          timlgVault: timlgVaultPda,
          userTIMLGAta,

          tokenomics: tokenomicsPda,
          rewardFeePool: rewardFeePoolPda,

          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    }, "AlreadyClaimed");
  });

  it("hardening: claim is rejected after sweep (ClaimAfterSweep)", async () => {
    const admin = provider.wallet.publicKey;

    const { configPda, timlgMint, treasuryPda, userTIMLGAta } = await ensureBoot(program, provider);

    const roundId = (Math.floor(Date.now() / 1000) + 9903) % 1_000_000;
    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot0 = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot0 + 8;
    const revealDeadline = slot0 + 18;

    // create round
    await rpcConfirmed(
      provider,
      program.methods
        .createRound(new BN(roundId), new BN(777), new BN(commitDeadline), new BN(revealDeadline))
        .accounts({
          config: configPda,
          timlgMint,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    // commit
    const nonce = 9;
    const guess = 1;
    const salt = crypto.randomBytes(32);
    const commitment = commitHash(roundId, admin, nonce, guess, salt);
    const ticketPda = deriveTicketPda(program.programId, roundId, admin, nonce);

    await rpcConfirmed(
      provider,
      program.methods
        .commitTicket(new BN(roundId), new BN(nonce), Array.from(commitment))
        .accounts({
          config: configPda,
          round: roundPda,
          timlgMint,
          timlgVault: timlgVaultPda,
          ticket: ticketPda,
          user: admin,
          userTIMLGAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );

    // wait until commit window ends
    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    // set pulse (make ticket win)
    const bitIndex = deriveBitIndex(roundId, admin, nonce);
    const pulse = Buffer.alloc(64, 0);
    setBit(pulse, bitIndex, guess);

    await rpcConfirmed(
      provider,
      program.methods
        .setPulseMock(new BN(roundId), Array.from(pulse))
        .accounts({ config: configPda, round: roundPda, admin })
        .rpc()
    );

    // reveal
    await rpcConfirmed(
      provider,
      program.methods
        .revealTicket(new BN(roundId), new BN(nonce), guess, Array.from(salt))
        .accounts({ config: configPda, round: roundPda, ticket: ticketPda, user: admin })
        .rpc()
    );

    // wait until reveal deadline passed, then finalize
    while ((await provider.connection.getSlot("confirmed")) <= revealDeadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    await rpcConfirmed(
      provider,
      program.methods
        .finalizeRound(new BN(roundId))
        .accounts({ config: configPda, round: roundPda, admin })
        .rpc()
    );

    // settle tokens (so claim would normally be allowed)
    await rpcConfirmed(
      provider,
      program.methods
        .settleRoundTokens(new BN(roundId))
        .accounts({
          config: configPda,
          round: roundPda,
          timlgMint,
          timlgVault: timlgVaultPda,
          treasury: treasuryPda,
          tokenomics: tokenomicsPda,
          replicationPool: replicationPoolPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([{ pubkey: ticketPda, isSigner: false, isWritable: true }])
        .rpc()
    );

    // --- IMPORTANT: wait using on-chain reveal_deadline_slot + cfg.claim_grace_slots ---
    const roundAcc = await program.account.round.fetch(roundPda, "confirmed");
    const revealDlOnChain = Number(
      roundAcc.revealDeadlineSlot ?? roundAcc.reveal_deadline_slot
    );

    const cfgAcc = await program.account.config.fetch(configPda, "confirmed");
    const graceBn =
      (cfgAcc.claimGraceSlots ??
        cfgAcc.claim_grace_slots ??
        new BN(0));

    const grace = Number(graceBn.toString());

    // sweep_unclaimed requires current_slot > reveal_deadline_slot + claim_grace_slots
    const targetSlot = revealDlOnChain + grace + 1;

    while ((await provider.connection.getSlot("confirmed")) < targetSlot) {
      await new Promise((r) => setTimeout(r, 200));
    }

    // sweep
    await rpcConfirmed(
      provider,
      program.methods
        .sweepUnclaimed(new BN(roundId))
        .accounts({
          config: configPda,
          round: roundPda,
          vault: vaultPda,
          treasurySol: treasurySolPda,
          admin,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );

    // claim after sweep must fail
    await expectTxFail(async () => {
      await program.methods
        .claimReward(new BN(roundId), new BN(nonce))
        .accounts({
          config: configPda,
          round: roundPda,
          ticket: ticketPda,
          user: admin,
          timlgMint,
          timlgVault: timlgVaultPda,
          userTIMLGAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
    }, "ClaimAfterSweep");
  });

  it("hardening: reveal_batch_signed rejects mixed users (SignedBatchMixedUsers)", async () => {
    const admin = provider.wallet.publicKey;

    // userA = wallet, userB = random pubkey (no hace falta que tenga fondos)
    const userA = admin;
    const userB = anchor.web3.Keypair.generate().publicKey;

    // payer/relayer (solo para firmar el ix; fee payer será la wallet por defecto)
    const relayer = anchor.web3.Keypair.generate();

    const { configPda, timlgMint } = await ensureConfig(program, provider);

    const roundId = (Math.floor(Date.now() / 1000) + 9920) % 1_000_000;
    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot0 = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot0 + 6;
    const revealDeadline = slot0 + 200; // grande para que no cierre

    // create round
    await rpcConfirmed(
      provider,
      program.methods
        .createRound(new BN(roundId), new BN(111), new BN(commitDeadline), new BN(revealDeadline))
        .accounts({
          config: configPda,
          timlgMint,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    // wait end commit window (si tu setPulseMock lo exige)
    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    // set pulse mock -> imprescindible porque reveal_batch_signed requiere round.pulse_set
    const pulse = Buffer.alloc(64, 0);
    await rpcConfirmed(
      provider,
      program.methods
        .setPulseMock(new BN(roundId), Array.from(pulse))
        .accounts({ config: configPda, round: roundPda, admin })
        .rpc()
    );

    // Mixed entries (A y B en el mismo batch) => debe fallar ANTES de chequear ed25519/tickets
    const entries = [
      {
        user: userA,
        nonce: new BN(1),
        guess: 1,
        salt: Array.from(Buffer.alloc(32, 1)),
      },
      {
        user: userB,
        nonce: new BN(2),
        guess: 0,
        salt: Array.from(Buffer.alloc(32, 2)),
      },
    ];

    // remainingAccounts debe tener la misma longitud que entries (aunque no se use por el early-fail)
    const dummy1 = anchor.web3.Keypair.generate().publicKey;
    const dummy2 = anchor.web3.Keypair.generate().publicKey;

    await expectTxFail(async () => {
      await program.methods
        .revealBatchSigned(new BN(roundId), entries)
        .accounts({
          config: configPda,
          round: roundPda,
          payer: relayer.publicKey,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: dummy1, isWritable: true, isSigner: false },
          { pubkey: dummy2, isWritable: true, isSigner: false },
        ])
        .signers([relayer])
        .rpc();
    }, "SignedBatchMixedUsers");
  });

  it("hardening: reveal_batch_signed replay fails with AlreadyRevealed", async () => {
    const userKp = provider.wallet.payer;
    const user = userKp.publicKey;

    const relayer = anchor.web3.Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(relayer.publicKey, 2_000_000_000),
      "confirmed"
    );

    const { configPda, timlgMint, userTIMLGAta } = await ensureConfig(program, provider);

    const roundId = (Math.floor(Date.now() / 1000) + 9921) % 1_000_000;
    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot0 = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot0 + 8;
    const revealDeadline = slot0 + 200;

    // create round
    await rpcConfirmed(
      provider,
      program.methods
        .createRound(new BN(roundId), new BN(222), new BN(commitDeadline), new BN(revealDeadline))
        .accounts({
          config: configPda,
          timlgMint,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin: user,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    // commit 1 ticket (no signed)
    const nonce = 7;
    const guess = 1;
    const salt = crypto.randomBytes(32);
    const commitment = commitHash(roundId, user, nonce, guess, salt);
    const ticketPda = deriveTicketPda(program.programId, roundId, user, nonce);

    await rpcConfirmed(
      provider,
      program.methods
        .commitTicket(new BN(roundId), new BN(nonce), Array.from(commitment))
        .accounts({
          config: configPda,
          round: roundPda,
          timlgMint,
          timlgVault: timlgVaultPda,
          ticket: ticketPda,
          user,
          userTIMLGAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc()
    );

    // wait commit window end
    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    // set pulse mock so ticket wins (opcional para este test, pero consistente)
    const pulse = Buffer.alloc(64, 0);
    setBit(pulse, deriveBitIndex(roundId, user, nonce), guess);

    await rpcConfirmed(
      provider,
      program.methods
        .setPulseMock(new BN(roundId), Array.from(pulse))
        .accounts({ config: configPda, round: roundPda, admin: user })
        .rpc()
    );

    // build reveal_batch_signed tx (ed25519 ix must be immediately before the program ix)
    const entries = [{ user, nonce: new BN(nonce), guess, salt: Array.from(salt) }];

    const msg = expectedRevealMsg(program.programId, roundId, user, nonce, guess, salt);
    const edIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: userKp.secretKey,
      message: msg,
    });

    const progIx = await program.methods
      .revealBatchSigned(new BN(roundId), entries)
      .accounts({
        config: configPda,
        round: roundPda,
        payer: relayer.publicKey,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([{ pubkey: ticketPda, isWritable: true, isSigner: false }])
      .instruction();

    // 1) first reveal ok
    {
      const tx = new Transaction().add(edIx, progIx);
      tx.feePayer = relayer.publicKey;
      const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.sign(relayer);

      await sendAndConfirmTransaction(provider.connection, tx, [relayer], {
        commitment: "confirmed",
      });
    }

    // 2) replay reveal must fail with AlreadyRevealed
    await expectTxFail(async () => {
      const edIx2 = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: userKp.secretKey,
        message: msg,
      });

      const tx2 = new Transaction().add(edIx2, progIx);
      tx2.feePayer = relayer.publicKey;
      const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
      tx2.recentBlockhash = blockhash;
      tx2.sign(relayer);

      await sendAndConfirmTransaction(provider.connection, tx2, [relayer], {
        commitment: "confirmed",
      });
    }, "AlreadyRevealed");
  });

  it("hardening: set_pulse_signed replay is rejected (PulseAlreadySet)", async () => {
    const adminKp = provider.wallet.payer;
    const admin = adminKp.publicKey;

    const oracle = Keypair.generate();
    const relayer = Keypair.generate();

    // fund relayer
    {
      const sig = await provider.connection.requestAirdrop(
        relayer.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await confirmSig(provider.connection, sig, "confirmed");
    }

    const { configPda } = await ensureConfig(program, provider);

    // set oracle pubkey (admin only)
    await rpcConfirmed(
      provider,
      program.methods
        .setOraclePubkey(oracle.publicKey)
        .accounts({ config: configPda, admin })
        .rpc()
    );

    const roundId = (Math.floor(Date.now() / 1000) + 4444) % 1000000;
    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot + 10;

    await rpcConfirmed(
      provider,
      program.methods
        .createRound(new BN(roundId), new BN(9999), new BN(commitDeadline), new BN(slot + 200))
        .accounts({
          config: configPda,
          timlgMint: TIMLG_MINT,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    // wait past commit deadline
    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    const pulse = crypto.randomBytes(64);

    // --- first set_pulse_signed succeeds ---
    const msg = expectedPulseMsg(program.programId, roundId, 9999, pulse);
    const edIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: oracle.secretKey,
      message: msg,
    });

    const anchorIx = await program.methods
      .setPulseSigned(new BN(roundId), Array.from(pulse))
      .accounts({
        config: configPda,
        round: roundPda,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    {
      const tx = new Transaction().add(edIx, anchorIx);
      tx.feePayer = relayer.publicKey;
      const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.sign(relayer);

      await sendAndConfirmTransaction(provider.connection, tx, [relayer], {
        commitment: "confirmed",
      });
    }

    // --- replay: should fail BEFORE ed25519 checks with PulseAlreadySet ---
    await expectTxFail(async () => {
      await program.methods
        .setPulseSigned(new BN(roundId), Array.from(pulse))
        .accounts({
          config: configPda,
          round: roundPda,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc();
    }, "PulseAlreadySet");
  });

  it("hardening: set_pulse_signed without ed25519 ix fails (MissingOrInvalidEd25519Ix)", async () => {
    const adminKp = provider.wallet.payer;
    const admin = adminKp.publicKey;

    const oracle = Keypair.generate();

    const { configPda } = await ensureConfig(program, provider);

    await rpcConfirmed(
      provider,
      program.methods
        .setOraclePubkey(oracle.publicKey)
        .accounts({ config: configPda, admin })
        .rpc()
    );

    const roundId = (Math.floor(Date.now() / 1000) + 4445) % 1000000;
    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot + 8;

    await rpcConfirmed(
      provider,
      program.methods
        .createRound(new BN(roundId), new BN(12345), new BN(commitDeadline), new BN(slot + 200))
        .accounts({
          config: configPda,
          timlgMint: TIMLG_MINT,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    const pulse = crypto.randomBytes(64);

    await expectTxFail(async () => {
      // no ed25519 instruction in the tx
      await program.methods
        .setPulseSigned(new BN(roundId), Array.from(pulse))
        .accounts({
          config: configPda,
          round: roundPda,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc();
    }, "MissingOrInvalidEd25519Ix");
  });

  it("hardening: set_pulse_signed message is frozen; wrong payload fails (Ed25519MessageMismatch)", async () => {
    const adminKp = provider.wallet.payer;
    const admin = adminKp.publicKey;

    const oracle = Keypair.generate();
    const relayer = Keypair.generate();

    // fund relayer
    {
      const sig = await provider.connection.requestAirdrop(
        relayer.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await confirmSig(provider.connection, sig, "confirmed");
    }

    const { configPda } = await ensureConfig(program, provider);

    await rpcConfirmed(
      provider,
      program.methods
        .setOraclePubkey(oracle.publicKey)
        .accounts({ config: configPda, admin })
        .rpc()
    );

    const roundId = (Math.floor(Date.now() / 1000) + 4447) % 1000000;
    const pulseIndexTarget = 77777;

    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot + 8;

    await rpcConfirmed(
      provider,
      program.methods
        .createRound(new BN(roundId), new BN(pulseIndexTarget), new BN(commitDeadline), new BN(slot + 200))
        .accounts({
          config: configPda,
          timlgMint: TIMLG_MINT,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    const pulse = crypto.randomBytes(64);

    // WRONG payload: pulseIndexTarget changed => msg mismatch
    const wrongMsg = expectedPulseMsg(program.programId, roundId, pulseIndexTarget + 1, pulse);

    const edIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: oracle.secretKey,
      message: wrongMsg,
    });

    const anchorIx = await program.methods
      .setPulseSigned(new BN(roundId), Array.from(pulse))
      .accounts({
        config: configPda,
        round: roundPda,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    await expectTxFail(async () => {
      const tx = new Transaction().add(edIx, anchorIx);
      tx.feePayer = relayer.publicKey;
      const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.sign(relayer);

      await sendAndConfirmTransaction(provider.connection, tx, [relayer], {
        commitment: "confirmed",
      });
    }, "Ed25519MessageMismatch");
  });

  it("hardening: set_pulse_signed wrong oracle pubkey fails (Ed25519PubkeyMismatch)", async () => {
    const admin = provider.wallet.publicKey;

    const oracle = Keypair.generate();
    const wrongOracle = Keypair.generate();
    const relayer = Keypair.generate();

    // fund relayer
    {
      const sig = await provider.connection.requestAirdrop(
        relayer.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await confirmSig(provider.connection, sig, "confirmed");
    }

    const { configPda } = await ensureConfig(program, provider);

    // config expects THIS oracle
    await rpcConfirmed(
      provider,
      program.methods
        .setOraclePubkey(oracle.publicKey)
        .accounts({ config: configPda, admin })
        .rpc()
    );

    const roundId = (Math.floor(Date.now() / 1000) + 4450) % 1000000;
    const pulseIndexTarget = 11111;

    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot + 8;

    await rpcConfirmed(
      provider,
      program.methods
        .createRound(new BN(roundId), new BN(pulseIndexTarget), new BN(commitDeadline), new BN(slot + 200))
        .accounts({
          config: configPda,
          timlgMint: TIMLG_MINT,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    const pulse = crypto.randomBytes(64);

    // message is correct, but signer is wrongOracle
    const msg = expectedPulseMsg(program.programId, roundId, pulseIndexTarget, pulse);

    const edIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: wrongOracle.secretKey,
      message: msg,
    });

    const anchorIx = await program.methods
      .setPulseSigned(new BN(roundId), Array.from(pulse))
      .accounts({
        config: configPda,
        round: roundPda,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    await expectTxFail(async () => {
      const tx = new Transaction().add(edIx, anchorIx);
      tx.feePayer = relayer.publicKey;
      const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.sign(relayer);

      await sendAndConfirmTransaction(provider.connection, tx, [relayer], {
        commitment: "confirmed",
      });
    }, "Ed25519PubkeyMismatch");
  });
 
  it("hardening: set_pulse_signed fails if ed25519 ix is not immediately before (MissingOrInvalidEd25519Ix)", async () => {
    const admin = provider.wallet.publicKey;

    const oracle = Keypair.generate();
    const relayer = Keypair.generate();

    // fund relayer
    {
      const sig = await provider.connection.requestAirdrop(
        relayer.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await confirmSig(provider.connection, sig, "confirmed");
    }

    const { configPda } = await ensureConfig(program, provider);

    await rpcConfirmed(
      provider,
      program.methods
        .setOraclePubkey(oracle.publicKey)
        .accounts({ config: configPda, admin })
        .rpc()
    );

    const roundId = (Math.floor(Date.now() / 1000) + 4451) % 1000000;
    const pulseIndexTarget = 22222;

    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot + 8;

    await rpcConfirmed(
      provider,
      program.methods
        .createRound(new BN(roundId), new BN(pulseIndexTarget), new BN(commitDeadline), new BN(slot + 200))
        .accounts({
          config: configPda,
          timlgMint: TIMLG_MINT,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    const pulse = crypto.randomBytes(64);

    const msg = expectedPulseMsg(program.programId, roundId, pulseIndexTarget, pulse);

    const edIx = Ed25519Program.createInstructionWithPrivateKey({
      privateKey: oracle.secretKey,
      message: msg,
    });

    // NOOP instruction between ed25519 and anchor ix
    const noopIx = SystemProgram.transfer({
      fromPubkey: relayer.publicKey,
      toPubkey: relayer.publicKey,
      lamports: 0,
    });

    const anchorIx = await program.methods
      .setPulseSigned(new BN(roundId), Array.from(pulse))
      .accounts({
        config: configPda,
        round: roundPda,
        instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .instruction();

    await expectTxFail(async () => {
      const tx = new Transaction().add(edIx, noopIx, anchorIx); // <-- breaks adjacency
      tx.feePayer = relayer.publicKey;
      const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.sign(relayer);

      await sendAndConfirmTransaction(provider.connection, tx, [relayer], {
        commitment: "confirmed",
      });
    }, "MissingOrInvalidEd25519Ix");
  });

  it("oracle rotation: old oracle can no longer set_pulse_signed after update", async () => {
    const adminKp = provider.wallet.payer;
    const admin = adminKp.publicKey;

    const oracleOld = Keypair.generate();
    const oracleNew = Keypair.generate();
    const relayer = Keypair.generate();

    // Fund relayer
    {
      const sig = await provider.connection.requestAirdrop(
        relayer.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await confirmSig(provider.connection, sig, "confirmed");
    }

    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
    await ensureConfig(program, provider, configPda);

    // 1) Set OLD oracle pubkey
    await rpcConfirmed(
      provider,
      program.methods
        .setOraclePubkey(oracleOld.publicKey)
        .accounts({ config: configPda, admin })
        .rpc()
    );

    // Create round
    const roundId = (Math.floor(Date.now() / 1000) + 777) % 1000000;
    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot + 10;
    const revealDeadline = slot + 200;
    const pulseIndexTarget = 111111;

    await rpcConfirmed(
      provider,
      program.methods
        .createRound(
          new BN(roundId),
          new BN(pulseIndexTarget),
          new BN(commitDeadline),
          new BN(revealDeadline)
        )
        .accounts({
          config: configPda,
          timlgMint: TIMLG_MINT,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    // Wait past commit deadline
    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    // 2) Rotate to NEW oracle pubkey
    await rpcConfirmed(
      provider,
      program.methods
        .setOraclePubkey(oracleNew.publicKey)
        .accounts({ config: configPda, admin })
        .rpc()
    );

    // Build pulse message (canonical)
    const pulse = crypto.randomBytes(64);
    const msg = expectedPulseMsg(program.programId, roundId, pulseIndexTarget, pulse);

    // 3) Try with OLD oracle => must fail (pubkey mismatch)
    {
      const edIxOld = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: oracleOld.secretKey,
        message: msg,
      });

      const anchorIx = await program.methods
        .setPulseSigned(new BN(roundId), Array.from(pulse))
        .accounts({
          config: configPda,
          round: roundPda,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const tx = new Transaction().add(edIxOld, anchorIx);
      tx.feePayer = relayer.publicKey;

      const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.sign(relayer);

      await expectTxFail(
        async () =>
          sendAndConfirmTransaction(provider.connection, tx, [relayer], {
            commitment: "confirmed",
          }),
        "Ed25519PubkeyMismatch"
      );
    }

    // 4) Try with NEW oracle => must succeed
    {
      const edIxNew = Ed25519Program.createInstructionWithPrivateKey({
        privateKey: oracleNew.secretKey,
        message: msg,
      });

      const anchorIx = await program.methods
        .setPulseSigned(new BN(roundId), Array.from(pulse))
        .accounts({
          config: configPda,
          round: roundPda,
          instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .instruction();

      const tx = new Transaction().add(edIxNew, anchorIx);
      tx.feePayer = relayer.publicKey;

      const { blockhash } = await provider.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.sign(relayer);

      await sendAndConfirmTransaction(provider.connection, tx, [relayer], {
        commitment: "confirmed",
      });
    }

    const r = await program.account.round.fetch(roundPda);
    if (!r.pulseSet) throw new Error("pulseSet should be true after NEW oracle succeeds");
  });

  it("settle_round_tokens supports incremental settlement via settled_count", async () => {
    const admin = provider.wallet.publicKey;

    const { configPda, timlgMint, treasuryPda, userTIMLGAta } = await ensureBoot(program, provider);

    const roundId = (Math.floor(Date.now() / 1000) + 4242) % 1_000_000;
    const { roundPda, vaultPda, timlgVaultPda } = deriveRoundPdas(program.programId, roundId);

    const slot0 = await provider.connection.getSlot("confirmed");
    const commitDeadline = slot0 + 10;
    const revealDeadline = slot0 + 25;

    await rpcConfirmed(
      provider,
      program.methods
        .createRound(new BN(roundId), new BN(999), new BN(commitDeadline), new BN(revealDeadline))
        .accounts({
          config: configPda,
          timlgMint,
          round: roundPda,
          vault: vaultPda,
          timlgVault: timlgVaultPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .rpc()
    );

    // Create 4 tickets
    const tickets = [];
    for (let nonce = 1; nonce <= 4; nonce++) {
      const guess = 1;
      const salt = crypto.randomBytes(32);
      const commitment = commitHash(roundId, admin, nonce, guess, salt);
      const ticketPda = deriveTicketPda(program.programId, roundId, admin, nonce);

      await rpcConfirmed(
        provider,
        program.methods
          .commitTicket(new BN(roundId), new BN(nonce), Array.from(commitment))
          .accounts({
            config: configPda,
            round: roundPda,
            timlgMint,
            timlgVault: timlgVaultPda,
            ticket: ticketPda,
            user: admin,
            userTIMLGAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc()
      );

      tickets.push({ nonce, guess, salt, ticketPda });
    }

    // Wait >= commitDeadline then set pulse
    while ((await provider.connection.getSlot("confirmed")) < commitDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    // Make nonce=1 win (bit=1), nonce=2 lose (bit=0). Others irrelevant (unrevealed).
    const pulse = Buffer.alloc(64, 0);
    const bit1 = deriveBitIndex(roundId, admin, 1);
    const bit2 = deriveBitIndex(roundId, admin, 2);
    setBit(pulse, bit1, 1);
    setBit(pulse, bit2, 0);

    await rpcConfirmed(
      provider,
      program.methods
        .setPulseMock(new BN(roundId), Array.from(pulse))
        .accounts({ config: configPda, round: roundPda, admin })
        .rpc()
    );

    // Reveal only 2 tickets (nonce 1 and 2). Leave 3 and 4 unrevealed.
    for (const t of tickets.filter((x) => x.nonce === 1 || x.nonce === 2)) {
      await rpcConfirmed(
        provider,
        program.methods
          .revealTicket(new BN(roundId), new BN(t.nonce), t.guess, Array.from(t.salt))
          .accounts({ config: configPda, round: roundPda, ticket: t.ticketPda, user: admin })
          .rpc()
      );
    }

    // Wait > revealDeadline then finalize
    while ((await provider.connection.getSlot("confirmed")) <= revealDeadline) {
      await new Promise((r) => setTimeout(r, 120));
    }

    await rpcConfirmed(
      provider,
      program.methods
        .finalizeRound(new BN(roundId))
        .accounts({ config: configPda, round: roundPda, admin })
        .rpc()
    );

    // --- Incremental settle #1: settle two tickets (1 and 3)
    await rpcConfirmed(
      provider,
      program.methods
        .settleRoundTokens(new BN(roundId))
        .accounts({
          config: configPda,
          round: roundPda,
          timlgMint,
          timlgVault: timlgVaultPda,
          treasury: treasuryPda,
          tokenomics: tokenomicsPda,
          replicationPool: replicationPoolPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: tickets[0].ticketPda, isSigner: false, isWritable: true }, // nonce 1
          { pubkey: tickets[2].ticketPda, isSigner: false, isWritable: true }, // nonce 3
        ])
        .rpc()
    );

    let r1 = await program.account.round.fetch(roundPda, "confirmed");
    const settled1 = (r1.settledCount ?? r1.settled_count).toString();
    const committed = (r1.committedCount ?? r1.committed_count).toString();
    const tokenSettled1 = (r1.tokenSettled ?? r1.token_settled);

    if (committed !== "4") throw new Error(`expected committed_count=4, got ${committed}`);
    if (settled1 !== "2") throw new Error(`expected settled_count=2, got ${settled1}`);
    if (tokenSettled1) throw new Error("token_settled should be false after partial settle");

    // --- Incremental settle #2: settle remaining tickets (2 and 4)
    await rpcConfirmed(
      provider,
      program.methods
        .settleRoundTokens(new BN(roundId))
        .accounts({
          config: configPda,
          round: roundPda,
          timlgMint,
          timlgVault: timlgVaultPda,
          treasury: treasuryPda,
          tokenomics: tokenomicsPda,
          replicationPool: replicationPoolPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: tickets[1].ticketPda, isSigner: false, isWritable: true }, // nonce 2
          { pubkey: tickets[3].ticketPda, isSigner: false, isWritable: true }, // nonce 4
        ])
        .rpc()
    );

    let r2 = await program.account.round.fetch(roundPda, "confirmed");
    const settled2 = (r2.settledCount ?? r2.settled_count).toString();
    const tokenSettled2 = (r2.tokenSettled ?? r2.token_settled);

    if (settled2 !== "4") throw new Error(`expected settled_count=4, got ${settled2}`);
    if (!tokenSettled2) throw new Error("token_settled should be true after full settle");

    // calling again must fail now
    await expectTxFail(async () => {
      await program.methods
        .settleRoundTokens(new BN(roundId))
        .accounts({
          config: configPda,
          round: roundPda,
          timlgMint,
          timlgVault: timlgVaultPda,
          treasury: treasuryPda,
          tokenomics: tokenomicsPda,
          replicationPool: replicationPoolPda,
          admin,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([{ pubkey: tickets[0].ticketPda, isSigner: false, isWritable: true }])
        .rpc();
    }, "RoundTokensAlreadySettled");
  });

  it("oracle_set: initialize + add/remove + set_threshold", async () => {
    const admin = provider.wallet.publicKey;
    const payer = provider.wallet.payer; // Keypair (NodeWallet)

    const { configPda } = await ensureConfig(program, provider);

    const [oracleSetPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oracle_set"), configPda.toBytes()],
      program.programId
    );

    const oracle1 = Keypair.generate();
    const oracle2 = Keypair.generate();

    // init (if not exists)
    const existing = await program.account.oracleSet.fetchNullable(oracleSetPda);
    if (!existing) {
      await rpcConfirmed(
        provider,
        program.methods
          .initializeOracleSet(
            1, // threshold
            [oracle1.publicKey] // initial_oracles
          )
          .accounts({
            config: configPda,
            oracleSet: oracleSetPda,
            admin,
            systemProgram: SystemProgram.programId,
            rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          })
          .signers([payer])
          .rpc()
      );
    }

    // add oracle2
    await rpcConfirmed(
      provider,
      program.methods
        .addOracle(oracle2.publicKey)
        .accounts({
          config: configPda,
          oracleSet: oracleSetPda,
          admin,
        })
        .rpc()
    );

    // set threshold to 2 (must be <= allowlist length)
    await rpcConfirmed(
      provider,
      program.methods
        .setOracleThreshold(2)
        .accounts({
          config: configPda,
          oracleSet: oracleSetPda,
          admin,
        })
        .rpc()
    );

    // removing oracle2 now should fail (threshold would exceed oracle count)
    await expectTxFail(
      async () =>
        rpcConfirmed(
          provider,
          program.methods
            .removeOracle(oracle2.publicKey)
            .accounts({
              config: configPda,
              oracleSet: oracleSetPda,
              admin,
            })
            .rpc()
        ),
      "Threshold exceeds current oracle count"
    );

    // lower threshold back to 1
    await rpcConfirmed(
      provider,
      program.methods
        .setOracleThreshold(1)
        .accounts({
          config: configPda,
          oracleSet: oracleSetPda,
          admin,
        })
        .rpc()
    );

    // now remove oracle2 should succeed
    await rpcConfirmed(
      provider,
      program.methods
        .removeOracle(oracle2.publicKey)
        .accounts({
          config: configPda,
          oracleSet: oracleSetPda,
          admin,
        })
        .rpc()
    );

    const os = await program.account.oracleSet.fetch(oracleSetPda);
    if (os.threshold !== 1) throw new Error("threshold mismatch");
    // oracle2 should be gone
    const has2 = os.oracles.some((pk) => pk.equals(oracle2.publicKey));
    if (has2) throw new Error("oracle2 still present after removal");
  });

});
