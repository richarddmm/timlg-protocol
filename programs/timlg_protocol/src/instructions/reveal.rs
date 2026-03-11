use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};

use crate::{
    errors::TimlgError,
    state::{Round, Ticket},
    utils::{
        init_user_stats_if_needed, reveal_core, RevealEntry, RevealSignedEntry,
        MAX_BATCH, TICKET_SEED,
    },
    RevealBatch, RevealBatchSigned, RevealTicket,
};

pub fn update_streak(user_stats: &mut crate::state::UserStats, ticket: &Ticket) {
    if ticket.created_slot < user_stats.last_reset_slot {
        return;
    }

    user_stats.tickets_revealed = user_stats.tickets_revealed.saturating_add(1);

    if ticket.win {
        user_stats.games_won = user_stats.games_won.saturating_add(1);
        
        if user_stats.current_streak == 0 {
            user_stats.current_streak = 1;
        } else if ticket.user_commit_index == user_stats.last_revealed_winning_index.saturating_add(1) {
            user_stats.current_streak = user_stats.current_streak.saturating_add(1);
        } else {
            // Se rompe la racha si el ticket anterior no fue revelado o no fue ganador
            user_stats.current_streak = 1;
        }
        
        if user_stats.current_streak > user_stats.longest_streak {
            user_stats.longest_streak = user_stats.current_streak;
        }
        
        user_stats.last_revealed_winning_index = ticket.user_commit_index;
    } else {
        user_stats.games_lost = user_stats.games_lost.saturating_add(1);
        user_stats.current_streak = 0; // Se rompe la racha por pérdida
    }
}

#[inline(always)]
fn inc_reveal_counters(round: &mut Round, did_win: bool) -> Result<()> {
    round.revealed_count = round
        .revealed_count
        .checked_add(1)
        .ok_or_else(|| error!(TimlgError::MathOverflow))?;

    if did_win {
        round.win_count = round
            .win_count
            .checked_add(1)
            .ok_or_else(|| error!(TimlgError::MathOverflow))?;
            
        round.win_revealed_count = round
            .win_revealed_count
            .checked_add(1)
            .ok_or_else(|| error!(TimlgError::MathOverflow))?;
    }
    Ok(())
}

pub fn reveal_ticket(
    ctx: Context<RevealTicket>,
    round_id: u64,
    nonce: u64,
    guess: u8,
    salt: [u8; 32],
) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, TimlgError::Paused);
    require!(guess <= 1, TimlgError::InvalidGuess);

    // ✅ round mutable para actualizar contadores
    let round = &mut ctx.accounts.round;
    require!(!round.finalized, TimlgError::RoundFinalized);

    let current_slot = Clock::get()?.slot;
    require!(current_slot <= round.reveal_deadline_slot, TimlgError::RevealClosed);
    require!(round.pulse_set, TimlgError::PulseNotSet);

    let ticket = &mut ctx.accounts.ticket;
    require!(!ticket.revealed, TimlgError::AlreadyRevealed);

    // reveal_core necesita &Round (no &mut Round)
    reveal_core(
        &*round,
        ticket,
        ctx.accounts.user.key(),
        round_id,
        nonce,
        guess,
        salt,
        current_slot,
    )?;

    // ✅ counters (solo 1 vez: ya garantizamos !ticket.revealed arriba)
    inc_reveal_counters(round, ticket.win)?;

    init_user_stats_if_needed(
        &mut ctx.accounts.user_stats,
        ctx.accounts.user.key(),
        ctx.bumps.user_stats,
        current_slot,
    )?;
    update_streak(&mut ctx.accounts.user_stats, ticket);

    Ok(())
}

pub fn reveal_batch<'info>(
    ctx: Context<'_, '_, '_, 'info, RevealBatch<'info>>,
    round_id: u64,
    entries: Vec<RevealEntry>,
) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, TimlgError::Paused);

    require!(entries.len() <= MAX_BATCH, TimlgError::TooManyEntries);
    require!(
        ctx.remaining_accounts.len() == entries.len(),
        TimlgError::TicketPdaMismatch
    );

    // ✅ round mutable para actualizar contadores
    let round = &mut ctx.accounts.round;
    require!(!round.finalized, TimlgError::RoundFinalized);
    require!(round.pulse_set, TimlgError::PulseNotSet);

    let current_slot = Clock::get()?.slot;
    require!(current_slot <= round.reveal_deadline_slot, TimlgError::RevealClosed);

    let user_pk = ctx.accounts.user.key();
    let round_le = round_id.to_le_bytes();

    init_user_stats_if_needed(
        &mut ctx.accounts.user_stats,
        user_pk,
        ctx.bumps.user_stats,
        current_slot,
    )?;

    for (i, e) in entries.iter().enumerate() {
        require!(e.guess <= 1, TimlgError::InvalidGuess);
        let ticket_ai = ctx.remaining_accounts[i].clone();

        let nonce_le = e.nonce.to_le_bytes();
        let (expected_pda, _bump) = Pubkey::find_program_address(
            &[TICKET_SEED, &round_le, user_pk.as_ref(), &nonce_le],
            ctx.program_id,
        );
        require_keys_eq!(expected_pda, *ticket_ai.key, TimlgError::TicketPdaMismatch);
        require!(
            ticket_ai.owner == ctx.program_id,
            TimlgError::TicketNotOwnedByProgram
        );

        let mut ticket: Ticket = {
            let data = ticket_ai
                .try_borrow_data()
                .map_err(|_| error!(TimlgError::AccountBorrowFailed))?;
            let mut slice: &[u8] = &data;
            Ticket::try_deserialize(&mut slice)?
        };

        require!(!ticket.revealed, TimlgError::AlreadyRevealed);

        reveal_core(
            &*round,
            &mut ticket,
            user_pk,
            round_id,
            e.nonce,
            e.guess,
            e.salt,
            current_slot,
        )?;

        // ✅ counters por ticket revelado
        inc_reveal_counters(round, ticket.win)?;
        update_streak(&mut ctx.accounts.user_stats, &ticket);

        // persist ticket
        let mut data_mut = ticket_ai
            .try_borrow_mut_data()
            .map_err(|_| error!(TimlgError::AccountBorrowFailed))?;
        let mut cursor = std::io::Cursor::new(&mut data_mut[..]);
        ticket.try_serialize(&mut cursor)?;
    }

    Ok(())
}

pub fn reveal_batch_signed<'info>(
    ctx: Context<'_, '_, 'info, 'info, RevealBatchSigned<'info>>,
    round_id: u64,
    entries: Vec<RevealSignedEntry>,
) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, TimlgError::Paused);

    require!(entries.len() <= MAX_BATCH, TimlgError::TooManyEntries);
    require!(
        entries.len() == ctx.remaining_accounts.len(),
        TimlgError::TicketPdaMismatch
    );

    let round = &mut ctx.accounts.round;
    require!(!round.finalized, TimlgError::RoundFinalized);

    let current_slot = Clock::get()?.slot;

    require!(round.round_id == round_id, TimlgError::TicketPdaMismatch);
    require!(current_slot <= round.reveal_deadline_slot, TimlgError::RevealClosed);
    require!(round.pulse_set, TimlgError::PulseNotSet);

    // ✅ HARDENING: freeze comportamiento -> un batch signed NO puede mezclar usuarios
    if let Some(first) = entries.first() {
        for e in entries.iter() {
            require_keys_eq!(e.user, first.user, TimlgError::SignedBatchMixedUsers);
        }

        init_user_stats_if_needed(
            &mut ctx.accounts.user_stats,
            first.user,
            ctx.bumps.user_stats,
            current_slot,
        )?;
    }

    let ix_sys = ctx.accounts.instructions.to_account_info();
    let current_ix = load_current_index_checked(&ix_sys)? as usize;
    require!(current_ix >= entries.len(), TimlgError::MissingOrInvalidEd25519Ix);
    let first_ed_ix = current_ix - entries.len();

    for (i, e) in entries.iter().enumerate() {
        require!(e.guess <= 1, TimlgError::InvalidGuess);

        let ix = load_instruction_at_checked(first_ed_ix + i, &ix_sys)
            .map_err(|_| error!(TimlgError::MissingOrInvalidEd25519Ix))?;

        let expected_msg =
            expected_reveal_msg(ctx.program_id, round_id, &e.user, e.nonce, e.guess, &e.salt);
        assert_ed25519_ix_matches(&ix, &e.user, expected_msg.as_slice())?;

        let (expected_ticket_pda, _bump) = Pubkey::find_program_address(
            &[
                TICKET_SEED,
                &round_id.to_le_bytes(),
                e.user.as_ref(),
                &e.nonce.to_le_bytes(),
            ],
            ctx.program_id,
        );

        let ticket_ai = &ctx.remaining_accounts[i];
        require_keys_eq!(ticket_ai.key(), expected_ticket_pda, TimlgError::TicketPdaMismatch);
        require_keys_eq!(*ticket_ai.owner, *ctx.program_id, TimlgError::TicketPdaMismatch);

        let mut data = ticket_ai
            .try_borrow_mut_data()
            .map_err(|_| error!(TimlgError::AccountBorrowFailed))?;

        let mut slice: &[u8] = &data;
        let mut ticket: Ticket = Ticket::try_deserialize(&mut slice)
            .map_err(|_| error!(TimlgError::TicketPdaMismatch))?;

        require_keys_eq!(ticket.user, e.user, TimlgError::TicketPdaMismatch);
        require!(ticket.round_id == round_id, TimlgError::TicketPdaMismatch);
        require!(ticket.nonce == e.nonce, TimlgError::TicketPdaMismatch);
        require!(!ticket.revealed, TimlgError::AlreadyRevealed);

        reveal_core(
            &*round,
            &mut ticket,
            e.user,
            round_id,
            e.nonce,
            e.guess,
            e.salt,
            current_slot,
        )?;

        inc_reveal_counters(round, ticket.win)?;
        update_streak(&mut ctx.accounts.user_stats, &ticket);

        let mut w = std::io::Cursor::new(&mut data[..]);
        ticket
            .try_serialize(&mut w)
            .map_err(|_| error!(TimlgError::TicketPdaMismatch))?;
    }

    Ok(())
}
