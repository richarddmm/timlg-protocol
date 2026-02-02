// oracle/run_oracle_devnet.js

const fs = require("fs");
const path = require("path");
const anchor = require("@coral-xyz/anchor");
const {
  PublicKey,
  Connection,
  Keypair,
  Transaction,
  Ed25519Program,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const BN = require("bn.js");

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function expandPath(p) {
  if (!p) return p;
  if (p.startsWith("~")) return path.join(process.env.HOME || "", p.slice(1));
  return p;
}

function loadKeypair(p) {
  const fp = expandPath(p);
  const secret = JSON.parse(fs.readFileSync(fp, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function leU64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

// Must match on-chain expected_pulse_msg:
// b"timlg-protocol:pulse_v1" + program_id + round_id(le u64) + pulse_index_target(le u64) + pulse[64]
function expectedPulseMsg(programId, roundId, pulseIndexTarget, pulse64) {
  return Buffer.concat([
    Buffer.from("timlg-protocol:pulse_v1", "utf8"),
    programId.toBytes(),
    leU64(roundId),
    leU64(pulseIndexTarget),
    Buffer.from(pulse64),
  ]);
}

function deriveConfigPda(programId) {
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config_v3")], programId);
  return configPda;
}

function deriveRoundPda(programId, roundId) {
  const [roundPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("round_v3"), leU64(roundId)],
    programId
  );
  return roundPda;
}

const NIST_BASE = "https://beacon.nist.gov/beacon/2.0";

async function fetchNistPulseBytes(chainIndex, pulseIndex) {
  const url = `${NIST_BASE}/chain/${chainIndex}/pulse/${pulseIndex}`;
  const res = await fetch(url, { method: "GET", headers: { accept: "application/json" } });

  if (res.status === 404) {
    const err = new Error(`NIST pulse not found yet (404): chain=${chainIndex} pulse=${pulseIndex}`);
    err.code = "NIST_404";
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`NIST fetch failed ${res.status}: ${text || url}`);
  }

  const json = await res.json();
  const outputValue = json?.pulse?.outputValue;
  if (typeof outputValue !== "string") throw new Error("Unexpected NIST JSON: missing pulse.outputValue");

  const pulse = Buffer.from(outputValue, "hex");
  if (pulse.length !== 64) throw new Error(`Invalid outputValue length: got ${pulse.length} bytes (expected 64)`);
  return pulse;
}

async function waitForNistPulseBytes(chainIndex, pulseIndex, { pollMs, timeoutMs }) {
  const t0 = Date.now();
  while (true) {
    try {
      return await fetchNistPulseBytes(chainIndex, pulseIndex);
    } catch (e) {
      if (e && e.code === "NIST_404") {
        if (Date.now() - t0 > timeoutMs) {
          throw new Error(`Timeout waiting NIST pulse chain=${chainIndex} pulse=${pulseIndex}`);
        }
        await sleep(pollMs);
        continue;
      }
      throw e;
    }
  }
}

function camelize(idlName) {
  return idlName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function pickInstructionName(idl, preferred) {
  const names = (idl.instructions || []).map((i) => i.name);
  for (const n of preferred) if (names.includes(n)) return n;
  const guess = names.find((n) => n.includes("pulse") && n.includes("signed"));
  if (guess) return guess;
  throw new Error(`Cannot find set_pulse_signed in IDL. Instructions: ${names.join(", ")}`);
}

async function main() {
  const rpcUrl = process.env.RPC_URL || "https://api.devnet.solana.com";
  const programId = new PublicKey(mustEnv("PROGRAM_ID"));
  const idlPath = expandPath(process.env.IDL_PATH || "./target/idl/timlg_protocol.json");

  const relayer = loadKeypair(mustEnv("RELAYER_KEYPAIR"));

  const oraclePath =
    process.env.ORACLE_KEYPAIR ||
    process.env.ORACLE_KEYPAIR_PATH ||
    `${process.env.HOME}/.config/timlg/oracle/id.json`;
  const oracle = loadKeypair(oraclePath);

  const roundId = Number(mustEnv("ROUND_ID"));
  if (!Number.isSafeInteger(roundId)) throw new Error("ROUND_ID must be an integer");

  const chainIndex = Number(process.env.NIST_CHAIN_INDEX ?? "2");
  if (!Number.isSafeInteger(chainIndex)) throw new Error("NIST_CHAIN_INDEX must be an integer");

  const pollMs = Number(process.env.POLL_MS ?? "1000"); // OPTIMIZED: 3s -> 1s
  const timeoutMs = Number(process.env.TIMEOUT_MS ?? String(10 * 60 * 1000));

  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(relayer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  anchor.setProvider(provider);

  const idlLocal = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  idlLocal.address = programId.toBase58();
  const program = new anchor.Program(idlLocal, provider);

  const configPda = deriveConfigPda(programId);
  const roundPda = deriveRoundPda(programId, roundId);

  console.log("RPC:", rpcUrl);
  console.log("Program:", programId.toBase58());
  console.log("Config PDA:", configPda.toBase58());
  console.log("Round PDA:", roundPda.toBase58());
  console.log("Relayer:", relayer.publicKey.toBase58());
  console.log("Oracle pubkey:", oracle.publicKey.toBase58());
  console.log("NIST:", `${NIST_BASE}/chain/${chainIndex}/pulse/<pulseIndex>`);

  const round = await program.account.round.fetch(roundPda);
  if (round.pulseSet) {
    console.log("Round already has pulseSet=true. Nothing to do.");
    return;
  }

  const pulseIndexTarget = Number(round.pulseIndexTarget.toString());
  const commitDeadlineSlot = Number(round.commitDeadlineSlot.toString());

  console.log("pulseIndexTarget:", pulseIndexTarget);
  console.log("commitDeadlineSlot:", commitDeadlineSlot);

  while ((await connection.getSlot("confirmed")) < commitDeadlineSlot) {
    await sleep(500); // OPTIMIZED: 1s -> 500ms
  }

  console.log(`Waiting NIST pulse chain=${chainIndex} pulse=${pulseIndexTarget} ...`);
  const pulse = await waitForNistPulseBytes(chainIndex, pulseIndexTarget, { pollMs, timeoutMs });
  console.log("NIST pulse bytes ok (64 bytes).");

  const msg = expectedPulseMsg(programId, roundId, pulseIndexTarget, pulse);

  const edIx = Ed25519Program.createInstructionWithPrivateKey({
    privateKey: oracle.secretKey,
    message: msg,
  });

  // Debug: si vuelve a salir mismatch, aquí verás si está firmando con el oracle real
  console.log("Ed25519 signer pubkey:", oracle.publicKey.toBase58());

  const ixName = pickInstructionName(idlLocal, ["set_pulse_signed", "setPulseSigned"]);
  const jsName = camelize(ixName);

  const setPulseIx = await program.methods[jsName](new BN(roundId), Array.from(pulse))
    .accounts({
      config: configPda,
      round: roundPda,
      instructions: anchor.web3.SYSVAR_INSTRUCTIONS_PUBKEY,
    })
    .instruction();

  const tx = new Transaction().add(edIx, setPulseIx);
  // Relayer keypair pays fees in current Devnet tooling (script-driven). Not a standalone relayer service yet.
  tx.feePayer = relayer.publicKey;

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;

  tx.sign(relayer);

  const sig = await sendAndConfirmTransaction(connection, tx, [relayer], {
    commitment: "confirmed",
  });

  console.log("✅ set_pulse_signed tx:", sig);

  const roundAfter = await program.account.round.fetch(roundPda);
  if (!roundAfter.pulseSet) throw new Error("pulseSet=false after tx (unexpected)");

  console.log("✅ pulseSet=true on-chain");
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
