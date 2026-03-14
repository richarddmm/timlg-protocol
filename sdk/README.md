# TIMLG TypeScript SDK 🚀

The official TypeScript SDK for interacting with the **TIMLG Protocol** on Solana. This SDK abstracts the complexity of PDA derivations and cryptographic commitments, allowing you to focus on building.

## Installation

```bash
npm install @solana/web3.js @coral-xyz/anchor @noble/hashes bs58
```

*(Note: Currently in beta, available via direct file inclusion or local linking)*

## Quickstart

```typescript
import * as anchor from "@coral-xyz/anchor";
import { TimlgClient } from "./sdk/src/index.js";

// Initialize Provider
const provider = anchor.AnchorProvider.env();
const programId = new PublicKey("GeA3JqAjAWBCoW3JVDbdTjEoxfUaSgtHuxiAeGG5PrUP");
const program = new anchor.Program(idl as any, provider);

const client = new TimlgClient(program);

// Commit a guess (1 = Bull, 0 = Bear)
const roundId = 100;
const guess = 1;
const { signature, receipt } = await client.commit(roundId, guess, {
    timlgMint: TIMLG_MINT_PUBKEY,
    userTimlgAta: USER_ATA
});

console.log("Committed! Receipt:", receipt);

// Reveal later
const revealSig = await client.reveal(receipt);
```

## Features

- **Type-safe interaction** with TIMLG smart contracts.
- **Deterministic PDA derivation** for Rounds, Tickets, and Vaults.
- **Commit-Reveal logic** built-in with standard SHA256 hashing.
- **Full ESM compatibility**.

## License

MIT
