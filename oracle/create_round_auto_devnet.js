#!/usr/bin/env node
"use strict";

/**
 * oracle/create_round_auto_devnet.js
 *
 * Create round using RoundRegistry (auto round_id).
 *
 * Fixes:
 * - RoundRegistry PDA derivation MUST match init script: ["round_registry", configPda]
 * - Avoid Program().account (can crash with "reading 'size'") by manually encoding ix.
 * - IMPORTANT: Flatten nested IDL accounts (Anchor often nests account groups).
 * - IMPORTANT: Support both (isMut/isSigner) and (writable/signer) IDL meta fields.
 *
 * Env:
 *   RPC_URL               (default https://api.devnet.solana.com)
 *   PROGRAM_ID            (required)
 *   ADMIN_KEYPAIR         (default ~/.config/solana/id.json)
 *   TIMLG_MINT            (optional; must match Config.timlg_mint)
 *   COMMIT_WINDOW_SLOTS   (default 120)
 *   REVEAL_WINDOW_SLOTS   (default 120)
 *   NIST_CHAIN_INDEX      (default 2)
 *   NIST_PULSE_OFFSET     (default 2)
 *   DEBUG_ACCOUNTS        (default 0) -> if 1, prints account metas before sending
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const https = require("https");

const anchor = require("@coral-xyz/anchor");
const {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  Connection,
  sendAndConfirmTransaction,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} = anchor.web3;
const { setupDualConnection, withRpcStrategy } = require("./operator/lib_operator");

function die(msg) {
  console.error("ERROR:", msg);
  process.exit(1);
}

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}

function expandHome(p) {
  if (!p) return p;
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

function loadKeypair(fp) {
  fp = expandHome(fp);
  const secret = Uint8Array.from(readJson(fp));
  return anchor.web3.Keypair.fromSecretKey(secret);
}

function loadIdl() {
  const candidates = [
    path.resolve(process.cwd(), "oracle/timlg_protocol.json"),
    path.resolve(process.cwd(), "target/idl/timlg_protocol.json"),
    path.resolve(__dirname, "../target/idl/timlg_protocol.json"),
    path.resolve(process.cwd(), "idl/timlg_protocol.json"),
  ];
  for (const fp of candidates) {
    if (fs.existsSync(fp)) return readJson(fp);
  }
  die(`Could not find timlg_protocol IDL. Tried:\n- ${candidates.join("\n- ")}`);
}

function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/[_-]/g, "");
}

function findIx(idl, want) {
  const wantN = normalizeName(want);
  for (const ix of idl.instructions || []) {
    if (normalizeName(ix.name) === wantN) return ix;
  }
  for (const ix of idl.instructions || []) {
    const n = normalizeName(ix.name);
    if (n.includes("create") && n.includes("round") && n.includes("auto")) return ix;
  }
  return null;
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON from ${url}: ${e.message}`));
          }
        });
      })
      .on("error", reject);
  });
}

async function getNistLastPulseIndex(chain) {
  const url = `https://beacon.nist.gov/beacon/2.0/chain/${chain}/pulse/last`;
  const j = await httpGetJson(url);
  const pulseIndex = j?.pulse?.pulseIndex;
  if (pulseIndex == null) die(`Cannot parse pulseIndex from NIST response (${url})`);
  return Number(pulseIndex);
}

function pickAccountName(idl, predicateFn, fallback) {
  const acc = (idl.accounts || []).find((a) => predicateFn(normalizeName(a.name)));
  return acc?.name || fallback;
}

function getField(obj, names) {
  for (const n of names) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, n)) return obj[n];
  }
  return undefined;
}

function u64ToBn(x) {
  if (anchor.BN.isBN(x)) return x;
  if (typeof x === "string" && /^\d+$/.test(x)) return new anchor.BN(x, 10);
  if (typeof x === "number" && Number.isFinite(x)) return new anchor.BN(String(x), 10);
  die(`Cannot convert to BN: ${x}`);
}

function flattenIdlAccounts(accounts, out = []) {
  for (const a of accounts || []) {
    if (a && Array.isArray(a.accounts)) {
      flattenIdlAccounts(a.accounts, out);
    } else {
      out.push(a);
    }
  }
  return out;
}

function getIsWritable(acc) {
  // Support multiple IDL shapes
  if (typeof acc?.isMut === "boolean") return acc.isMut;
  if (typeof acc?.writable === "boolean") return acc.writable;
  if (typeof acc?.isWritable === "boolean") return acc.isWritable;
  return false;
}

function getIsSigner(acc) {
  if (typeof acc?.isSigner === "boolean") return acc.isSigner;
  if (typeof acc?.signer === "boolean") return acc.signer;
  return false;
}

function buildResolver() {
  const map = new Map();
  const put = (name, pk) => map.set(normalizeName(name), pk);
  const get = (name) => map.get(normalizeName(name));
  return { put, get, map };
}

async function main() {
  const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
  const PROGRAM_ID = process.env.PROGRAM_ID;
  const ADMIN_KEYPAIR = process.env.ADMIN_KEYPAIR || "~/.config/solana/id.json";

  const COMMIT_WINDOW_SLOTS = Number(process.env.COMMIT_WINDOW_SLOTS || "120");
  const REVEAL_WINDOW_SLOTS = Number(process.env.REVEAL_WINDOW_SLOTS || "120");
  const NIST_CHAIN_INDEX = Number(process.env.NIST_CHAIN_INDEX || "2");
  const NIST_PULSE_OFFSET = Number(process.env.NIST_PULSE_OFFSET || "2");

  const TIMLG_MINT_ENV = process.env.TIMLG_MINT; // optional override (must match config)

  const DEBUG_ACCOUNTS = String(process.env.DEBUG_ACCOUNTS || "0") === "1";

  if (!PROGRAM_ID) die("Missing env PROGRAM_ID");

  const programId = new PublicKey(PROGRAM_ID);
  const admin = loadKeypair(ADMIN_KEYPAIR);

  // ✅ Dual RPC
  const rpcCtx = setupDualConnection();
  const { primary: connection } = rpcCtx; // For base reference, but we use strategy for calls

  const idl = loadIdl();

  const ix = findIx(idl, "create_round_auto");
  if (!ix) die("IDL does not contain create_round_auto / createRoundAuto");

  // ---- PDAs ----
  const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config_v3")], programId);

  // ---- Decode Config to resolve timlg_mint (avoid stale hardcoded mint) ----
  const cfgInfo = await withRpcStrategy(c => c.getAccountInfo(configPda, "confirmed"), rpcCtx);
  if (!cfgInfo) die(`Config missing on-chain at ${configPda.toBase58()} (run init_config_devnet.js first)`);

  const accountsCoderCfg = new anchor.BorshAccountsCoder(idl);
  const cfgName = pickAccountName(
    idl,
    (n) => n === "config",
    "Config"
  );

  let cfg;
  try {
    cfg = accountsCoderCfg.decode(cfgName, cfgInfo.data);
  } catch (e) {
    die(`Failed to decode ${cfgName} at ${configPda.toBase58()}: ${e.message}`);
  }

  const cfgTIMLGMint = getField(cfg, ["timlgMint", "timlg_mint"]);
  if (!cfgTIMLGMint) die("Decoded Config has no timlgMint/timlg_mint field");

  const timlgMintFromConfig =
    cfgTIMLGMint instanceof PublicKey ? cfgTIMLGMint : new PublicKey(cfgTIMLGMint);

  if (TIMLG_MINT_ENV) {
    const envMint = new PublicKey(TIMLG_MINT_ENV);
    if (!envMint.equals(timlgMintFromConfig)) {
      die(
        `TIMLG_MINT mismatch: env=${envMint.toBase58()} but config=${timlgMintFromConfig.toBase58()}. ` +
        `Unset TIMLG_MINT or set it to the config mint.`
      );
    }
  }

  const [roundRegistryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("round_registry_v3"), configPda.toBuffer()],
    programId
  );

  const rrInfo = await withRpcStrategy(c => c.getAccountInfo(roundRegistryPda, "confirmed"), rpcCtx);
  if (!rrInfo) {
    die(`RoundRegistry missing on-chain at ${roundRegistryPda.toBase58()} (run init_round_registry first)`);
  }

  // Decode RoundRegistry
  const accountsCoder = new anchor.BorshAccountsCoder(idl);
  const rrName = pickAccountName(
    idl,
    (n) => n === "roundregistry" || (n.includes("round") && n.includes("registry")),
    "RoundRegistry"
  );

  let rr;
  try {
    rr = accountsCoder.decode(rrName, rrInfo.data);
  } catch (e) {
    die(`Failed to decode ${rrName} at ${roundRegistryPda.toBase58()}: ${e.message}`);
  }

  const nextRoundId =
    getField(rr, ["nextRoundId", "next_round_id"]) ??
    die(`RoundRegistry decoded but missing next_round_id / nextRoundId field`);

  const roundIdBn = u64ToBn(nextRoundId);
  const roundIdNum = Number(roundIdBn.toString(10));

  // NIST target pulse
  //
  // IMPORTANT:
  // - In ROUND_SCHEDULER_MODE=nist we want *sequential* pulse targets (no skipping).
  // - The scheduler can pass an override via env to force a specific target.
  //   (PULSE_INDEX_TARGET_OVERRIDE is set by ensure_commit_round_devnet.js in nist mode.)
  const override = process.env.PULSE_INDEX_TARGET_OVERRIDE;
  let pulseIndexTarget;
  if (override != null && override !== '') {
    const n = Number(override);
    if (!Number.isFinite(n) || n <= 0) die(`Invalid PULSE_INDEX_TARGET_OVERRIDE: ${override}`);
    pulseIndexTarget = n;
  } else {
    const lastPulse = await getNistLastPulseIndex(NIST_CHAIN_INDEX);
    pulseIndexTarget = lastPulse + NIST_PULSE_OFFSET;
  }

  // per-round PDAs
  const roundLe = roundIdBn.toArrayLike(Buffer, "le", 8);
  const [roundPda] = PublicKey.findProgramAddressSync([Buffer.from("round_v3"), roundLe], programId);
  const [vaultPda] = PublicKey.findProgramAddressSync([Buffer.from("vault_v3"), roundLe], programId);
  const [timlgVaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("timlg_vault_v3"), roundLe],
    programId
  );

  // ---- Build args dynamically from IDL arg names ----
  const args = {};
  const currentSlotBefore = await withRpcStrategy(c => c.getSlot("confirmed"), rpcCtx);
  const commitDeadline = currentSlotBefore + COMMIT_WINDOW_SLOTS;
  const revealDeadline = commitDeadline + REVEAL_WINDOW_SLOTS;

  for (const a of ix.args || []) {
    const n = normalizeName(a.name);

    if (n.includes("commit") && n.includes("window")) {
      args[a.name] = new anchor.BN(COMMIT_WINDOW_SLOTS);
      continue;
    }
    if (n.includes("reveal") && n.includes("window")) {
      args[a.name] = new anchor.BN(REVEAL_WINDOW_SLOTS);
      continue;
    }

    if (n.includes("commit") && n.includes("deadline")) {
      args[a.name] = new anchor.BN(commitDeadline);
      continue;
    }
    if (n.includes("reveal") && n.includes("deadline")) {
      args[a.name] = new anchor.BN(revealDeadline);
      continue;
    }

    if (n.includes("pulse") && n.includes("index")) {
      args[a.name] = new anchor.BN(pulseIndexTarget);
      continue;
    }

    if (n === "roundid" || (n.includes("round") && n.includes("id"))) {
      args[a.name] = roundIdBn;
      continue;
    }

    die(`Don't know how to fill arg "${a.name}" for instruction ${ix.name}. Add mapping.`);
  }

  // ---- Accounts resolver ----
  const timlgMintPk = timlgMintFromConfig;
  const r = buildResolver();

  // signers/payers
  r.put("admin", admin.publicKey);
  r.put("authority", admin.publicKey);
  r.put("payer", admin.publicKey);
  r.put("funder", admin.publicKey);
  r.put("relayer", admin.publicKey);

  // PDAs
  r.put("config", configPda);
  r.put("configpda", configPda);

  r.put("roundregistry", roundRegistryPda);
  r.put("round_registry", roundRegistryPda);

  r.put("round", roundPda);
  r.put("roundpda", roundPda);

  r.put("vault", vaultPda);
  r.put("vaultpda", vaultPda);

  r.put("timlgvault", timlgVaultPda);
  r.put("timlg_vault", timlgVaultPda);
  r.put("timlgvaultpda", timlgVaultPda);

  r.put("timlgmint", timlgMintPk);
  r.put("timlg_mint", timlgMintPk);

  // programs/sysvars
  r.put("systemprogram", SystemProgram.programId);
  r.put("system_program", SystemProgram.programId);

  r.put("tokenprogram", anchor.utils.token.TOKEN_PROGRAM_ID);
  r.put("token_program", anchor.utils.token.TOKEN_PROGRAM_ID);

  r.put("associatedtokenprogram", anchor.utils.token.ASSOCIATED_PROGRAM_ID);
  r.put("associated_token_program", anchor.utils.token.ASSOCIATED_PROGRAM_ID);

  r.put("rent", SYSVAR_RENT_PUBKEY);
  r.put("clock", SYSVAR_CLOCK_PUBKEY);
  r.put("instructions", SYSVAR_INSTRUCTIONS_PUBKEY);

  // ---- Build key metas in correct order (flatten!) ----
  const flatAccounts = flattenIdlAccounts(ix.accounts || []);
  const metas = flatAccounts.map((acc) => {
    if (!acc?.name) die(`IDL account entry missing name for ix ${ix.name}`);
    const pk = r.get(acc.name);
    if (!pk) {
      die(
        `Missing account mapping for "${acc.name}" (normalize="${normalizeName(acc.name)}"). ` +
        `Add r.put("${acc.name}", <pubkey>)`
      );
    }
    return {
      name: acc.name,
      pubkey: pk,
      isSigner: getIsSigner(acc),
      isWritable: getIsWritable(acc),
    };
  });

  if (DEBUG_ACCOUNTS) {
    console.log("== DEBUG_ACCOUNTS ==");
    console.log("ix.name:", ix.name);
    metas.forEach((m, i) => {
      console.log(
        `[${String(i).padStart(2, "0")}] ${m.name}  ${m.pubkey.toBase58()}  signer=${m.isSigner} writable=${m.isWritable}`
      );
    });
    console.log("== /DEBUG_ACCOUNTS ==");
  }

  const keys = metas.map((m) => ({
    pubkey: m.pubkey,
    isSigner: m.isSigner,
    isWritable: m.isWritable,
  }));

  // ---- Encode instruction ----
  const ixCoder = new anchor.BorshInstructionCoder(idl);
  const data = ixCoder.encode(ix.name, args);

  const txIx = new TransactionInstruction({
    programId,
    keys,
    data,
  });

  const tx = new Transaction().add(txIx);
  tx.feePayer = admin.publicKey;

  let sig;
  try {
    sig = await withRpcStrategy(c => sendAndConfirmTransaction(c, tx, [admin], { commitment: "confirmed" }), rpcCtx);
  } catch (e) {
    // Print logs when possible (SendTransactionError)
    const logs = e?.logs || e?.transactionLogs || e?.transactionMessage || null;
    if (logs) {
      console.error("ERROR:", e.message || String(e));
      console.error("Logs:", Array.isArray(logs) ? logs : String(logs));
    }
    throw e;
  }

  // Optional decode round
  const roundInfo = await withRpcStrategy(c => c.getAccountInfo(roundPda, "confirmed"), rpcCtx);
  let decodedRound = null;
  if (roundInfo) {
    const roundAccName = pickAccountName(
      idl,
      (n) => n === "round" || (n.includes("round") && !n.includes("registry")),
      "Round"
    );
    try {
      decodedRound = accountsCoder.decode(roundAccName, roundInfo.data);
    } catch (_) { }
  }

  console.log("RPC:", RPC_URL);
  console.log("Program:", programId.toBase58());
  console.log("Admin:", admin.publicKey.toBase58());
  console.log("Config PDA:", configPda.toBase58());
  console.log("RoundRegistry PDA:", roundRegistryPda.toBase58());

  console.log("roundId:", roundIdNum);
  console.log("pulse_index_target:", pulseIndexTarget);

  if (decodedRound) {
    const cd = getField(decodedRound, ["commitDeadlineSlot", "commit_deadline_slot"]);
    const rd = getField(decodedRound, ["revealDeadlineSlot", "reveal_deadline_slot"]);
    if (cd != null) console.log("commit_deadline_slot:", cd.toString());
    if (rd != null) console.log("reveal_deadline_slot:", rd.toString());
  } else {
    console.log("commit_deadline_slot:", String(commitDeadline));
    console.log("reveal_deadline_slot:", String(revealDeadline));
  }

  console.log("roundPda:", roundPda.toBase58());
  console.log("vaultPda:", vaultPda.toBase58());
  console.log("timlgVaultPda:", timlgVaultPda.toBase58());
  console.log("✅ create_round_auto tx:", sig);
}

main().catch((e) => {
  // Final guard
  die(e?.stack || e?.message || String(e));
});
