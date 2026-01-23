# TIME LOG (TIMLG) Protocol

TIMLG is a **public, auditable experiment protocol** built on the Solana blockchain. It implements a slot-bounded **commit–reveal** mechanism against a publicly verifiable 512-bit randomness pulse.

[![Verifiable Build](https://img.shields.io/badge/Solana-Verifiable_Build-2e7d32?logo=solana)](https://explorer.solana.com/address/DrsJxZRNuEFHVyj3Sz5CzpVeacpAGHBoZrg9NtRH9JqR/verified-build?cluster=devnet)
[![Security Policy](https://img.shields.io/badge/Security-Included-1565c0)](https://explorer.solana.com/address/DrsJxZRNuEFHVyj3Sz5CzpVeacpAGHBoZrg9NtRH9JqR/security?cluster=devnet)
[![Devnet Active](https://img.shields.io/badge/Status-Devnet_Active-informational)](https://timlg.org)

## Overview

The protocol is designed to measure "predictability under strict anti-leakage constraints" (The Hawking Wall). It turns infrastructure behavior into a verifiable audit trail on-chain.

### Core Workflow
1. **Commit**: Users submit a private encrypted guess.
2. **Oracle Pulse**: A signed 512-bit randomness pulse is published after the commit window closes.
3. **Reveal**: Users decrypt their guess to prove its validity.
4. **Settle**: The program deterministically settles winners and handles tokenomics (Burn/Mint).

## Key Links

- **Official Website**: [https://timlg.org](https://timlg.org)
- **Documentation Hub**: [https://timlg.org/protocol/overview/](https://timlg.org/protocol/overview/)
- **Beta App**: [https://timlg.org/beta/](https://timlg.org/beta/)
- **On-chain Program**: [`DrsJx...JqR`](https://explorer.solana.com/address/DrsJxZRNuEFHVyj3Sz5CzpVeacpAGHBoZrg9NtRH9JqR?cluster=devnet)

## Security

Please see our [SECURITY.md](./SECURITY.md) for vulnerability reporting and disclosure guidelines.

---
*Note: This repository contains the reference implementation of the TIME LOG Protocol (MVP Stage).*
