use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};

use crate::{
    errors::TimlgError,
    state::RoundState,
    utils::{assert_ed25519_ix_matches, expected_pulse_msg},
    SetOraclePubkey, SetPulseSigned,
};

pub fn set_oracle_pubkey(ctx: Context<SetOraclePubkey>, oracle_pubkey: Pubkey) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), TimlgError::Unauthorized);

    cfg.oracle_pubkey = oracle_pubkey;
    Ok(())
}

// Tx layout must be: [ ed25519_verify, set_pulse_signed ]
pub fn set_pulse_signed(ctx: Context<SetPulseSigned>, round_id: u64, pulse: [u8; 64]) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, TimlgError::Paused);

    // opcional, pero recomendable si config.oracle_pubkey puede ser Pubkey::default()
    require!(cfg.oracle_pubkey != Pubkey::default(), TimlgError::OracleNotSet);

    let round = &mut ctx.accounts.round;
    require!(round.round_id == round_id, TimlgError::TicketPdaMismatch);

    // window checks
    let current_slot = Clock::get()?.slot;
    require!(current_slot >= round.commit_deadline_slot, TimlgError::CommitClosed);
    require!(!round.finalized, TimlgError::RoundFinalized);

    // Liveness Hazard Check:
    // If we are too close to (or past) the reveal deadline, we must reject the pulse.
    // This allows the round to remain in "PulseNotSet" state so users can Refund.
    // Buffer: 50 slots (~20s) to give users at least some time to reveal.
    let min_reveal_window = 50;
    require!(
        current_slot < round.reveal_deadline_slot.saturating_sub(min_reveal_window),
        TimlgError::PulseTooLate
    );

    // one-shot
    require!(!round.pulse_set, TimlgError::PulseAlreadySet);

    // --- ed25519 introspection ---
    let ix_sys = ctx.accounts.instructions.to_account_info();
    let current_ix = load_current_index_checked(&ix_sys)? as usize;
    require!(current_ix >= 1, TimlgError::MissingOrInvalidEd25519Ix);

    let ed_ix = load_instruction_at_checked(current_ix - 1, &ix_sys)
        .map_err(|_| error!(TimlgError::MissingOrInvalidEd25519Ix))?;

    // build expected message (canonical)
    let expected = expected_pulse_msg(
        ctx.program_id,
        round_id,
        round.pulse_index_target,
        &pulse,
    );

    // validate ed25519 ix pubkey + msg
    assert_ed25519_ix_matches(&ed_ix, &cfg.oracle_pubkey, expected.as_slice())?;

    // commit state
    round.pulse = pulse;
    round.pulse_set = true;
    round.pulse_set_slot = current_slot;
    round.state = RoundState::PulseSet as u8;

    Ok(())
}
