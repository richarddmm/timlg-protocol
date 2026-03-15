# TIMLG Protocol TypeScript SDK

Professional SDK for interacting with the TIMLG Protocol on Solana. Designed to be modular, secure, and easy to use for both players and infrastructure operators.

## Installation

```bash
npm install @timlg/sdk
```

## Quick Start & Examples

For complete, professional implementations, check our [examples/](https://github.com/richarddmm/timlg-protocol/tree/main/sdk/examples) directory:
- **`player_demo.ts`**: Complete game cycle (Commit -> Reveal -> Claim).
- **`operator_demo.ts`**: Automated round management for operators.

## Modular Architecture (Roles)

The SDK is divided into three primary tools depending on your protocol role:

### 1. TimlgPlayer (For Users & Game Bots)
Ideal for creating ticket managers or user-facing applications.
```typescript
import { TimlgClient } from '@timlg/sdk';

// Initialize in one line!
const client = await TimlgClient.create(wallet, { cluster: 'devnet' });
const player = client.player;

// Commit a bet in a round
const { signature, receipt } = await player.commit(roundId, guess, {
  timlgMint,
  userTimlgAta
});

// Reveal the ticket (after commit window closes)
await player.reveal(receipt);

// Claim rewards for winning tickets
await player.claim(receipt, { timlgMint, userTimlgAta });

// Close ticket account (recover SOL rent)
await player.closeTicket(receipt);
```

### 2. TimlgSupervisor (For Round Operators)
Tools for maintaining the protocol's game flow.
```typescript
import { TimlgSupervisor } from '@timlg/sdk';

const supervisor = new TimlgSupervisor(program);

// Create a new round automatically
await supervisor.createRoundAuto();

// Finalize betting window
await supervisor.finalizeRound(roundId);

// Settle and distribute rewards
await supervisor.settleRoundTokens(roundId, { timlgMint });
```

### 3. TimlgAdmin (For Protocol Governance)
Full system control (requires administrative permissions).
```typescript
import { TimlgAdmin } from '@timlg/sdk';

const admin = new TimlgAdmin(program);

await admin.setPause(true); // Emergency pause
await admin.addOracle(newOracleKey); // Oracle management
```

## Common Queries
All tools include methods for reading protocol state:
```typescript
const round = await player.fetchRound(roundId);
const stats = await player.fetchUserStats(userPublicKey);
const config = await player.fetchConfig();
```

## Development
The code is designed to be compatible with ESM and NodeNext environments.
© 2026 TIMLG Protocol.
