use anchor_lang::prelude::*;

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
