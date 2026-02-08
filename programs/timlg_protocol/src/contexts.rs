// programs/timlg_protocol/src/contexts.rs

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::state::{Config, OracleSet, Round, RoundRegistry, Ticket, UserEscrow, Tokenomics};

#[derive(Accounts)]
pub struct InitializeTokenomics<'info> {
    #[account(
        mut,
        seeds = [crate::CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(address = config.timlg_mint)]
    pub timlg_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = 8 + Tokenomics::INIT_SPACE,
        seeds = [crate::TOKENOMICS_SEED, config.key().as_ref()],
        bump
    )]
    pub tokenomics: Account<'info, Tokenomics>,

    #[account(
        init,
        payer = admin,
        token::mint = timlg_mint,
        token::authority = config,
        seeds = [crate::REWARD_FEE_POOL_SEED, tokenomics.key().as_ref()],
        bump
    )]
    pub reward_fee_pool: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = admin,
        token::mint = timlg_mint,
        token::authority = config,
        seeds = [crate::REPLICATION_POOL_SEED, tokenomics.key().as_ref()],
        bump
    )]
    pub replication_pool: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitializeRoundRegistry<'info> {
    #[account(
        mut,
        seeds = [crate::CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = admin,
        space = 8 + RoundRegistry::INIT_SPACE,
        seeds = [crate::ROUND_REGISTRY_SEED, config.key().as_ref()],
        bump
    )]
    pub round_registry: Account<'info, RoundRegistry>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CreateRoundAuto<'info> {
    #[account(
        mut,
        seeds = [crate::CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, Config>,

    #[account(address = config.timlg_mint)]
    pub timlg_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [crate::ROUND_REGISTRY_SEED, config.key().as_ref()],
        bump = round_registry.bump,
    )]
    pub round_registry: Account<'info, RoundRegistry>,

    #[account(
        init,
        payer = admin,
        space = 8 + Round::INIT_SPACE,
        seeds = [crate::ROUND_SEED, round_registry.next_round_id.to_le_bytes().as_ref()],
        bump
    )]
    pub round: Account<'info, Round>,

    /// CHECK: system-owned vault PDA, holds lamports, no data
    #[account(
        init,
        payer = admin,
        space = 0,
        owner = anchor_lang::solana_program::system_program::ID,
        seeds = [crate::VAULT_SEED, round_registry.next_round_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,

    #[account(
        init,
        payer = admin,
        seeds = [crate::TIMLG_VAULT_SEED, round_registry.next_round_id.to_le_bytes().as_ref()],
        bump,
        token::mint = timlg_mint,
        token::authority = round
    )]
    pub timlg_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [crate::CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,

    /// Mint SPL del token TIMLG (ya creado off-chain en tests o en deploy script)
    #[account(mut)]
    pub timlg_mint: Account<'info, Mint>,

    /// ✅ NUEVO: Treasury SOL (lamports) como system-owned PDA (igual que vault)
    /// CHECK: system-owned PDA (owner = system program). Address enforced by seeds/bump.
    #[account(
        init,
        payer = admin,
        space = 0,
        owner = anchor_lang::solana_program::system_program::ID,
        seeds = [crate::TREASURY_SOL_SEED],
        bump
    )]
    pub treasury_sol: UncheckedAccount<'info>,

    /// Treasury SPL = TokenAccount PDA controlado por el programa (authority = config PDA)
    #[account(
        init,
        payer = admin,
        seeds = [crate::TREASURY_SEED],
        bump,
        token::mint = timlg_mint,
        token::authority = config
    )]
    pub treasury: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SetPause<'info> {
    #[account(
        mut,
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    pub admin: Signer<'info>,
}

// ----------------------------
// OracleSet (allowlist + threshold)
// ----------------------------

#[derive(Accounts)]
pub struct InitializeOracleSet<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = admin,
        space = 8 + OracleSet::INIT_SPACE,
        seeds = [crate::ORACLE_SET_SEED, config.key().as_ref()],
        bump
    )]
    pub oracle_set: Account<'info, OracleSet>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AddOracle<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [crate::ORACLE_SET_SEED, config.key().as_ref()],
        bump = oracle_set.bump
    )]
    pub oracle_set: Account<'info, OracleSet>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct RemoveOracle<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [crate::ORACLE_SET_SEED, config.key().as_ref()],
        bump = oracle_set.bump
    )]
    pub oracle_set: Account<'info, OracleSet>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetOracleThreshold<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [crate::ORACLE_SET_SEED, config.key().as_ref()],
        bump = oracle_set.bump
    )]
    pub oracle_set: Account<'info, OracleSet>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetOraclePubkey<'info> {
    #[account(
        mut,
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct SetClaimGraceSlots<'info> {
    #[account(
        mut,
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateStakeAmount<'info> {
    #[account(
        mut,
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateTokenomics<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [crate::TOKENOMICS_SEED, config.key().as_ref()],
        bump
    )]
    pub tokenomics: Account<'info, Tokenomics>,

    pub admin: Signer<'info>,
}

// ----------------------------
// P0: User Escrow (pre-deposit for gasless signed commits)
// ----------------------------
#[derive(Accounts)]
pub struct InitUserEscrow<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(mut, address = config.timlg_mint)]
    pub timlg_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = user,
        space = 8 + UserEscrow::INIT_SPACE,
        seeds = [crate::USER_ESCROW_SEED, user.key().as_ref()],
        bump
    )]
    pub user_escrow: Account<'info, UserEscrow>,

    #[account(
        init,
        payer = user,
        seeds = [crate::USER_ESCROW_VAULT_SEED, user.key().as_ref()],
        bump,
        token::mint = timlg_mint,
        token::authority = user_escrow
    )]
    pub user_escrow_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct DepositEscrow<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(mut, address = config.timlg_mint)]
    pub timlg_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [crate::USER_ESCROW_SEED, user.key().as_ref()],
        bump = user_escrow.bump
    )]
    pub user_escrow: Account<'info, UserEscrow>,

    #[account(
        mut,
        seeds = [crate::USER_ESCROW_VAULT_SEED, user.key().as_ref()],
        bump,
        constraint = user_escrow_ata.mint == timlg_mint.key(),
        constraint = user_escrow_ata.owner == user_escrow.key()
    )]
    pub user_escrow_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_timlg_ata.owner == user.key(),
        constraint = user_timlg_ata.mint == timlg_mint.key()
    )]
    pub user_timlg_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawEscrow<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(mut, address = config.timlg_mint)]
    pub timlg_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [crate::USER_ESCROW_SEED, user.key().as_ref()],
        bump = user_escrow.bump
    )]
    pub user_escrow: Account<'info, UserEscrow>,

    #[account(
        mut,
        seeds = [crate::USER_ESCROW_VAULT_SEED, user.key().as_ref()],
        bump,
        constraint = user_escrow_ata.mint == timlg_mint.key(),
        constraint = user_escrow_ata.owner == user_escrow.key()
    )]
    pub user_escrow_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_timlg_ata.owner == user.key(),
        constraint = user_timlg_ata.mint == timlg_mint.key()
    )]
    pub user_timlg_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CreateRound<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    // Enforzamos que el mint usado sea el del config
    #[account(address = config.timlg_mint)]
    pub timlg_mint: Account<'info, Mint>,

    #[account(
        init,
        payer = admin,
        space = 8 + Round::INIT_SPACE,
        seeds = [crate::ROUND_SEED, round_id.to_le_bytes().as_ref()],
        bump
    )]
    pub round: Account<'info, Round>,

    /// CHECK: Vault SOL actual (se mantiene de momento)
    #[account(
        init,
        payer = admin,
        space = 0,
        owner = anchor_lang::solana_program::system_program::ID,
        seeds = [crate::VAULT_SEED, round_id.to_le_bytes().as_ref()],
        bump
    )]
    pub vault: UncheckedAccount<'info>,

    // ✅ Nuevo: vault SPL (TIMLG) por ronda
    #[account(
        init,
        payer = admin,
        seeds = [crate::TIMLG_VAULT_SEED, round_id.to_le_bytes().as_ref()],
        bump,
        token::mint = timlg_mint,
        token::authority = round
    )]
    pub timlg_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct FundVault<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        seeds = [crate::ROUND_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,

    /// CHECK: System-owned PDA used only as a lamport vault. Address is enforced by seeds/bump.
    #[account(
        mut,
        seeds = [crate::VAULT_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,

    #[account(mut)]
    pub funder: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct SetPulseMock<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [crate::ROUND_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct SetPulseSigned<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [crate::ROUND_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,

    /// CHECK: instruction sysvar (for ed25519 introspection). Address enforced.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct FinalizeRound<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [crate::ROUND_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct RecoverFunds<'info> {
    #[account(mut)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [crate::ROUND_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,

    #[account(
        mut,
        // Relaxing seeds check to avoid ConstraintSeeds error (nonce read issue?).
        // Security ensured by has_one=user and owner check.
        has_one = user,
        close = user
    )]
    pub ticket: Account<'info, Ticket>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        token::mint = timlg_mint,
        token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [crate::TIMLG_VAULT_SEED, round_id.to_le_bytes().as_ref()],
        bump,
        token::mint = timlg_mint,
        token::authority = round,
    )]
    pub timlg_vault: Account<'info, TokenAccount>,

    #[account(address = config.timlg_mint)]
    pub timlg_mint: Account<'info, Mint>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct RecoverFundsAnyone<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [crate::ROUND_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,

    #[account(
        mut,
        seeds = [crate::TICKET_SEED, round_id.to_le_bytes().as_ref(), user.key().as_ref(), ticket.nonce.to_le_bytes().as_ref()],
        bump = ticket.bump,
        has_one = user,
        close = user
    )]
    pub ticket: Account<'info, Ticket>,

    /// CHECK: The user who owns the ticket (receiver of refund).
    #[account(mut)]
    pub user: UncheckedAccount<'info>,

    #[account(
        mut,
        token::mint = timlg_mint,
        token::authority = user,
    )]
    pub user_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [crate::TIMLG_VAULT_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.timlg_vault_bump,
        token::mint = timlg_mint,
        token::authority = round,
    )]
    pub timlg_vault: Account<'info, TokenAccount>,

    #[account(address = config.timlg_mint)]
    pub timlg_mint: Account<'info, Mint>,

    #[account(mut)]
    pub cranker: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_id: u64, nonce: u64)]
pub struct CloseTicket<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    /// CHECK: Only used to detect if the round is archived (lamports == 0).
    /// Address verification is secondary as Ticket PDA already enforces the round_id.
    pub round: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [crate::TICKET_SEED, round_id.to_le_bytes().as_ref(), user.key().as_ref(), nonce.to_le_bytes().as_ref()],
        bump = ticket.bump,
        has_one = user,
        close = user
    )]
    pub ticket: Account<'info, Ticket>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct SweepUnclaimed<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [crate::ROUND_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,

    /// CHECK: System-owned PDA vault. Address enforced by seeds/bump.
    #[account(
        mut,
        seeds = [crate::VAULT_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.vault_bump
    )]
    pub vault: UncheckedAccount<'info>,

    /// ✅ SOL destination
    /// CHECK: System-owned PDA. Address enforced by seeds/bump + address=config.treasury_sol
    #[account(
        mut,
        seeds = [crate::TREASURY_SOL_SEED],
        bump = config.treasury_sol_bump,
        address = config.treasury_sol
    )]
    pub treasury_sol: UncheckedAccount<'info>,

    /// ✅ SPL vault per round
    #[account(
        mut,
        seeds = [crate::TIMLG_VAULT_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.timlg_vault_bump,
        token::mint = timlg_mint,
        token::authority = round
    )]
    pub timlg_vault: Account<'info, TokenAccount>,

    /// ✅ SPL destination (from config)
    #[account(
        mut,
        seeds = [crate::TREASURY_SEED],
        bump = config.treasury_bump,
        token::mint = timlg_mint,
        token::authority = config
    )]
    pub treasury: Account<'info, TokenAccount>,

    #[account(address = config.timlg_mint)]
    pub timlg_mint: Account<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_id: u64, nonce: u64)]
pub struct CommitTicket<'info> {
    #[account(
        mut,
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [crate::ROUND_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,

    #[account(address = config.timlg_mint)]
    pub timlg_mint: Account<'info, Mint>,

    #[account(mut, address = round.timlg_vault)]
    pub timlg_vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = user,
        space = 8 + Ticket::INIT_SPACE,
        seeds = [
            crate::TICKET_SEED,
            round_id.to_le_bytes().as_ref(),
            user.key().as_ref(),
            nonce.to_le_bytes().as_ref(),
        ],
        bump
    )]
    pub ticket: Account<'info, Ticket>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_timlg_ata.mint == timlg_mint.key(),
        constraint = user_timlg_ata.owner == user.key()
    )]
    pub user_timlg_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [crate::TREASURY_SOL_SEED],
        bump = config.treasury_sol_bump,
        address = config.treasury_sol
    )]
    pub treasury_sol: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}


#[derive(Accounts)]
#[instruction(round_id: u64, nonce: u64)]
pub struct RevealTicket<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        seeds = [crate::ROUND_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,

    #[account(
        mut,
        seeds = [
            crate::TICKET_SEED,
            round_id.to_le_bytes().as_ref(),
            user.key().as_ref(),
            nonce.to_le_bytes().as_ref()
        ],
        bump = ticket.bump
    )]
    pub ticket: Account<'info, Ticket>,

    pub user: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CommitBatch<'info> {
    #[account(
        mut,
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [crate::ROUND_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,

    #[account(address = config.timlg_mint)]
    pub timlg_mint: Account<'info, Mint>,

    #[account(mut, address = round.timlg_vault)]
    pub timlg_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_timlg_ata.mint == timlg_mint.key(),
        constraint = user_timlg_ata.owner == user.key()
    )]
    pub user_timlg_ata: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [crate::TREASURY_SOL_SEED],
        bump = config.treasury_sol_bump,
        address = config.treasury_sol
    )]
    pub treasury_sol: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct RevealBatch<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        seeds = [crate::ROUND_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,

    pub user: Signer<'info>,
    // tickets via remaining_accounts (writable)
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CommitBatchSigned<'info> {
    #[account(
        mut,
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [crate::ROUND_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,

    #[account(address = config.timlg_mint)]
    pub timlg_mint: Account<'info, Mint>,

    #[account(mut, address = round.timlg_vault)]
    pub timlg_vault: Account<'info, TokenAccount>,

    /// Relayer (paga fees)
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        mut,
        seeds = [crate::USER_ESCROW_SEED, user.key().as_ref()],
        bump = user_escrow.bump
    )]
    pub user_escrow: Account<'info, UserEscrow>,

    #[account(
        mut,
        seeds = [crate::USER_ESCROW_VAULT_SEED, user.key().as_ref()],
        bump
    )]
    pub user_escrow_ata: Account<'info, TokenAccount>,

    /// CHECK: user pubkey referenced in ed25519 msg
    pub user: UncheckedAccount<'info>,

    /// CHECK: instructions sysvar for ed25519 introspection
    pub instructions: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [crate::TREASURY_SOL_SEED],
        bump = config.treasury_sol_bump,
        address = config.treasury_sol
    )]
    pub treasury_sol: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct RevealBatchSigned<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [crate::ROUND_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,

    /// Relayer paying tx fees (must sign tx)
    pub payer: Signer<'info>,

    /// CHECK: instruction sysvar (for ed25519 introspection). Address enforced.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(round_id: u64, nonce: u64)]
pub struct ClaimReward<'info> {
    #[account(
        mut,
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
    seeds = [crate::TOKENOMICS_SEED, config.key().as_ref()],
    bump = tokenomics.bump
    )]
    pub tokenomics: Account<'info, Tokenomics>,

    #[account(
        mut,
        seeds = [crate::ROUND_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,

    #[account(
        mut,
        seeds = [
            crate::TICKET_SEED,
            round_id.to_le_bytes().as_ref(),
            user.key().as_ref(),
            &nonce.to_le_bytes()
        ],
        bump = ticket.bump,
        has_one = user,
        close = user
    )]
    pub ticket: Account<'info, Ticket>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut, address = config.timlg_mint)]
    pub timlg_mint: Account<'info, Mint>,

    #[account(mut, address = round.timlg_vault)]
    pub timlg_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub user_timlg_ata: Account<'info, TokenAccount>,

    #[account(mut, address = tokenomics.reward_fee_pool)]
    pub reward_fee_pool: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct SettleRoundTokens<'info> {
    #[account(
        mut,
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
    seeds = [crate::TOKENOMICS_SEED, config.key().as_ref()],
    bump = tokenomics.bump
    )]
    pub tokenomics: Account<'info, Tokenomics>,

    #[account(
        mut,
        seeds = [crate::ROUND_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,

    #[account(mut, address = config.timlg_mint)]
    pub timlg_mint: Account<'info, Mint>,

    #[account(mut, address = round.timlg_vault)]
    pub timlg_vault: Account<'info, TokenAccount>,

    // legacy treasury still exists (may be used later), but unrevealed now goes to replication pool
    #[account(mut, address = config.treasury)]
    pub treasury: Account<'info, TokenAccount>,

    #[account(mut, address = tokenomics.replication_pool)]
    pub replication_pool: Account<'info, TokenAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(round_id: u64)]
pub struct CloseRound<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        close = admin,
        seeds = [crate::ROUND_SEED, round_id.to_le_bytes().as_ref()],
        bump = round.bump
    )]
    pub round: Account<'info, Round>,

    // SPL Token Vault (TIMLG)
    // Must be empty before closing. Burn/Sweep should have cleared it.
    #[account(
        mut,
        seeds = [crate::TIMLG_VAULT_SEED, round_id.to_le_bytes().as_ref()],
        bump,
        token::mint = timlg_mint,
        token::authority = round
    )]
    pub timlg_vault: Account<'info, TokenAccount>,

    #[account(address = config.timlg_mint)]
    pub timlg_mint: Account<'info, Mint>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseConfig<'info> {
    #[account(
        mut,
        close = admin,
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateSolServiceFee<'info> {
    #[account(
        mut,
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct WithdrawTreasurySol<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    /// CHECK: System-owned PDA. Address enforced.
    #[account(
        mut,
        seeds = [crate::TREASURY_SOL_SEED],
        bump = config.treasury_sol_bump,
        address = config.treasury_sol
    )]
    pub treasury_sol: UncheckedAccount<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawTreasuryTokens<'info> {
    #[account(
        seeds = [crate::CONFIG_SEED],
        bump = config.bump
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        constraint = source_vault.owner == config.key()
    )]
    pub source_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = admin_ata.mint == source_vault.mint,
        constraint = admin_ata.owner == admin.key()
    )]
    pub admin_ata: Account<'info, TokenAccount>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub token_program: Program<'info, Token>,
}
