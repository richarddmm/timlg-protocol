use anchor_lang::prelude::*;
use anchor_spl::token::{self, MintTo, Transfer};

use crate::{errors::TimlgError, ClaimReward};

pub fn claim_reward(ctx: Context<ClaimReward>, _round_id: u64, _nonce: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    let round = &ctx.accounts.round;
    let ticket = &mut ctx.accounts.ticket;
    let tokenomics = &ctx.accounts.tokenomics;

    require!(round.token_settled, TimlgError::RoundNotSettled);

    // si ya se hizo sweep, se cerró la ventana de claim
    require!(!round.swept, TimlgError::ClaimAfterSweep);

    // Defensa extra (además de seeds del Context)
    require_keys_eq!(ticket.user, ctx.accounts.user.key(), TimlgError::Unauthorized);
    require!(ticket.round_id == round.round_id, TimlgError::TicketPdaMismatch);

    require!(ticket.stake_paid, TimlgError::StakeNotPaid);
    require!(ticket.revealed, TimlgError::TicketNotRevealed);
    require!(ticket.win, TimlgError::NotWinner);
    require!(!ticket.claimed, TimlgError::AlreadyClaimed);

    // 1) refund stake: transfer stake_amount desde timlg_vault al user ATA
    let round_le = round.round_id.to_le_bytes();
    let signer_seeds: &[&[&[u8]]] = &[&[
        crate::ROUND_SEED,
        &round_le,
        &[round.bump],
    ]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.timlg_vault.to_account_info(),
                to: ctx.accounts.user_timlg_ata.to_account_info(),
                authority: ctx.accounts.round.to_account_info(),
            },
            signer_seeds,
        ),
        cfg.stake_amount,
    )?;

    // 2) mint reward, applying fee bps:
    // reward_total = stake_amount
    // fee = reward_total * bps / 10000
    // user gets (reward_total - fee), fee goes to reward_fee_pool
    require!(tokenomics.reward_fee_bps <= 10_000, TimlgError::InvalidBps);

    let reward_total = cfg.stake_amount;
    let fee = reward_total
        .checked_mul(tokenomics.reward_fee_bps as u64)
        .ok_or(TimlgError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(TimlgError::MathOverflow)?;
    let user_reward = reward_total.checked_sub(fee).ok_or(TimlgError::MathOverflow)?;

    let cfg_seeds: &[&[&[u8]]] = &[&[
        crate::CONFIG_SEED,
        &[cfg.bump],
    ]];

    if user_reward > 0 {
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.timlg_mint.to_account_info(),
                    to: ctx.accounts.user_timlg_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                cfg_seeds,
            ),
            user_reward,
        )?;
    }

    if fee > 0 {
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.timlg_mint.to_account_info(),
                    to: ctx.accounts.reward_fee_pool.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                cfg_seeds,
            ),
            fee,
        )?;
    }

    ticket.claimed = true;
    ticket.claimed_slot = Clock::get()?.slot;

    Ok(())
}
