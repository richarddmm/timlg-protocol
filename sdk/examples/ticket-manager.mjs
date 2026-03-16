#!/usr/bin/env node

/**
 * TIMLG Ticket Manager (Professional SDK Edition)
 * Groups logs by round to keep the terminal clean.
 */

import dotenv from "dotenv";
dotenv.config({ override: true });
import anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import { TimlgClient } from "../dist/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, "ticket_history.json");

// 🛠️ Configuration
const WALLET_PATH = process.env.USER_KEYPAIR_PATH || path.join(__dirname, "wallet.json");
const MINT_ADDR = process.env.TIMLG_MINT || "GeA3JqAjAWBCoW3JVDbdTjEoxfUaSgtHuxiAeGG5PrUP";
const TIMLG_MINT = new PublicKey(MINT_ADDR);

async function main() {
  const action = process.argv.find(a => a.startsWith("--action="))?.split("=")[1] || "stats";
  const intensity = process.argv.find(a => a.startsWith("--intensity="))?.split("=")[1] || "low";
  const daemonSeconds = process.argv.find(a => a.startsWith("--daemon="))?.split("=")[1];

  // 0. Reset stats if requested
  if (process.argv.includes("--reset-stats")) {
    if (fs.existsSync(HISTORY_FILE)) {
      fs.unlinkSync(HISTORY_FILE);
    }
    const secret = JSON.parse(fs.readFileSync(path.resolve(WALLET_PATH), "utf-8"));
    const wallet = Keypair.fromSecretKey(Uint8Array.from(secret));
    const client = await TimlgClient.create(wallet, { cluster: "devnet" });
    try {
      await client.player.closeStats();
      console.log("🧹 Protocol stats reset & Rent recovered");
    } catch (e) {
      console.log("ℹ️  No on-chain stats to reset or already reset.");
    }
    console.log("🧹 Local history cleared");
  }

  // 1. Initialize SDK
  const secret = JSON.parse(fs.readFileSync(path.resolve(WALLET_PATH), "utf-8"));
  const wallet = Keypair.fromSecretKey(Uint8Array.from(secret));

  const client = await TimlgClient.create(wallet, { cluster: "devnet" });
  const player = client.player;

  console.log(`Connected [${wallet.publicKey.toBase58().slice(0, 8)}...]`);

  const runActions = async () => {
    const actions = action.split(",");
    console.log(`\n-- ${new Date().toLocaleTimeString()} | Executing: ${actions.join(", ")} --`);
    
    for (const a of actions) {
      switch (a) {
        case "all":
          await handleCommit(player, intensity, wallet.publicKey);
          await handleReveal(player, wallet.publicKey);
          await handleClaim(player, wallet.publicKey);
          await handleRefund(player, wallet.publicKey);
          await handleClose(player, wallet.publicKey);
          await handleStats(player, wallet.publicKey);
          break;
        case "all-no-commit":
          await handleReveal(player, wallet.publicKey);
          await handleClaim(player, wallet.publicKey);
          await handleRefund(player, wallet.publicKey);
          await handleClose(player, wallet.publicKey);
          await handleStats(player, wallet.publicKey);
          break;
        case "commit":
          await handleCommit(player, intensity, wallet.publicKey);
          break;
        case "reveal":
          await handleReveal(player, wallet.publicKey);
          break;
        case "claim":
          await handleClaim(player, wallet.publicKey);
          break;
        case "close":
          await handleClose(player, wallet.publicKey);
          break;
        case "refund":
          await handleRefund(player, wallet.publicKey);
          break;
        case "stats":
          await handleStats(player, wallet.publicKey);
          break;
        default:
          console.log(`⚠️  Unknown action: ${a}`);
      }
    }
  };

  if (daemonSeconds) {
    const ms = parseInt(daemonSeconds) * 1000;
    console.log(`Running every ${daemonSeconds}s`);
    await runActions();
    setInterval(runActions, ms);
  } else {
    await runActions();
  }
}

function formatError(msg) {
  if (!msg) return "Unknown error";
  const match = msg.match(/Error Message: (.*)/);
  if (match) return match[1].trim();
  return msg;
}

async function handleCommit(player, intensity, user) {
  const roundData = await player.getLatestRound();
  if (!roundData) return;

  const roundId = roundData.account.roundId.toNumber();
  const history = loadHistory();
  const userAddr = user.toBase58();
  
  if (history.find(t => t.roundId === roundId && t.status === "pending" && t.user === userAddr)) {
    console.log(`Commit: (Already pending for Round ${roundId})`);
    return;
  }

  const count = intensity === "high" ? 5 : 1;
  const entries = Array.from({ length: count }, () => ({
    guess: Math.random() > 0.5 ? 1 : 0
  }));

  try {
    const { signature, receipts } = await player.commitBatch(roundId, entries, { timlgMint: TIMLG_MINT });
    console.log(`Commit:`);
    console.log(`  Round ${roundId} | ${receipts.length} ticket(s) OK`);
    saveToHistory(receipts, userAddr);
  } catch (e) {
    console.log(`Commit:`);
    console.log(`  Round ${roundId} | ⚠️  Failed (${formatError(e.message)})`);
  }
}

async function handleReveal(player, user) {
  const userAddr = user.toBase58();
  const history = loadHistory();
  const pending = history.filter(t => t.status === "pending" && t.user === userAddr);
  if (pending.length === 0) {
    console.log(`Reveal: (No pending tickets)`);
    return;
  }

  const rounds = [...new Set(pending.map(t => t.roundId))];
  let waitingRounds = 0;
  let hasActions = false;

  for (const rid of rounds) {
    const ticketsInRound = pending.filter(t => t.roundId === rid);
    
    // 1. Sync check
    let revealedOnChain = 0;
    for (const t of ticketsInRound) {
      try {
        const account = await player.fetchTicket(new PublicKey(t.ticketPda));
        if (account && account.revealed) {
          t.status = "revealed";
          revealedOnChain++;
        }
      } catch (_) {}
    }

    // 2. Filter out what was just synced
    const stillPending = ticketsInRound.filter(t => t.status === "pending");
    if (stillPending.length === 0) {
      if (revealedOnChain > 0) {
        if (!hasActions) { console.log("Reveal:"); hasActions = true; }
        console.log(`  Round ${rid}: Synced ${revealedOnChain} revealed ticket(s) from chain`);
      }
      continue;
    }

    try {
      const roundAcc = await player.fetchRound(parseInt(rid));
      if (!roundAcc.pulseSet) {
        waitingRounds++;
        continue;
      }
      if (roundAcc.finalized) {
        if (!hasActions) { console.log("Reveal:"); hasActions = true; }
        console.log(`  Round ${rid} | ℹ️  Round finalized (Expired)`);
        stillPending.forEach(t => t.status = "expired");
        continue;
      }

      await player.revealBatch(stillPending);
      if (!hasActions) { console.log("Reveal:"); hasActions = true; }
      console.log(`  Round ${rid} | ✅ ${stillPending.length} ticket(s) revealed`);
      stillPending.forEach(t => t.status = "revealed");
    } catch (e) {
      const msg = formatError(e.message);
      if (!hasActions) { console.log("Reveal:"); hasActions = true; }
      if (msg.includes("AccountNotInitialized") || msg.includes("already initialized")) {
        console.log(`  Round ${rid} | ℹ️  Round purged or closed`);
        stillPending.forEach(t => t.status = "expired");
      } else {
        console.log(`  Round ${rid} | ⚠️  Failed (${msg})`);
      }
    }
    updateHistory(history);
  }
  
  if (waitingRounds > 0) {
    if (hasActions) console.log(`  (Waiting for pulse in ${waitingRounds} rounds)`);
    else console.log(`Reveal: (Waiting for pulse in ${waitingRounds} rounds)`);
  } else if (!hasActions) {
    console.log(`Reveal: (No pending tickets)`);
  }
}

async function handleClaim(player, user) {
  const userAddr = user.toBase58();
  const history = loadHistory();
  const revealed = history.filter(t => t.status === "revealed" && t.user === userAddr);
  if (revealed.length === 0) {
    console.log(`Claim: (No revealed tickets to check)`);
    return;
  }

  const rounds = [...new Set(revealed.map(t => t.roundId))];
  let waitingFinalization = 0;
  let hasActions = false;
  
  for (const rid of rounds) {
    const ticketsInRound = revealed.filter(t => t.roundId === rid);
    let wins = 0;
    let isWaiting = false;

    for (const t of ticketsInRound) {
      try {
        await player.claim(t, { timlgMint: TIMLG_MINT });
        t.status = "claimed";
        wins++;
      } catch (e) {
          const msg = formatError(e.message);
          if (msg.includes("RoundNotFinalized") || msg.includes("settled")) {
            isWaiting = true;
            break;
          }
          if (msg.includes("NotWinner") || msg.includes("not a winner")) {
            t.status = "revealed-loss";
          } else if (msg.includes("AccountNotInitialized")) {
            t.status = "lost";
          }
      }
    }
    if (wins > 0) {
      if (!hasActions) { console.log("Claim:"); hasActions = true; }
      console.log(`  Round ${rid} | ${wins} prize(s) collected`);
    }
    if (isWaiting) waitingFinalization++;
    updateHistory(history);
  }
  
  if (waitingFinalization > 0) {
    if (hasActions) console.log(`  (Waiting for finalization in ${waitingFinalization} rounds)`);
    else console.log(`Claim: (Waiting for finalization in ${waitingFinalization} rounds)`);
  } else if (!hasActions) {
    console.log(`Claim: (No prizes to claim)`);
  }
}

async function handleRefund(player, user) {
  const userAddr = user.toBase58();
  const history = loadHistory();
  const pending = history.filter(t => t.status === "pending" && t.user === userAddr);
  if (pending.length === 0) {
    console.log(`Refund: (No pending tickets)`);
    return;
  }

  const rounds = [...new Set(pending.map(t => t.roundId))];
  let tooEarly = 0;
  let hasActions = false;

  for (const rid of rounds) {
    const ticketsInRound = pending.filter(t => t.roundId === rid);
    try {
        const sig = await player.refundTicket(parseInt(rid), {
          timlgMint: TIMLG_MINT,
          ticketPda: new PublicKey(ticketsInRound[0].ticketPda)
        });
        if (!hasActions) { console.log("Refund:"); hasActions = true; }
        console.log(`  Round ${rid} | ✅ ${ticketsInRound.length} ticket(s) OK`);
        ticketsInRound.forEach(t => t.status = "refunded");
    } catch (e) {
        const msg = formatError(e.message);
        if (msg.includes("RefundTooEarly")) {
          tooEarly++;
          continue;
        }
        if (msg.includes("AccountNotInitialized")) {
          if (!hasActions) { console.log("Refund:"); hasActions = true; }
          console.log(`  Round ${rid} | ℹ️  Account lost/purged`);
          ticketsInRound.forEach(t => t.status = "lost");
        }
    }
    updateHistory(history);
  }
  
  if (tooEarly > 0) {
    if (hasActions) console.log(`  (Waiting for refund window in ${tooEarly} rounds)`);
    else console.log(`Refund: (Waiting for refund window in ${tooEarly} rounds)`);
  } else if (!hasActions) {
    console.log(`Refund: (No tickets to refund)`);
  }
}

async function handleClose(player, user) {
  const userAddr = user.toBase58();
  const history = loadHistory();
  const closable = history.filter(t => ["claimed", "lost", "refunded", "expired", "revealed-loss"].includes(t.status) && t.user === userAddr);
  if (closable.length === 0) {
    console.log(`Recover: (No accounts to close)`);
    return;
  }

  const rounds = [...new Set(closable.map(t => t.roundId))];
  let hasActions = false;
  for (const rid of rounds) {
    const ticketsInRound = closable.filter(t => t.roundId === rid);
    let closed = 0;
    for (const t of ticketsInRound) {
      try {
        await player.closeTicket(t);
        t.status = "closed";
        closed++;
      } catch (e) {
        if (e.message.includes("AccountNotInitialized") || e.message.includes("already initialized")) {
            t.status = "closed";
            closed++;
        }
      }
    }
    if (closed > 0) {
      if (!hasActions) { console.log("Recover:"); hasActions = true; }
      console.log(`  Round ${rid} | Rent recovered (${closed} tickets)`);
    }
    updateHistory(history);
  }
  
  if (!hasActions) {
    console.log(`Recover: (No accounts to close)`);
  }
}

async function handleStats(player, user) {
  try {
    const { sol, tmlg } = await player.getBalances(user, TIMLG_MINT);
    console.log(`Balance: ${sol.toFixed(3)} SOL | ${tmlg} TMLG`);

    try {
      const globalStats = await player.fetchGlobalStats();
      console.log(`\n-- Protocol Global Stats --`);
      console.log(`[Tickets] Total: ${globalStats.totalTickets} | Reveals: ${globalStats.totalReveals} | Wins: ${globalStats.totalWins}`);
      console.log(`[Flow] Minted: ${globalStats.totalTimlgMinted} | Burned: ${globalStats.totalTimlgBurned} | Closed Rounds: ${globalStats.totalRoundsClosed}`);
      console.log(`[Fees] Total SOL Fees: ${(globalStats.totalSolFees.toNumber() / 1e9).toFixed(6)} SOL`);
    } catch (e) {
      // console.log(e);
      console.log("\n-- Global Stats not yet initialized --");
    }

    let stats;
    try {
      stats = await player.fetchUserStats(user);
    } catch (e) {
      // Account doesn't exist (reset or never played)
      console.log(`\n-- Status [Streak: 0 | Record: 0] --`);
      console.log(`[Commits] Total: 0 | Pending: 0 | Revealed: 0 | Refunded: 0 | Expired: 0`);
      console.log(`[Results] Won: 0 (Claimed: 0 | Unclaimed: 0 | Swept: 0) | Lost: 0`);
      return;
    }

    const userAddr = user.toBase58();
    const localPending = loadHistory().filter(t => t.status === "pending" && t.user === userAddr).length;
    const revealed = stats.ticketsRevealed ? stats.ticketsRevealed.toNumber() : 0;
    const refunded = stats.ticketsRefunded ? stats.ticketsRefunded.toNumber() : 0;
    const swept = stats.ticketsSwept ? stats.ticketsSwept.toNumber() : 0;
    const claimed = stats.ticketsClaimed ? stats.ticketsClaimed.toNumber() : 0;
    const won = stats.gamesWon ? stats.gamesWon.toNumber() : 0;
    
    // Unclaimed = Won - Claimed - Swept
    const unclaimed = Math.max(0, won - claimed - swept);
    
    // Total unresolved = Played - Revealed - Refunded
    const unresolved = Math.max(0, stats.gamesPlayed.toNumber() - revealed - refunded);
    
    // We only show as "Pending" what the blockchain confirms is unresolved
    const pending = Math.min(localPending, unresolved);
    const expired = unresolved - pending;

    console.log(`\n-- Status [Streak: ${stats.currentStreak} | Record: ${stats.longestStreak}] --`);
    console.log(`[Commits] Total: ${stats.gamesPlayed} | Pending: ${pending} | Revealed: ${revealed} | Refunded: ${refunded} | Expired: ${expired}`);
    console.log(`[Results] Won: ${won} (Claimed: ${claimed} | Unclaimed: ${unclaimed} | Swept: ${swept}) | Lost: ${stats.gamesLost}`);
  } catch (e) {
    console.log("⚠️  Could not fetch stats/balances.");
  }
}

function loadHistory() { return fs.existsSync(HISTORY_FILE) ? JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8")) : []; }
function updateHistory(h) { fs.writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2)); }
function saveToHistory(r, user) { updateHistory([...loadHistory(), ...r.map(x => ({ ...x, status: "pending", user }))]); }

/*
Usage: 
node index.mjs --action=commit,reveal,stats
node index.mjs --action=all --daemon=60
*/
main().catch(console.error);
