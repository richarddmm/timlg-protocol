use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};

use anchor_spl::token::{self, Burn, Transfer};
use crate::state::Ticket;
use crate::constants::*;
use crate::{SettleRoundTokens, TICKET_SEED, ROUND_SEED};

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
    require!(round.finalized, TimlgError::NotFinalized);
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
            &ctx.accounts.treasury_sol.key(),
            vault_lamports,
        );

        let round_le = round_id.to_le_bytes();
        let signer_seeds: &[&[u8]] = &[VAULT_SEED, &round_le, &[round.vault_bump]];

        invoke_signed(
            &ix,
            &[
                ctx.accounts.vault.to_account_info(),
                ctx.accounts.treasury_sol.to_account_info(),
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

pub fn settle_round_tokens<'info>(
    ctx: Context<'_, '_, 'info, 'info, SettleRoundTokens<'info>>,
    round_id: u64,
) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, TimlgError::Paused);


    // ✅ toma AccountInfo del authority ANTES para evitar E0502
    let round_ai = ctx.accounts.round.to_account_info();

    let round = &mut ctx.accounts.round;
    require!(round.round_id == round_id, TimlgError::TicketPdaMismatch);
    let current_slot = Clock::get()?.slot;
    require!(
        current_slot > round.reveal_deadline_slot,
        TimlgError::SettleTooEarly
    );

    // Auto-finalize if needed (Robustness: allow settle to trigger finalization)
    if !round.finalized {
        require!(round.pulse_set, TimlgError::PulseNotSet);
        round.finalized = true;
        round.finalized_slot = current_slot;
        round.state = crate::state::RoundState::Finalized as u8;
    }

    require!(!round.token_settled, TimlgError::RoundTokensAlreadySettled);

    let stake = cfg.stake_amount;
    let mut losers: u64 = 0;
    // unrevealed count not needed for logic, just accounting if we wanted stats

    let round_le = round_id.to_le_bytes();

    for ai in ctx.remaining_accounts.iter() {
        require!(ai.owner == ctx.program_id, TimlgError::TicketNotOwnedByProgram);

        let mut data = ai
            .try_borrow_mut_data()
            .map_err(|_| error!(TimlgError::AccountBorrowFailed))?;

        let mut slice: &[u8] = &data;
        let mut ticket: Ticket = Ticket::try_deserialize(&mut slice)
            .map_err(|_| error!(TimlgError::TicketPdaMismatch))?;

        require!(ticket.round_id == round_id, TimlgError::TicketPdaMismatch);
        require!(ticket.stake_paid, TimlgError::StakeNotPaid);

        // --- PDA sanity ---
        let nonce_le = ticket.nonce.to_le_bytes();
        let (expected, bump) = Pubkey::find_program_address(
            &[TICKET_SEED, &round_le, ticket.user.as_ref(), &nonce_le],
            ctx.program_id,
        );
        require_keys_eq!(expected, *ai.key, TimlgError::TicketPdaMismatch);
        require!(bump == ticket.bump, TimlgError::TicketPdaMismatch);

        // ✅ Incremental settlement: skip already processed tickets
        if ticket.processed {
            continue;
        }

        // Classify and account this ticket exactly once
        // Classify and account this ticket exactly once
        // MVP-3.2: Burn unrevealed tickets same as losers
        if !ticket.revealed || !ticket.win {
            losers = losers
                .checked_add(1)
                .ok_or_else(|| error!(TimlgError::MathOverflow))?;
            ticket.stake_slashed = true; // burn will happen for this call
        } else {
            // winner: no burn/transfer now, stake stays in vault for claim
        }

        // ✅ Mark processed + bump round.settled_count
        ticket.processed = true;
        round.settled_count = round
            .settled_count
            .checked_add(1)
            .ok_or_else(|| error!(TimlgError::MathOverflow))?;

        // write back
        let mut w = std::io::Cursor::new(&mut data[..]);
        ticket
            .try_serialize(&mut w)
            .map_err(|_| error!(TimlgError::TicketPdaMismatch))?;
    }

    // Tokenomics:
    // - losers (incl unrevealed) => burn from timlg_vault
    // (winners stay in timlg_vault so claim_reward can refund stake)

    let total_to_burn = stake
        .checked_mul(losers)
        .ok_or_else(|| error!(TimlgError::MathOverflow))?;

    let signer_seeds: &[&[&[u8]]] = &[&[ROUND_SEED, &round_le, &[round.bump]]];

    // Burn losers from the round vault (authority = Round PDA)
    // Burn losers from the round vault (authority = Round PDA)
    if total_to_burn > 0 {
        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.timlg_mint.to_account_info(),
                    from: ctx.accounts.timlg_vault.to_account_info(),
                    authority: round_ai.clone(),
                },
                signer_seeds,
            ),
            total_to_burn,
        )?;
    }

    // Removed transfer to replication_pool (MVP-3.2)

    // Only mark fully settled when all committed tickets have been processed
    if round.settled_count == round.committed_count {
        round.token_settled = true;
        round.token_settled_slot = current_slot;
    }

    Ok(())
}

pub fn close_round(ctx: Context<CloseRound>, round_id: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, TimlgError::Paused);
    require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), TimlgError::Unauthorized);

    let round = &ctx.accounts.round;
    require!(round.round_id == round_id, TimlgError::TicketPdaMismatch);
    
    // Safety checks: ensure round is completely done
    require!(round.finalized, TimlgError::NotFinalized);
    // If no tickets were committed, token_settled might be false, which is fine.
    require!(
        round.token_settled || round.committed_count == 0,
        TimlgError::RoundTokensNotSettled
    );
    require!(round.swept, TimlgError::NotSwept);

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

    let ticket = &ctx.accounts.ticket;
    require!(ticket.round_id == round_id, TimlgError::TicketPdaMismatch);
    require!(!ticket.processed, TimlgError::TicketAlreadyProcessed);
    
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
        // If round is alive, we enforce processing to ensure no double-claiming or skipping settlement.
        if ticket.processed {
            if ticket.win {
                require!(ticket.claimed, TimlgError::WinnerMustClaimFirst);
            }
            // If !win, allowed.
        } else {
            return Err(error!(TimlgError::TicketNotProcessed));
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

    let ticket = &ctx.accounts.ticket;
    require!(!ticket.processed, TimlgError::TicketAlreadyProcessed);

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

    Ok(())
}


