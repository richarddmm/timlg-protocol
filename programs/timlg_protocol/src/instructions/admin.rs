use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};

use anchor_spl::token::{self, SetAuthority};
use anchor_spl::token::spl_token::instruction::AuthorityType;

use crate::errors::TimlgError;
use crate::state::{Config, RoundState};
use crate::{
    CreateRound, CreateRoundAuto, FundVault, InitializeConfig, InitializeRoundRegistry, SetPause, UpdateStakeAmount,
};
use crate::InitializeTokenomics;
use crate::VAULT_SEED;
use crate::constants::*;

#[cfg(feature = "mock-pulse")]
use crate::SetPulseMock;

pub fn initialize_tokenomics(
    ctx: Context<InitializeTokenomics>,
    reward_fee_bps: u16,
) -> Result<()> {
    require!(reward_fee_bps <= 10_000, TimlgError::InvalidFeeBps);

    let cfg = &ctx.accounts.config;
    require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), TimlgError::Unauthorized);

    let tok = &mut ctx.accounts.tokenomics;
    tok.admin = ctx.accounts.admin.key();
    tok.bump = ctx.bumps.tokenomics;

    tok.reward_fee_bps = reward_fee_bps;

    tok.reward_fee_pool = ctx.accounts.reward_fee_pool.key();
    tok.reward_fee_pool_bump = ctx.bumps.reward_fee_pool;

    tok.replication_pool = ctx.accounts.replication_pool.key();
    tok.replication_pool_bump = ctx.bumps.replication_pool;

    tok.version = INITIAL_VERSION;

    Ok(())
}

pub fn initialize_round_registry(ctx: Context<InitializeRoundRegistry>, start_round_id: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), TimlgError::Unauthorized);

    let rr = &mut ctx.accounts.round_registry;
    rr.admin = cfg.admin;
    rr.bump = ctx.bumps.round_registry;
    rr.next_round_id = start_round_id;
    rr.version = INITIAL_VERSION;

    Ok(())
}

pub fn create_round_auto(
    ctx: Context<CreateRoundAuto>,
    pulse_index_target: u64,
    commit_deadline_slot: u64,
    reveal_deadline_slot: u64,
) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, TimlgError::Paused);
    require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), TimlgError::Unauthorized);
    require!(commit_deadline_slot < reveal_deadline_slot, TimlgError::InvalidDeadlines);
    require!(
        reveal_deadline_slot >= commit_deadline_slot + MIN_REVEAL_WINDOW_SLOTS,
        TimlgError::RevealWindowTooShort
    );

    let current_slot = Clock::get()?.slot;

    let rr = &mut ctx.accounts.round_registry;
    let round_id = rr.next_round_id;

    let round = &mut ctx.accounts.round;
    round.round_id = round_id;
    round.bump = ctx.bumps.round;
    round.state = 0; // Announced

    round.vault = ctx.accounts.vault.key();
    round.vault_bump = ctx.bumps.vault;

    round.timlg_vault = ctx.accounts.timlg_vault.key();
    round.timlg_vault_bump = ctx.bumps.timlg_vault;

    round.pulse_index_target = pulse_index_target;
    round.commit_deadline_slot = commit_deadline_slot;
    round.reveal_deadline_slot = reveal_deadline_slot;
    round.created_slot = current_slot;

    round.pulse_set = false;
    round.pulse = [0u8; 64];
    round.pulse_set_slot = 0;

    round.finalized = false;
    round.finalized_slot = 0;

    round.swept = false;
    round.swept_slot = 0;

    round.timlg_vault = ctx.accounts.timlg_vault.key();
    round.timlg_vault_bump = ctx.bumps.timlg_vault;

    round.committed_count = 0;
    round.revealed_count = 0;
    round.win_count = 0;

    round.settled_count = 0;
    round.token_settled = false;
    round.token_settled_slot = 0;

    rr.next_round_id = rr.next_round_id.checked_add(1).ok_or(TimlgError::MathOverflow)?;

    Ok(())
}

pub fn initialize_config(
    ctx: Context<InitializeConfig>,
    stake_amount: u64,
    commit_window_slots: u64,
    reveal_window_slots: u64,
) -> Result<()> {
    require!(stake_amount > 0, TimlgError::InvalidStakeAmount);
    require!(commit_window_slots > 0, TimlgError::InvalidWindow);
    require!(reveal_window_slots > 0, TimlgError::InvalidWindow);

    let cfg: &mut Account<Config> = &mut ctx.accounts.config;

    cfg.admin = ctx.accounts.admin.key();

    cfg.bump = ctx.bumps.config;

    cfg.treasury_bump = ctx.bumps.treasury;
    cfg.treasury = ctx.accounts.treasury.key();

    // ✅ NUEVO
    cfg.treasury_sol_bump = ctx.bumps.treasury_sol;
    cfg.treasury_sol = ctx.accounts.treasury_sol.key();

    cfg.stake_amount = stake_amount;
    cfg.commit_window_slots = commit_window_slots;
    cfg.reveal_window_slots = reveal_window_slots;

    // defaults seguros
    cfg.claim_grace_slots = DEFAULT_CLAIM_GRACE_SLOTS;
    cfg.oracle_pubkey = Pubkey::default(); // <- NO Option
    cfg.paused = false;
    cfg.version = INITIAL_VERSION;

    // SPL token plumbing
    cfg.timlg_mint = ctx.accounts.timlg_mint.key();

    // ✅ mover la mint authority del TIMLG_MINT al PDA config
    {
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_accounts = SetAuthority {
            account_or_mint: ctx.accounts.timlg_mint.to_account_info(),
            current_authority: ctx.accounts.admin.to_account_info(),
        };

        token::set_authority(
            CpiContext::new(cpi_program, cpi_accounts),
            AuthorityType::MintTokens,
            Some(cfg.key()),
        )?;
    }

    Ok(())
}


pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), TimlgError::Unauthorized);
    cfg.paused = paused;
    Ok(())
}

pub fn create_round(
    ctx: Context<CreateRound>,
    round_id: u64,
    pulse_index_target: u64,
    commit_deadline_slot: u64,
    reveal_deadline_slot: u64,
) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, TimlgError::Paused);
    require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), TimlgError::Unauthorized);
    require!(commit_deadline_slot < reveal_deadline_slot, TimlgError::InvalidDeadlines);
    require!(
        reveal_deadline_slot >= commit_deadline_slot + MIN_REVEAL_WINDOW_SLOTS,
        TimlgError::RevealWindowTooShort
    );

    let current_slot = Clock::get()?.slot;

    let round = &mut ctx.accounts.round;
    round.round_id = round_id;
    round.bump = ctx.bumps.round;
    round.state = RoundState::Announced as u8;

    round.vault = ctx.accounts.vault.key();
    round.vault_bump = ctx.bumps.vault;

    // ✅ SPL vault per round
    round.timlg_vault = ctx.accounts.timlg_vault.key();
    round.timlg_vault_bump = ctx.bumps.timlg_vault;

    round.pulse_index_target = pulse_index_target;
    round.commit_deadline_slot = commit_deadline_slot;
    round.reveal_deadline_slot = reveal_deadline_slot;
    round.created_slot = current_slot;

    round.pulse_set = false;
    round.pulse = [0u8; 64];
    round.pulse_set_slot = 0;

    // lifecycle
    round.finalized = false;
    round.finalized_slot = 0;

    round.swept = false;
    round.swept_slot = 0;

    // ===== economía / settlement =====
    round.committed_count = 0;
    round.revealed_count = 0;
    round.win_count = 0;

    round.settled_count = 0;
    round.token_settled = false;
    round.token_settled_slot = 0;

    Ok(())
}

pub fn fund_vault(ctx: Context<FundVault>, round_id: u64, amount: u64) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, TimlgError::Paused);
    require!(ctx.accounts.round.round_id == round_id, TimlgError::VaultPdaMismatch);

    if amount == 0 {
        return Ok(());
    }

    let round_le = round_id.to_le_bytes();
    let (expected_vault, bump) =
        Pubkey::find_program_address(&[VAULT_SEED, &round_le], ctx.program_id);
    require_keys_eq!(expected_vault, ctx.accounts.vault.key(), TimlgError::VaultPdaMismatch);
    require!(bump == ctx.accounts.round.vault_bump, TimlgError::VaultPdaMismatch);

    let ix = system_instruction::transfer(
        &ctx.accounts.funder.key(),
        &ctx.accounts.vault.key(),
        amount,
    );

    invoke(
        &ix,
        &[
            ctx.accounts.funder.to_account_info(),
            ctx.accounts.vault.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
    )?;

    Ok(())
}

#[cfg(feature = "mock-pulse")]
pub fn set_pulse_mock(
    ctx: Context<SetPulseMock>,
    _round_id: u64,
    pulse: [u8; 64],
) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), TimlgError::Unauthorized);

    let round = &mut ctx.accounts.round;
    require!(!round.pulse_set, TimlgError::PulseAlreadySet);

    let current_slot = Clock::get()?.slot;
    require!(current_slot >= round.commit_deadline_slot, TimlgError::CommitClosed);

    round.pulse = pulse;
    round.pulse_set = true;
    round.pulse_set_slot = current_slot;
    round.state = RoundState::PulseSet as u8;

    Ok(())
}

use crate::SetClaimGraceSlots;

pub fn set_claim_grace_slots(ctx: Context<SetClaimGraceSlots>, claim_grace_slots: u64) -> Result<()> {
    let cfg = &mut ctx.accounts.config;
    require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), TimlgError::Unauthorized);
    cfg.claim_grace_slots = claim_grace_slots;
    Ok(())
}

use crate::CloseConfig;

pub fn close_config(_ctx: Context<CloseConfig>) -> Result<()> {
    // The account closing is handled by the `close = admin` constraint in the context.
    Ok(())
}

pub fn update_stake_amount(ctx: Context<UpdateStakeAmount>, new_stake_amount: u64) -> Result<()> {
    require!(new_stake_amount > 0, TimlgError::InvalidStakeAmount);

    let cfg = &mut ctx.accounts.config;
    require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), TimlgError::Unauthorized);

    cfg.stake_amount = new_stake_amount;
    
    Ok(())
}

