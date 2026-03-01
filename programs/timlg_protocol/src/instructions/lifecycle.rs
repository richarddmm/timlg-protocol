use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};

use anchor_spl::token::{self, Transfer};
use crate::state::Round;
use crate::constants::*;
use crate::ROUND_SEED;
use crate::{
    errors::TimlgError,
    state::RoundState,
    FinalizeRound, SweepUnclaimed, CloseRound, RecoverFunds, RecoverFundsAnyone, CloseTicket, VAULT_SEED,
};

pub fn finalize_round(ctx: Context<FinalizeRound>, round_id: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, TimlgError::Paused);
    require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), TimlgError::Unauthorized);

    let round = &mut ctx.accounts.round;
    require!(round.round_id == round_id, TimlgError::TicketPdaMismatch);
    require!(!round.finalized, TimlgError::AlreadyFinalized);

    // ✅ P1: no se puede finalizar si no se ha fijado el pulso
    require!(round.pulse_set, TimlgError::PulseNotSet);

    let current_slot = Clock::get()?.slot;
    require!(
        current_slot > round.reveal_deadline_slot,
        TimlgError::CannotFinalizeYet
    );

    round.finalized = true;
    round.finalized_slot = current_slot;
    round.state = RoundState::Finalized as u8;

    Ok(())
}

pub fn sweep_unclaimed(ctx: Context<SweepUnclaimed>, round_id: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, TimlgError::Paused);
    require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), TimlgError::Unauthorized);

    let round = &mut ctx.accounts.round;
    require!(round.round_id == round_id, TimlgError::TicketPdaMismatch);
    // Allow sweep of unfinalized rounds ONLY if they never received tickets (skipped pulse phase)
    if round.committed_count > 0 {
        require!(round.finalized, TimlgError::NotFinalized);
    }
    require!(!round.swept, TimlgError::AlreadySwept);

    // ✅ grace period gate
    let current_slot = Clock::get()?.slot;
    let min_sweep_slot = round
        .reveal_deadline_slot
        .saturating_add(cfg.claim_grace_slots);
    require!(current_slot > min_sweep_slot, TimlgError::SweepTooEarly);

    // 1) SOL Sweep (Rent)
    let vault_lamports = ctx.accounts.vault.to_account_info().lamports();
    if vault_lamports > 0 {
        let ix = system_instruction::transfer(
            &ctx.accounts.vault.key(),
            &ctx.accounts.admin.key(),
            vault_lamports,
        );

        let round_le = round_id.to_le_bytes();
        let signer_seeds: &[&[u8]] = &[VAULT_SEED, &round_le, &[round.vault_bump]];

        invoke_signed(
            &ix,
            &[
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.admin.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[signer_seeds],
        )?;
    }

    // 2) Token Sweep (Treasury SPL)
    let vault_tokens = ctx.accounts.timlg_vault.amount;
    if vault_tokens > 0 {
        let round_le = round_id.to_le_bytes();
        let signer_seeds: &[&[&[u8]]] = &[&[ROUND_SEED, &round_le, &[round.bump]]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.timlg_vault.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    authority: round.to_account_info(),
                },
                signer_seeds,
            ),
            vault_tokens,
        )?;
    }

    // ✅ mark swept
    round.swept = true;
    round.swept_slot = current_slot;

    Ok(())
}



pub fn close_round(ctx: Context<CloseRound>, round_id: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, TimlgError::Paused);
    require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), TimlgError::Unauthorized);

    let round = &ctx.accounts.round;
    require!(round.round_id == round_id, TimlgError::TicketPdaMismatch);
    
    // Safety checks: ensure round is completely done
    if round.committed_count > 0 {
        require!(round.finalized, TimlgError::NotFinalized);
    }
    
    let vault_is_empty = ctx.accounts.timlg_vault.amount == 0;
    require!(
        round.swept || round.committed_count == 0 || vault_is_empty,
        TimlgError::NotSwept
    );

    // Also check that timlg_vault is empty (amount == 0)
    // The `close` constraint will transfer any remaining rent lamports to admin,
    // but if there are tokens left, we might burn them or just fail?
    // SPL Token account close requires balance to be 0 for the account data.
    // The anchor `close` constraint handles the account lamports, but we should ensure token balance is 0.
    require!(ctx.accounts.timlg_vault.amount == 0, TimlgError::VaultNotEmpty);

    // Close the Token Account via CPI
    // The round PDA is the authority.
    let round_id_bytes = round.round_id.to_le_bytes();
    let bump = round.bump;
    let seeds = &[
        crate::ROUND_SEED,
        round_id_bytes.as_ref(),
        &[bump],
    ];
    let signer = &[&seeds[..]];

    let cpi_accounts = token::CloseAccount {
        account: ctx.accounts.timlg_vault.to_account_info(),
        destination: ctx.accounts.admin.to_account_info(),
        authority: round.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer,
    );
    token::close_account(cpi_ctx)?;

    // round PDA is closed automatically by the `close` constraint in context.
    
    Ok(())
}

pub fn recover_funds(ctx: Context<RecoverFunds>, round_id: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, TimlgError::Paused);

    let round = &mut ctx.accounts.round;
    require!(round.round_id == round_id, TimlgError::TicketPdaMismatch);
    require!(!round.finalized, TimlgError::AlreadyFinalized);

    // Timeout Check: has the round been stuck for too long?
    // "Stuck" means we passed the reveal deadline by a safety margin
    // and the round was never finalized (no pulse, or oracle inactive).
    let current_slot = Clock::get()?.slot;
    
    // MVP-Refund: Configurable or hardcoded timeout.
    let timeout_slots = REFUND_TIMEOUT_SLOTS; 

    require!(
        current_slot > round.reveal_deadline_slot.saturating_add(timeout_slots),
        TimlgError::RefundTooEarly
    );

    // SECURITY: Cannot refund if pulse is already set (outcome determined), even if not finalized yet.
    require!(!round.pulse_set, TimlgError::PulseAlreadySet);

    let ticket = &mut ctx.accounts.ticket;
    require!(ticket.round_id == round_id, TimlgError::TicketPdaMismatch);
    require!(!ticket.claimed, TimlgError::AlreadyClaimed);
    
    // Refund: Transfer Stake from Vault -> User
    // We only refund the STAKE amount (ticket price). rent is handled by 'close' logic.
    let stake_amount = cfg.stake_amount;

    let round_le = round_id.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[ROUND_SEED, &round_le, &[round.bump]]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.timlg_vault.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: round.to_account_info(),
            },
            signer_seeds,
        ),
        stake_amount,
    )?;

    // Update round stats
    // We are effectively "un-committing" this ticket.
    if round.committed_count > 0 {
        round.committed_count -= 1;
    }

    // ✅ Use claimed to prevent double-refund and enable close_ticket
    ticket.claimed = true;

    Ok(())
}


pub fn close_ticket(ctx: Context<CloseTicket>, round_id: u64, _nonce: u64) -> Result<()> {
    // 1. Verify Config/Pause
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, TimlgError::Paused);

    // 2. Validate Round & Ticket
    let ticket = &ctx.accounts.ticket;
    require!(ticket.round_id == round_id, TimlgError::TicketPdaMismatch);

    // 3. Logic: When can you close (recover rent)?
    //    Ideally, when the ticket is fully "done" (processed).
    //    Or if the round is finalized and cleaned up.
    
    // Check if round is "alive"
    let round_alive = ctx.accounts.round.lamports() > 0;

    if round_alive {
        let mut is_refund_mode = false;
        let mut is_finalized_status = false;
        let mut is_swept = false;
        
        if !ctx.accounts.round.data_is_empty() {
             let round_data = ctx.accounts.round.try_borrow_data()?;
             let mut slice: &[u8] = &round_data;
             if let Ok(mut round_state) = Round::try_deserialize(&mut slice) {
                 if round_state.round_id == round_id {
                     let current_slot = Clock::get()?.slot;
                     let timeout_slots = REFUND_TIMEOUT_SLOTS;
                     is_refund_mode = !round_state.pulse_set && 
                                      current_slot > round_state.reveal_deadline_slot.saturating_add(timeout_slots);
                     is_finalized_status = round_state.finalized;
                     is_swept = round_state.swept;

                     if round_state.committed_count > 0 {
                         round_state.committed_count -= 1;
                     }

                     drop(round_data);
                     let mut round_data_mut = ctx.accounts.round.try_borrow_mut_data()?;
                     let mut w = std::io::Cursor::new(&mut round_data_mut[..]);
                     round_state.try_serialize(&mut w)?;
                 }
             }
        }

        let is_loser = !ticket.revealed || (ticket.revealed && !ticket.win);

        if ticket.claimed || is_swept || is_refund_mode || (is_finalized_status && is_loser) {
            // OK to close. A winner cannot be closed unless it has claimed its reward or the round was swept.
        } else {
             return Err(error!(TimlgError::WinnerMustClaimFirst));
        }
    } else {

        // If round is dead (deleted/archived), allow closing any ticket to reclaim rent.
        // It's safe because the round state no longer exists to pay out rewards.
    }

    // Context `close = user` handles the lamport transfer.
    Ok(())
}

pub fn recover_funds_anyone(ctx: Context<RecoverFundsAnyone>, round_id: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let round = &mut ctx.accounts.round;
    require!(round.round_id == round_id, TimlgError::TicketPdaMismatch);
    require!(!round.finalized, TimlgError::AlreadyFinalized);

    let current_slot = Clock::get()?.slot;
    let timeout_slots = REFUND_TIMEOUT_SLOTS;

    require!(
        current_slot > round.reveal_deadline_slot.saturating_add(timeout_slots),
        TimlgError::RefundTooEarly
    );

    let ticket = &mut ctx.accounts.ticket;
    require!(!ticket.claimed, TimlgError::AlreadyClaimed);

    // Refund: Transfer Stake from Vault -> User
    let stake_amount = cfg.stake_amount;

    let round_le = round_id.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[ROUND_SEED, &round_le, &[round.bump]]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.timlg_vault.to_account_info(),
                to: ctx.accounts.user_token_account.to_account_info(),
                authority: round.to_account_info(),
            },
            signer_seeds,
        ),
        stake_amount,
    )?;

    // Update round stats
    if round.committed_count > 0 {
        round.committed_count -= 1;
    }

    // ✅ Fix: Mark as claimed
    ticket.claimed = true;

    Ok(())
}


