// Centralized Protocol Constants

// Time & Slots Logic Constants
// ===========================

/// Minimum number of slots between Commit Deadline and Reveal Deadline.
/// Ensures there is always a minimal window for the Oracle to act, reducing race conditions.
/// 60 slots ~ 24 seconds (assuming 400ms/slot).
pub const MIN_REVEAL_WINDOW_SLOTS: u64 = 60;

/// Timeout in slots after Reveal Deadline to allow a Refund.
/// If the round is not finalized by (RevealDeadline + this_timeout),
/// users can trigger 'recover_funds' to withdraw their stake.
/// 
/// 150 slots ~ 1 minute (@ 0.4s/slot).
/// Setting this low for Devnet testing agility. For Mainnet, consider 300-450 slots.
pub const REFUND_TIMEOUT_SLOTS: u64 = 150;

// Centralized Protocol Defaults (Devnet)
// =====================================

/// Default window for the Commit phase (slots). Dev default; check current config.
pub const DEFAULT_COMMIT_WINDOW_SLOTS: u64 = 1000;

/// Default window for the Reveal phase (slots). Dev default; check current config.
pub const DEFAULT_REVEAL_WINDOW_SLOTS: u64 = 1000;

/// Default grace period for claims before sweeping (slots).
pub const DEFAULT_CLAIM_GRACE_SLOTS: u64 = 900;

/// Buffer to ensure users have time to reveal after pulse is set.
pub const LATE_PULSE_SAFETY_BUFFER_SLOTS: u64 = 50;

/// Default stake amount in base units (1.0 TIMLG = 1_000_000_000, assuming 9 decimals).
pub const DEFAULT_STAKE_AMOUNT: u64 = 1_000_000_000;

/// Default fee on minted rewards (basis points). 100 = 1%.
pub const DEFAULT_REWARD_FEE_BPS: u16 = 100;

/// Initial version for account structures.
pub const INITIAL_VERSION: u16 = 1;

/// Starting round ID for a new registry.
pub const INITIAL_ROUND_ID: u64 = 0;
