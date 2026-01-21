// programs/timlg_protocol/src/instructions/escrow.rs
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Transfer};

use crate::{errors::TimlgError, DepositEscrow, InitUserEscrow, WithdrawEscrow};

/// Creates the UserEscrow PDA and its PDA TokenAccount (user_escrow_ata)
pub fn init_user_escrow(ctx: Context<InitUserEscrow>) -> Result<()> {
    let escrow = &mut ctx.accounts.user_escrow;
    let slot = Clock::get()?.slot;

    escrow.user = ctx.accounts.user.key();
    escrow.bump = ctx.bumps.user_escrow;
    escrow.created_slot = slot;
    escrow.updated_slot = slot;

    Ok(())
}

/// User deposits TIMLG into escrow (normal signed tx)
pub fn deposit_escrow(ctx: Context<DepositEscrow>, amount: u64) -> Result<()> {
    require!(amount > 0, TimlgError::InvalidStakeAmount);

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_timlg_ata.to_account_info(),
                to: ctx.accounts.user_escrow_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount,
    )?;

    ctx.accounts.user_escrow.updated_slot = Clock::get()?.slot;
    Ok(())
}

/// User withdraws TIMLG from escrow (optional utility)
pub fn withdraw_escrow(ctx: Context<WithdrawEscrow>, amount: u64) -> Result<()> {
    require!(amount > 0, TimlgError::InvalidStakeAmount);

    let user_pk = ctx.accounts.user.key();

    // Check owner
    require_keys_eq!(
        ctx.accounts.user_escrow.user,
        user_pk,
        TimlgError::Unauthorized
    );

    // Prepare signer seeds BEFORE CPI (no &mut borrow)
    let escrow_bump = ctx.accounts.user_escrow.bump;
    let signer_seeds: &[&[&[u8]]] = &[&[
        crate::USER_ESCROW_SEED,
        user_pk.as_ref(),
        &[escrow_bump],
    ]];

    // CPI transfer out of escrow (PDA signs)
    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_escrow_ata.to_account_info(),
                to: ctx.accounts.user_timlg_ata.to_account_info(),
                authority: ctx.accounts.user_escrow.to_account_info(),
            },
            signer_seeds,
        ),
        amount,
    )?;

    // Now mutate escrow AFTER CPI
    ctx.accounts.user_escrow.updated_slot = Clock::get()?.slot;

    Ok(())
}
