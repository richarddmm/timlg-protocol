use anchor_lang::prelude::*;

#[error_code]
pub enum TimlgError {
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Protocol paused")]
    Paused,
    #[msg("Invalid deadlines")]
    InvalidDeadlines,
    #[msg("Commit window closed")]
    CommitClosed,
    #[msg("Reveal window closed")]
    RevealClosed,
    #[msg("Pulse not set")]
    PulseNotSet,
    #[msg("Round pulse already set")]
    PulseAlreadySet,
    #[msg("Round already finalized")]
    AlreadyFinalized,
    #[msg("Round not finalized")]
    NotFinalized,
    #[msg("Cannot finalize yet")]
    CannotFinalizeYet,

    #[msg("Already revealed")]
    AlreadyRevealed,
    #[msg("Commitment mismatch")]
    CommitmentMismatch,
    #[msg("Invalid guess (must be 0/1)")]
    InvalidGuess,
    #[msg("Too many entries")]
    TooManyEntries,

    #[msg("Ticket PDA mismatch")]
    TicketPdaMismatch,
    #[msg("Ticket already exists")]
    TicketAlreadyExists,
    #[msg("Ticket not owned by program")]
    TicketNotOwnedByProgram,

    #[msg("Vault PDA mismatch")]
    VaultPdaMismatch,
    #[msg("Insufficient vault funds")]
    InsufficientVaultFunds,

    #[msg("Missing or invalid ed25519 verify instruction")]
    MissingOrInvalidEd25519Ix,
    #[msg("Ed25519 pubkey mismatch")]
    Ed25519PubkeyMismatch,
    #[msg("Ed25519 message mismatch")]
    Ed25519MessageMismatch,

    #[msg("Oracle pubkey not set")]
    OracleNotSet,

    #[msg("Bit index mismatch")]
    BitIndexMismatch,

    #[msg("Failed to borrow account data")]
    AccountBorrowFailed,

    #[msg("Round is finalized")]
    RoundFinalized,

    #[msg("Commit not allowed after pulse is set")]
    CommitAfterPulseSet,

    #[msg("Sweep not allowed yet (grace period not elapsed)")]
    SweepTooEarly,

    #[msg("Vault already swept for this round")]
    AlreadySwept,

    #[msg("Cannot claim after vault sweep")]
    ClaimAfterSweep,

    #[msg("Invalid stake amount")]
    InvalidStakeAmount,

    #[msg("Invalid window")]
    InvalidWindow,

    #[msg("Missing bump")]
    MissingBump,

    #[msg("Math overflow")]
    MathOverflow,

    #[msg("timlg_mint does not match config")]
    TIMLGMintMismatch,

    #[msg("Invalid user TIMLG token account")]
    InvalidUserTIMLGAta,

    #[msg("Ticket not revealed")]
    TicketNotRevealed,

    #[msg("Not a winner")]
    NotWinner,

    #[msg("Already claimed")]
    AlreadyClaimed,

    #[msg("Stake not paid for this ticket")]
    StakeNotPaid,

    #[msg("Insufficient escrow funds")]
    InsufficientEscrow,

    #[msg("Signed batch contains mixed users")]
    SignedBatchMixedUsers,

    #[msg("Round tokens not settled yet")]
    RoundNotSettled,

    #[msg("Too early to settle round tokens")]
    SettleTooEarly,


    // -----------------
    // OracleSet
    // -----------------
    #[msg("OracleSet is full")]
    OracleSetFull,

    #[msg("Oracle already exists in allowlist")]
    OracleAlreadyExists,

    #[msg("Oracle not found in allowlist")]
    OracleNotFound,

    #[msg("Invalid threshold")]
    InvalidThreshold,

    #[msg("Threshold exceeds current oracle count")]
    ThresholdExceedsOracleCount,

    #[msg("Invalid fee bps (must be 0..=10_000).")]
    InvalidFeeBps,

    #[msg("Invalid basis points (must be <= 10000)")]
    InvalidBps,

    #[msg("Refund too early")]
    RefundTooEarly = 6052,
    #[msg("Vault not empty")]
    VaultNotEmpty = 6053,
    #[msg("Reveal window too short")]
    RevealWindowTooShort = 6054,

    #[msg("Tokenomics not initialized")]
    TokenomicsNotInitialized,

    #[msg("Round not swept")]
    NotSwept,

    #[msg("Round tokens not settled")]
    RoundTokensNotSettled,

    #[msg("Ticket already processed")]
    TicketAlreadyProcessed,


    #[msg("Ticket not processed yet")]
    TicketNotProcessed,

    #[msg("Winner must claim reward first")]
    WinnerMustClaimFirst,

    #[msg("Pulse too late (liveness hazard)")]
    PulseTooLate,
}
