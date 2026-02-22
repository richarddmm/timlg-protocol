// oracle/settle_round_tokens_devnet_manual.js
//
// Env (recommended):
//   RPC_URL=https://api.devnet.solana.com
//   PROGRAM_ID=...
//   ADMIN_KEYPAIR=~/.config/solana/id.json
//   ROUND_ID=16
//
// Optional:
//   IDL_PATH=./target/idl/timlg_protocol.json   (fallback if no on-chain IDL)
//   TOKENOMICS_PDA=<pubkey>                 (force tokenomics PDA if you want)
//   TICKETS=<ticket1,ticket2,...>           (force ticket list)
//   RECEIPT_PATH=oracle/out/reveal_round${ROUND_ID}_*.json (single receipt path)
//
// Run:
//   ROUND_ID=16 PROGRAM_ID=... node oracle/settle_round_tokens_devnet_manual.js

const fs = require("fs");
const path = require("path");
const anchor = require("@coral-xyz/anchor");
const { PublicKey, Connection, Keypair } = require("@solana/web3.js");
const { TOKEN_PROGRAM_ID, getAccount } = require("@solana/spl-token");
let bs58;
try { bs58 = require("bs58"); } catch (e) { bs58 = anchor.utils.bytes.bs58; }
const crypto = require("crypto");


// ---------- helpers ----------
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}
function envStr(name, def) {
  const v = process.env[name];
  return v == null ? def : v;
}
function envInt(name, def) {
  const v = process.env[name];
  if (v == null) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return n;
}
function loadKeypair(filePath) {
  const p = filePath.startsWith("~")
    ? path.join(process.env.HOME || "", filePath.slice(1))
    : filePath;
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}
function camelize(idlName) {
  return idlName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
function findAccountNameInIdl(idl, containsLower) {
  const needle = (containsLower || "").toLowerCase();
  const accounts = (idl && idl.accounts) || [];
  const hit = accounts.find((a) => (a.name || "").toLowerCase().includes(needle));
  return hit ? hit.name : null;
}
function derivePdaSeeds(programId, seeds) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}
function derivePda(programId, seedStr) {
  return derivePdaSeeds(programId, [Buffer.from(seedStr)]);
}
function deriveTokenomicsPda(programId, configPda) {
  // On-chain seeds: [TOKENOMICS_SEED, config.key().as_ref()]
  return derivePdaSeeds(programId, [Buffer.from("tokenomics_v3"), configPda.toBuffer()]);
}
function u64LE(n) {
  const bn = BigInt(n);
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(bn, 0);
  return b;
}
function deriveRoundPda(programId, roundId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("round_v3"), u64LE(roundId)],
    programId
  )[0];
}
async function loadIdl(provider, programId, idlPath) {
  try {
    const onchain = await anchor.Program.fetchIdl(programId, provider);
    if (onchain && onchain.instructions?.length) return { idl: onchain, source: "on-chain" };
  } catch (_) { }
  const local = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  return { idl: local, source: "local" };
}
async function mustGetAccountInfo(connection, pubkey, label) {
  const info = await connection.getAccountInfo(pubkey, "confirmed");
  if (!info) throw new Error(`${label} not found on-chain: ${pubkey.toBase58()}`);
  return info;
}
function flattenAccounts(ixAccounts, out = []) {
  for (const a of ixAccounts || []) {
    if (a.accounts) flattenAccounts(a.accounts, out);
    else out.push(a);
  }
  return out;
}
function buildAccountsObjectFromIdl(ix, candidates) {
  const need = flattenAccounts(ix.accounts).map(a => a.name);
  const out = {};
  for (const rawName of need) {
    const key = camelize(rawName);
    const val =
      candidates[key] ??
      candidates[rawName] ??
      null;
    if (!val) throw new Error(`Missing required account '${key}' for ${ix.name}`);
    out[key] = val;
  }
  return out;
}
function parseCsvPubkeys(str) {
  if (!str) return [];
  return String(str)
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => new PublicKey(s));
}
function pickIx(idl, name) {
  const ix = (idl.instructions || []).find(i => i.name === name);
  if (!ix) {
    const names = (idl.instructions || []).map(i => i.name).join(", ");
    throw new Error(`Instruction '${name}' not found in IDL. Have: ${names}`);
  }
  return ix;
}

// ----- auto-discovery helpers (for web UI flow) -----
function bnToNumber(x) {
  if (x == null) return null;
  if (typeof x === "number") return x;
  if (typeof x === "bigint") return Number(x);
  if (typeof x === "string" && x.trim() !== "") {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof x === "object" && typeof x.toNumber === "function") return x.toNumber(); // BN
  return null;
}

function accountDiscriminator(name) {
  // anchor >= 0.30
  if (anchor?.utils?.discriminator?.accountDiscriminator) {
    return Buffer.from(anchor.utils.discriminator.accountDiscriminator(name));
  }
  // fallback: sha256("account:" + name).slice(0,8)
  return crypto.createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

function findTicketAccountName(idl) {
  const names = (idl.accounts || []).map(a => a.name);
  const exact = names.find(n => n.toLowerCase() === "ticket");
  if (exact) return exact;
  const hit = names.find(n => n.toLowerCase().includes("ticket"));
  if (!hit) throw new Error(`Could not find Ticket account in IDL. Have: ${names.join(", ")}`);
  return hit;
}

function ticketRoundId(decoded) {
  return (
    bnToNumber(decoded.roundId) ??
    bnToNumber(decoded.round_id) ??
    bnToNumber(decoded.round)
  );
}

function ticketRevealed(decoded) {
  const v = decoded.revealed ?? decoded.isRevealed ?? decoded.revealSet ?? decoded.reveal_set;
  return typeof v === "boolean" ? v : null;
}

function ticketTokenSettled(decoded) {
  const v = decoded.tokenSettled ?? decoded.token_settled ?? decoded.settled ?? decoded.isSettled ?? decoded.processed;
  return typeof v === "boolean" ? v : null;
}

async function discoverTicketsForRound(connection, programId, coder, idl, roundId) {
  const ticketName = findTicketAccountName(idl);
  const disc = accountDiscriminator(ticketName);
  const disc58 = bs58.encode(disc);

  const roundIdxBuf = Buffer.alloc(8);
  roundIdxBuf.writeBigUInt64LE(BigInt(roundId), 0);
  const roundIdx58 = bs58.encode(roundIdxBuf);

  const accs = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset: 0, bytes: disc58 } },
      { memcmp: { offset: 8, bytes: roundIdx58 } } // round_id is at offset 8
    ],
  });

  const out = [];
  for (const { pubkey, account } of accs) {
    try {
      const decoded = coder.accounts.decode(ticketName, account.data);
      const rid = ticketRoundId(decoded);
      if (rid !== roundId) continue;

      // MVP-3.2: Allow unrevealed tickets so they can be Burned
      // const rev = ticketRevealed(decoded);
      // if (rev === false) continue;

      const settled = ticketTokenSettled(decoded);
      if (settled === true) continue;

      out.push(pubkey);
    } catch (_) {
      // ignore
    }
  }
  return out;
}


// ---------- main ----------
async function settleRound(connection, programId, admin, roundId) {
  // We assume admin is a Keypair
  // We reuse 'connection'

  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(admin), { commitment: "confirmed" });
  // local usage

  // Reuse existing loadIdl logic or pass it? For simplicity, we load it again (fs read is fast enough compared to spawn)
  // Optimization: In supervisor, we could pass the IDL object to avoid fs reads every time.
  const idlPath = envStr("IDL_PATH", "./target/idl/timlg_protocol.json");
  const { idl, source } = await loadIdl(provider, programId, idlPath);
  idl.address = programId.toBase58();
  const program = new anchor.Program(idl, provider);
  const coder = new anchor.BorshCoder(idl);

  // PDAs
  const configPda = derivePda(programId, "config_v3");
  // Optimization: We could pass configPda / tokenomicsPda if we knew them to avoid 1 RPC call
  const cfgInfo = await mustGetAccountInfo(connection, configPda, "Config PDA");
  const cfgName = findAccountNameInIdl(idl, "config") || "Config";
  const cfg = coder.accounts.decode(cfgName, cfgInfo.data);

  const timlgMint = new PublicKey(cfg.timlgMint ?? cfg.timlg_mint);
  const treasury = new PublicKey(cfg.treasury);
  const tokenomicsFromCfg = cfg.tokenomicsPda ?? cfg.tokenomics_pda ?? cfg.tokenomics;

  const tokenomicsPda = process.env.TOKENOMICS_PDA
    ? new PublicKey(process.env.TOKENOMICS_PDA)
    : (tokenomicsFromCfg ? new PublicKey(tokenomicsFromCfg) : deriveTokenomicsPda(programId, configPda));

  const tokInfo = await mustGetAccountInfo(connection, tokenomicsPda, "Tokenomics PDA");
  const tokName = findAccountNameInIdl(idl, "tokenomics") || "Tokenomics";
  const tok = coder.accounts.decode(tokName, tokInfo.data);

  const rewardFeePoolPda = new PublicKey(tok.rewardFeePool ?? tok.reward_fee_pool);
  const replicationPoolPda = new PublicKey(tok.replicationPool ?? tok.replication_pool);

  const roundPda = deriveRoundPda(programId, roundId);
  const roundInfo = await mustGetAccountInfo(connection, roundPda, "Round PDA");
  const roundName = findAccountNameInIdl(idl, "round") || "RoundState";
  const round = coder.accounts.decode(roundName, roundInfo.data);
  const committedCount = bnToNumber(round.committedCount ?? round.committed_count ?? 0);

  if (committedCount === 0) {
    console.log(`[settle] Round ${roundId}: zero committed tickets. Skipping.`);
    return false;
  }

  const timlgVaultPda = new PublicKey(round.timlgVault ?? round.timlg_vault);

  // Skip deep diagnostics logs to save screen space in optimized mode
  // ...

  // Ticket discovery
  let tickets = [];
  // if passed via env TICKETS (legacy support)
  if (process.env.TICKETS) tickets = parseCsvPubkeys(process.env.TICKETS);

  if (!tickets.length) {
    // Auto discover
    tickets = await discoverTicketsForRound(connection, programId, coder, idl, roundId);
  }

  if (!tickets.length) {
    console.log(`[settle] Round ${roundId}: No eligible tickets. Skipping.`);
    return false; // Did nothing
  }

  console.log(`[settle] Round ${roundId}: Settling ${tickets.length} tickets...`);

  // Build instruction
  const ix = pickIx(idl, "settle_round_tokens");
  const jsName = camelize(ix.name);

  // Build args
  const args = (ix.args || []).map(a => a.name);
  const callArgs = [];
  // ... (same logic)
  if (args.length === 1) { callArgs.push(new anchor.BN(roundId)); }
  else if (args.length === 2) {
    callArgs.push(new anchor.BN(roundId));
    callArgs.push(new anchor.BN(tickets.length));
  }

  const remainingAccounts = tickets.map((t) => ({
    pubkey: t, isSigner: false, isWritable: true
  }));

  const candidates = {
    config: configPda,
    tokenomics: tokenomicsPda,
    timlgMint,
    treasury,
    rewardFeePool: rewardFeePoolPda,
    replicationPool: replicationPoolPda,
    round: roundPda,
    timlgVault: timlgVaultPda,
    payer: admin.publicKey,
    admin: admin.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
  };
  const accounts = buildAccountsObjectFromIdl(ix, candidates);

  try {
    const tx = await program.methods[jsName](...callArgs)
      .accounts(accounts)
      .remainingAccounts(remainingAccounts)
      .signers([admin])
      .rpc({ commitment: "confirmed" });

    console.log(`[settle] ✅ Round ${roundId} tx: ${tx}`);
    return true;
  } catch (e) {
    // ⚠️ Anchor sometimes throws "Unknown action 'undefined'" when parsing
    // the tx response/event logs even if the instruction succeeded on-chain.
    // Verify the round's token_settled flag before propagating the error.
    if (e.message && e.message.includes("Unknown action")) {
      try {
        const recheckInfo = await connection.getAccountInfo(roundPda, "confirmed");
        if (recheckInfo) {
          const roundRechecked = coder.accounts.decode(roundName, recheckInfo.data);
          const isSettled = roundRechecked.tokenSettled ?? roundRechecked.token_settled ?? false;
          if (isSettled) {
            console.log(`[settle] ✅ Round ${roundId} confirmed settled on-chain (client-side parse error was a false positive).`);
            return true;
          }
        }
      } catch (_) { /* ignore recheck error, fall through to original throw */ }
    }
    console.error(`[settle] ❌ Round ${roundId} failed: ${e.message}`);
    throw e;
  }
}

// CLI Wrapper
if (require.main === module) {
  (async () => {
    const RPC_URL = envStr("RPC_URL", "https://api.devnet.solana.com");
    const programId = new PublicKey(mustEnv("PROGRAM_ID"));
    const admin = loadKeypair(envStr("ADMIN_KEYPAIR", "~/.config/solana/id.json"));
    const roundId = (process.argv[2] != null && process.argv[2] !== "") ? Number(process.argv[2]) : envInt("ROUND_ID", null);
    if (!Number.isFinite(roundId)) throw new Error("Missing roundId arg");

    const connection = new Connection(RPC_URL, "confirmed");
    await settleRound(connection, programId, admin, roundId);

  })().catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
  });
} else {
  module.exports = { settleRound };
}
