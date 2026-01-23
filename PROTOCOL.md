# TIMLG Ticket Lifecycle & Protocol Specification

This document details all possible states of a ticket in the TIMLG protocol, from the initial user commitment to its final settlement on the Solana blockchain.

## Lifecycle Diagram

The following state machine represents the deterministic flow of every ticket:

```mermaid
flowchart TD
  Start((COMMIT\nTicket Created))

  subgraph WAIT[WAIT PHASE]
    direction TB
    PENDING[PENDING\nStake Escrowed - Waiting for Oracle Pulse]
  end

  subgraph REVEAL[REVEAL PHASE]
    direction TB
    REVEAL_NOW[REVEAL NOW\nPulse Published - Reveal Window Open]
  end

  subgraph RESULT[SETTLEMENT PHASE]
    direction TB
    REVEALED[REVEALED\nGuess Submitted On-chain]
    WIN[WIN\nCorrect Prediction]
    BURN_LOSS[LOSS\nStake Collected/Burned]
    CLAIM_PRIZE[CLAIM PRIZE\nRewards liquid after Settlement]
    CLAIMED[CLAIMED\nStake Refunded + Reward]
    SWEPT[SWEPT\nGrace Period Expired\nProtocol Reclaims Funds]
    EXPIRED[EXPIRED\nFailure to Reveal - Stake Lost]
  end

  subgraph RECOVERY[RECOVERY PHASE]
    direction TB
    REFUND_AVAILABLE[REFUND AVAILABLE\nOracle Failure / Timeout]
    REFUNDED[REFUNDED\nStake Reclaimed by User]
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
