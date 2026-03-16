#!/usr/bin/env node
/**
 * TIMLG Oracle Operator CLI
 *
 * This tool is for authorized oracle nodes registered on-chain via set_oracle_pubkey.
 * It watches for rounds that need a NIST pulse and signs them using your oracle keypair.
 *
 * Usage:
 *   node index.mjs --action=watch           # Continuous daemon mode
 *   node index.mjs --action=status          # Show current round state
 *   node index.mjs --action=pulse --round=12345  # Manually trigger pulse for a specific round
 *
 * Environment: Configure via .env (copy .env.example → .env)
 */

import dotenv from 'dotenv';
import { createRequire } from 'module';
// Always resolve .env from the operator/ directory, regardless of working directory
dotenv.config({ path: new URL('.env', import.meta.url).pathname });
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Keypair, clusterApiUrl } from '@solana/web3.js';
import { Wallet } from '@coral-xyz/anchor';
import { TimlgClient, fetchNistPulse } from '../dist/index.js'; // Adjust path if running from public_export/sdk/examples/

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Configuration ────────────────────────────────────────────────────────────

const RPC_URL          = process.env.RPC_URL          || clusterApiUrl('devnet');
const NIST_CHAIN_INDEX = parseInt(process.env.NIST_CHAIN_INDEX || '2', 10);
const OPERATOR_TICK_SEC = parseInt(process.env.OPERATOR_TICK_SEC || '15', 10);
const OPERATOR_LOOKBACK = parseInt(process.env.OPERATOR_LOOKBACK || '30', 10);

// ─── Key Loading ──────────────────────────────────────────────────────────────

function loadKeypairFromPath(envVar, fallback) {
  const raw = process.env[envVar] || fallback;
  if (!raw) {
    console.error(`❌  ${envVar} not set and no fallback provided.`);
    process.exit(1);
  }
  const resolved = raw.replace(/^~/, process.env.HOME || '');
  if (!fs.existsSync(resolved)) {
    console.error(`❌  Keypair file not found: ${resolved}`);
    console.error(`    Set ${envVar} in your .env file.`);
    process.exit(1);
  }
  try {
    const raw_key = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    return Keypair.fromSecretKey(Uint8Array.from(raw_key));
  } catch (e) {
    console.error(`❌  Failed to parse keypair at ${resolved}: ${e.message}`);
    process.exit(1);
  }
}

// NIST Beacon Integration is now handled within the SDK.

// ─── Argument Parsing ─────────────────────────────────────────────────────────

function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--')) {
      const [key, val] = arg.slice(2).split('=');
      args[key] = val ?? true;
    }
  }
  return args;
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function tag(label) { return `[${new Date().toISOString()}] [${label.padEnd(12)}]`; }
const log   = (label, msg) => console.log(`${tag(label)} ${msg}`);
const warn  = (label, msg) => console.warn(`${tag(label)} ⚠️  ${msg}`);
const error = (label, msg) => console.error(`${tag(label)} ❌  ${msg}`);

// ─── Core: Handle Pulses ──────────────────────────────────────────────────────

async function handlePulses(supervisor, oracleKeypair, relayerKeypair) {
  let rounds;
  try {
    rounds = await supervisor.getRoundsNeedingPulse(OPERATOR_LOOKBACK);
  } catch (e) {
    error('pulses', `Failed to fetch rounds: ${e.message}`);
    return;
  }

  if (rounds.length === 0) {
    return; // Nothing to do this tick
  }

  log('pulses', `Found ${rounds.length} round(s) needing a pulse.`);

  for (const round of rounds) {
    const { roundId, pulseIndexTarget } = round;

    // 1. Try to fetch the NIST pulse
    let pulse;
    try {
      pulse = await fetchNistPulse(NIST_CHAIN_INDEX, pulseIndexTarget);
    } catch (e) {
      warn('pulses', `Round #${roundId}: NIST fetch error — ${e.message}`);
      continue;
    }

    if (!pulse) {
      log('pulses', `⏳ Round #${roundId} waiting: NIST pulse #${pulseIndexTarget} not ready yet.`);
      continue;
    }

    // 2. Sign and submit
    log('pulses', `Setting pulse for Round #${roundId} (NIST target: ${pulseIndexTarget})...`);
    try {
      const sig = await supervisor.setPulseSigned(
        roundId,
        pulseIndexTarget,
        pulse,
        oracleKeypair,
        relayerKeypair
      );
      log('pulses', `✅ Round #${roundId} Pulse Set: ${sig}`);
    } catch (e) {
      const msg = e?.message || String(e);
      if (msg.includes('PulseAlreadySet') || msg.includes('0x1773')) {
        log('pulses', `Round #${roundId}: Pulse already set (skipping).`);
      } else if (msg.includes('PulseTooLate') || msg.includes('0x1774')) {
        warn('pulses', `Round #${roundId}: Pulse too late — round passed the safety buffer.`);
      } else {
        error('pulses', `Round #${roundId}: Failed to set pulse — ${msg}`);
      }
    }
  }
}

// ─── Core: Status Display ────────────────────────────────────────────────────

async function handleStatus(supervisor) {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║          TIMLG Oracle Operator — Round Status            ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  let rounds;
  try {
    rounds = await supervisor.getRoundsNeedingPulse(OPERATOR_LOOKBACK);
  } catch (e) {
    error('status', `Failed to fetch rounds: ${e.message}`);
    return;
  }

  const slot = await supervisor.getSlot();

  console.log(`  Current Slot   : ${slot}`);
  console.log(`  RPC Endpoint   : ${RPC_URL}`);
  console.log(`  NIST Chain     : ${NIST_CHAIN_INDEX}`);
  console.log(`  Rounds Pending : ${rounds.length}\n`);

  if (rounds.length === 0) {
    console.log('  ✅ No rounds currently need a pulse.\n');
    return;
  }

  console.log('  ┌────────────┬──────────────┬───────────┬────────────────────┐');
  console.log('  │  Round ID  │ NIST Target  │  Tickets  │  Reveal Deadline   │');
  console.log('  ├────────────┼──────────────┼───────────┼────────────────────┤');

  for (const r of rounds) {
    const slotsLeft = r.revealDeadlineSlot - slot;
    const secLeft   = Math.max(0, Math.round(slotsLeft * 0.4)); // ~400ms/slot
    const deadline  = `slot ${r.revealDeadlineSlot} (~${secLeft}s)`;
    console.log(
      `  │ ${String(r.roundId).padEnd(10)} │ ${String(r.pulseIndexTarget).padEnd(12)} │ ` +
      `${String(r.committedCount).padEnd(9)} │ ${deadline.padEnd(18)} │`
    );
  }
  console.log('  └────────────┴──────────────┴───────────┴────────────────────┘\n');

  // Check which NIST pulses are available
  console.log('  Checking NIST availability...\n');
  for (const r of rounds) {
    const pulse = await fetchNistPulse(NIST_CHAIN_INDEX, r.pulseIndexTarget).catch(() => null);
    const available = pulse ? '✅ Ready' : '⏳ Not yet published';
    console.log(`  Round #${r.roundId} → NIST #${r.pulseIndexTarget}: ${available}`);
  }
  console.log('');
}

// ─── Core: Manual Pulse for Specific Round ────────────────────────────────────

async function handleManualPulse(supervisor, oracleKeypair, relayerKeypair, roundId) {
  log('pulse', `Fetching state for Round #${roundId}...`);

  let round;
  try {
    round = await supervisor.fetchRound(roundId);
  } catch (e) {
    error('pulse', `Round #${roundId} not found or could not be fetched: ${e.message}`);
    return;
  }

  const target = round.pulseIndexTarget?.toNumber?.() ?? round.pulseIndexTarget;
  log('pulse', `Round #${roundId}: NIST target = ${target}`);

  if (round.pulseSet) {
    log('pulse', `Round #${roundId}: Pulse already set on-chain. Nothing to do.`);
    return;
  }

  log('pulse', `Fetching NIST pulse #${target} from chain ${NIST_CHAIN_INDEX}...`);
  const pulse = await fetchNistPulse(NIST_CHAIN_INDEX, target);
  if (!pulse) {
    warn('pulse', `NIST pulse #${target} is not yet published. Try again later.`);
    return;
  }

  log('pulse', `Setting pulse for Round #${roundId}...`);
  try {
    const sig = await supervisor.setPulseSigned(roundId, target, pulse, oracleKeypair, relayerKeypair);
    log('pulse', `✅ Round #${roundId} Pulse Set: ${sig}`);
  } catch (e) {
    error('pulse', `Failed: ${e.message}`);
  }
}

// ─── Watch Mode (Daemon) ──────────────────────────────────────────────────────

async function runWatch(supervisor, oracleKeypair, relayerKeypair) {
  log('operator', `Pulse watch started. Tick: every ${OPERATOR_TICK_SEC}s | Lookback: ${OPERATOR_LOOKBACK} rounds`);
  log('operator', `Oracle pubkey: ${oracleKeypair.publicKey.toBase58()}`);
  log('operator', `NIST chain: ${NIST_CHAIN_INDEX}`);
  console.log('');

  // Run immediately, then on interval
  await handlePulses(supervisor, oracleKeypair, relayerKeypair);

  const interval = setInterval(async () => {
    try {
      await handlePulses(supervisor, oracleKeypair, relayerKeypair);
    } catch (e) {
      error('operator', `Unhandled tick error: ${e.message}`);
    }
  }, OPERATOR_TICK_SEC * 1000);

  // Graceful shutdown
  const shutdown = () => {
    log('operator', 'Shutting down gracefully...');
    clearInterval(interval);
    process.exit(0);
  };
  process.on('SIGINT',  shutdown);
  process.on('SIGTERM', shutdown);
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const action = args.action || 'watch';

  // Print header
  console.log('');
  console.log('  ████████╗██╗███╗   ███╗██╗      ██████╗');
  console.log('  ╚══██╔══╝██║████╗ ████║██║     ██╔════╝');
  console.log('     ██║   ██║██╔████╔██║██║     ██║  ███╗');
  console.log('     ██║   ██║██║╚██╔╝██║██║     ██║   ██║');
  console.log('     ██║   ██║██║ ╚═╝ ██║███████╗╚██████╔╝');
  console.log('     ╚═╝   ╚═╝╚═╝     ╚═╝╚══════╝ ╚═════╝');
  console.log('  Oracle Node SDK v1.0.0');
  console.log('');

  // Load keypairs
  const oracleKeypair  = loadKeypairFromPath('ORACLE_KEYPAIR_PATH');
  const relayerKeypair = loadKeypairFromPath('RELAYER_KEYPAIR_PATH', process.env.ORACLE_KEYPAIR_PATH);

  // Detect cluster from RPC URL
  let cluster = 'devnet';
  if (RPC_URL.includes('mainnet')) cluster = 'mainnet-beta';
  else if (RPC_URL.includes('localhost') || RPC_URL.includes('127.0.0.1')) cluster = 'localnet';

  const client = await TimlgClient.create(relayerKeypair, { cluster, rpcUrl: RPC_URL });
  const supervisor = client.supervisor;

  switch (action) {
    case 'watch':
      await runWatch(supervisor, oracleKeypair, relayerKeypair);
      break;

    case 'status':
      await handleStatus(supervisor);
      break;

    case 'pulse': {
      const roundId = parseInt(args.round, 10);
      if (isNaN(roundId)) {
        error('cli', 'Missing or invalid --round=<id>. Example: --action=pulse --round=56423');
        process.exit(1);
      }
      await handleManualPulse(supervisor, oracleKeypair, relayerKeypair, roundId);
      break;
    }

    default:
      console.log('Usage:');
      console.log('  node index.mjs --action=watch              # Daemon mode');
      console.log('  node index.mjs --action=status             # Show pending rounds');
      console.log('  node index.mjs --action=pulse --round=N    # Manual pulse for round N');
      process.exit(0);
  }
}

main().catch(e => {
  error('operator', `Fatal: ${e.message || e}`);
  process.exit(1);
});
