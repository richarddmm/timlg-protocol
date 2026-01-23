# TIMLG Ticket Lifecycle & Protocol Specification

This document details all possible states of a ticket in the TIMLG protocol, from the initial user commitment to its final settlement on the Solana blockchain.

## Lifecycle Diagram

The following state machine represents the deterministic flow of every ticket:

```mermaid
flowchart TD
  Start((COMMIT<br/>Ticket Created))

  subgraph WAIT[WAIT PHASE]
    direction TB
    PENDING[PENDING<br/>Stake Escrowed - Waiting for Oracle Pulse]
  end

  subgraph REVEAL[REVEAL PHASE]
    direction TB
    REVEAL_NOW[REVEAL NOW<br/>Pulse Published - Reveal Window Open]
  end

  subgraph RESULT[SETTLEMENT PHASE]
    direction TB
    REVEALED[REVEALED<br/>Guess Submitted On-chain]
    WIN[WIN<br/>Correct Prediction]
    BURN_LOSS[LOSS<br/>Stake Collected/Burned]
    CLAIM_PRIZE[CLAIM PRIZE<br/>Rewards liquid after Settlement]
    CLAIMED[CLAIMED<br/>Stake Refunded + Reward]
    SWEPT[SWEPT<br/>Grace Period Expired<br/>Protocol Reclaims Funds]
    EXPIRED[EXPIRED<br/>Failure to Reveal - Stake Lost]
  end

  subgraph RECOVERY[RECOVERY PHASE]
    direction TB
    REFUND_AVAILABLE[REFUND AVAILABLE<br/>Oracle Failure / Timeout]
    REFUNDED[REFUNDED<br/>Stake Reclaimed by User]
  end

  End((END))

  Start --> PENDING

  PENDING -->|Oracle publishes pulse| REVEAL_NOW
  PENDING -->|Timeout - no pulse| REFUND_AVAILABLE

  REVEAL_NOW -->|User submits reveal| REVEALED
  REVEAL_NOW -->|Reveal window closes| EXPIRED

  REVEALED -->|Match| WIN
  REVEALED -->|No Match| BURN_LOSS

  WIN -->|Round Settled| CLAIM_PRIZE
  CLAIM_PRIZE -->|User signs claim| CLAIMED
  CLAIM_PRIZE -->|Grace period ends| SWEPT

  REFUND_AVAILABLE -->|User reclaims stake| REFUNDED

  BURN_LOSS --> End
  EXPIRED --> End
  CLAIMED --> End
  SWEPT --> End
  REFUNDED --> End

  classDef phase fill:#F6F1FF,stroke:#6B5BD2,stroke-width:1px,color:#111;
  classDef neutral fill:#FFFFFF,stroke:#8A8A8A,stroke-width:1px,color:#111;
  classDef good fill:#DFF7E6,stroke:#2E7D32,stroke-width:1px,color:#111;
  classDef warn fill:#FFF4CC,stroke:#B08900,stroke-width:1px,color:#111;
  classDef bad fill:#FFE1E1,stroke:#B3261E,stroke-width:1px,color:#111;

  class WAIT,REVEAL,RESULT,RECOVERY phase;
  class PENDING,REVEAL_NOW,REVEALED,CLAIM_PRIZE,REFUND_AVAILABLE,REFUNDED neutral;
  class WIN,CLAIMED good;
  class SWEPT warn;
  class BURN_LOSS,EXPIRED bad;
```

## State Explanations

1.  **PENDING**: The ticket is registered on-chain. The stake is held in the round vault while waiting for the public randomness pulse (e.g., NIST Beacon).
2.  **REVEAL NOW**: The pulse is available on-chain. Users must submit their original guess and salt to prove their commitment.
3.  **WIN**: The revealed guess matches the target bit of the pulse. Reward is pending round settlement.
4.  **LOSS**: The guess does not match. The protocol burns or collects the stake based on tokenomics configuration.
5.  **EXPIRED**: The user failed to reveal within the reveal window. The account risk is handled by the protocol.
6.  **SWEPT**: A winning prize was ready but the user failed to claim it within the configured grace period. The protocol authority executes a sweep to recover the funds.
7.  **REFUND AVAILABLE**: An emergency state triggered if the Oracle fails to provide the pulse within the expected slot window (+150 slots). Users can reclaim their stake.

## Implementation References

The automated logic for this protocol is implemented in the [/oracle](./oracle) directory:
- **Round Maintenance**: See `create_round_auto_devnet.js`.
- **Pulse Publishing**: See `run_oracle_devnet.js` and `nist.js`.
- **Settlement Engine**: See `settle_round_tokens_auto_devnet.js`.
