# TIME LOG (TIMLG) Protocol

TIMLG is a **public, auditable experiment protocol** built on the Solana blockchain. It implements a slot-bounded **commit–reveal** mechanism against a publicly verifiable 512-bit randomness pulse.

[![Verifiable Build](https://img.shields.io/badge/Solana-Verifiable_Build-2e7d32?logo=solana)](https://explorer.solana.com/address/GeA3JqAjAWBCoW3JVDbdTjEoxfUaSgtHuxiAeGG5PrUP/verified-build?cluster=devnet)
[![Security Policy](https://img.shields.io/badge/Security-Included-1565c0)](https://explorer.solana.com/address/GeA3JqAjAWBCoW3JVDbdTjEoxfUaSgtHuxiAeGG5PrUP/security?cluster=devnet)
[![Devnet Active](https://img.shields.io/badge/Status-Devnet_Active-informational)](https://timlg.org)

## Overview

The protocol is designed to measure "predictability under strict anti-leakage constraints" (The Hawking Wall). It turns infrastructure behavior into a verifiable audit trail on-chain.

### Core Workflow
1. **Commit**: Users submit a private encrypted guess.
2. **Oracle Pulse**: A signed 512-bit randomness pulse is published after the commit window closes.
3. **Reveal**: Users decrypt their guess to prove its validity.
4. **Settle**: The program deterministically settles winners and handles tokenomics (Burn/Mint).

## Infrastructure

This repository includes a professional **Oracle Showcase** (located in the [/oracle](./oracle) directory) demonstrating the automated off-chain infrastructure:

- **Automated Settlement**: Scripts for finalized round settlement and token distribution.
- **Pulse Publisher**: Logic for NIST Randomness Beacon integration and on-chain pulse publishing.
- **Docker Ready**: Production-grade containerization for high-availability oracle operations.

## Key Links

- **Official Website**: [https://timlg.org](https://timlg.org)
- **Documentation Hub**: [https://timlg.org/protocol/overview/](https://timlg.org/protocol/overview/)
- **Beta App**: [https://timlg.org/beta/](https://timlg.org/beta/)
- **Technical Runbook**: [RUNBOOK_DEVNET.md](./RUNBOOK_DEVNET.md) (E2E Devnet Walkthrough)
- **On-chain Program**: [`GeA3...PrUP`](https://explorer.solana.com/address/GeA3JqAjAWBCoW3JVDbdTjEoxfUaSgtHuxiAeGG5PrUP?cluster=devnet)

## Security

Please see our [SECURITY.md](./SECURITY.md) for vulnerability reporting and disclosure guidelines.

---
*Note: This repository contains the reference implementation of the TIME LOG Protocol (MVP Stage).*
