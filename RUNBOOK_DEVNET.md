# Devnet Runbook (End-to-End)

This document provides a technical walkthrough for developers and grant reviewers to reproduce a full **TIMLG Protocol cycle** on Solana Devnet using the project's internal tooling.

---

## 1. Prerequisites

- **Solana CLI**: `solana 1.18.x` or higher.
- **Node.js**: `v18.x` or `v20.x`.
- **Anchor Framework**: `v0.29.0`.
- **Devnet SOL**: Minimal `1.0 SOL` in your local keypair.

---

## 2. Environment Setup

The oracle and automation scripts rely on a `.env` file in the root of the operator repository.

```bash
# RPC Configuration (HA Strategy)
RPC_URL="https://devnet.helius-rpc.com/?api-key=YOUR_API_KEY"
SECONDARY_RPC_URL="https://api.devnet.solana.com"
# Strategy: "PRIMARY", "SECONDARY", or "RACE" (High Availability)
RPC_MODE="RACE" 

# Protocol Identities
PROGRAM_ID="GeA3JqAjAWBCoW3JVDbdTjEoxfUaSgtHuxiAeGG5PrUP"
TIMLG_MINT="7kpdb6snovzpm5T5rU6BKJspX7qMUwaSVv9Ki5zqSHjy"

# Authority Keypairs
ADMIN_KEYPAIR="~/.config/solana/id.json"
ORACLE_KEYPAIR="~/.config/timlg/oracle/id.json"
RELAYER_KEYPAIR="~/.config/solana/id.json"

# Timing Parameters (Devnet Standards)
COMMIT_DURATION_SEC=420
REVEAL_WINDOW_SLOTS=1000
```

---

## 3. Full Protocol Cycle (Step-by-Step)

### Phase A: Initialization (Idempotent)
Standardizes the on-chain configuration for the Devnet experiment.

```bash
# Initialize global config and tokenomics
node oracle/init_config_devnet.js
node oracle/init_tokenomics_devnet.js
node oracle/init_round_registry_devnet_manual.js 0
```

### Phase B: Round Creation
Creates a new pipelined round anchored to a future NIST pulse.

```bash
# Create a round automatically based on current slot/NIST timing
node oracle/create_round_auto_devnet.js
```

### Phase C: User Participation (Commit)
Users submit their hashed predictions.

```bash
# Batch commit for testing
node oracle/commit_batch_signed_devnet_manual.js
```

### Phase D: Pulse Injection & The Wait
The oracle monitors the NIST Beacon. Once the target second passes, the oracle fetches the 512-bit pulse and injects it on-chain (verified via Ed25519).

```bash
# Injected by the supervisor automatically or manually:
node oracle/messenger_set_pulse_signed_devnet.js
```

### Phase E: Reveal & Settlement
Once the pulse is on-chain, users reveal their hashes. After the reveal window, anyone can trigger settlement.

```bash
# Reveal the batch
node oracle/reveal_batch_signed_devnet_manual.js

# Trigger settlement (burns losers, prepares winners)
node oracle/settle_round_tokens_auto_devnet.js
```

### Phase F: Finalization & Sweep
Closing the round and reclaiming unused resources.

```bash
# Finalize round state
node oracle/finalize_round_devnet_manual.js

# Sweep remaining values to treasury
node oracle/sweep_round_manual.js
```

---

## 4. Verification

Audit the round state at any time to verify integrity:

```bash
# Inspect the round state and ticket outcomes
node oracle/print_round_devnet.js --round [ROUND_ID]
node oracle/inspect_round_tickets.js --round [ROUND_ID]
```

---

## 5. Automated Supervisor
For continuous operation (24/7), the protocol runs a supervisor that pipelines all the above steps:

```bash
./oracle/run_operator_supervisor_devnet.sh
```
