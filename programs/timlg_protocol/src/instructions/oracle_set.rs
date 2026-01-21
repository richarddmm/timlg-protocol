use anchor_lang::prelude::*;

use crate::{
    errors::TimlgError,
    state::{Config, OracleSet},
    InitializeOracleSet, AddOracle, RemoveOracle, SetOracleThreshold,
    MAX_ORACLES,
};

pub fn initialize_oracle_set(
    ctx: Context<InitializeOracleSet>,
    threshold: u8,
    initial_oracles: Vec<Pubkey>,
) -> Result<()> {
    let cfg: &Account<Config> = &ctx.accounts.config;
    require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), TimlgError::Unauthorized);

    require!(threshold > 0, TimlgError::InvalidThreshold);
    require!((threshold as usize) <= MAX_ORACLES, TimlgError::InvalidThreshold);
    require!(initial_oracles.len() <= MAX_ORACLES, TimlgError::OracleSetFull);

    // If an initial list is provided, threshold must be <= list length.
    if !initial_oracles.is_empty() {
        require!(
            (threshold as usize) <= initial_oracles.len(),
            TimlgError::ThresholdExceedsOracleCount
        );
    }

    // Validate uniqueness + non-default keys.
    {
        let mut seen: Vec<Pubkey> = Vec::with_capacity(initial_oracles.len());
        for pk in initial_oracles.iter() {
            require!(*pk != Pubkey::default(), TimlgError::OracleNotFound); // reuse-ish; or add a new error if you prefer
            require!(!seen.contains(pk), TimlgError::OracleAlreadyExists);
            seen.push(*pk);
        }
    }

    let os: &mut Account<OracleSet> = &mut ctx.accounts.oracle_set;
    os.admin = cfg.admin;
    os.bump = ctx.bumps.oracle_set;
    os.threshold = threshold;
    os.oracles = initial_oracles;
    os.version = 1;

    Ok(())
}

pub fn add_oracle(ctx: Context<AddOracle>, oracle: Pubkey) -> Result<()> {
    let cfg: &Account<Config> = &ctx.accounts.config;
    require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), TimlgError::Unauthorized);

    require!(oracle != Pubkey::default(), TimlgError::OracleNotFound);

    let os: &mut Account<OracleSet> = &mut ctx.accounts.oracle_set;

    require!(os.oracles.len() < MAX_ORACLES, TimlgError::OracleSetFull);
    require!(!os.oracles.contains(&oracle), TimlgError::OracleAlreadyExists);

    os.oracles.push(oracle);

    Ok(())
}

pub fn remove_oracle(ctx: Context<RemoveOracle>, oracle: Pubkey) -> Result<()> {
    let cfg: &Account<Config> = &ctx.accounts.config;
    require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), TimlgError::Unauthorized);

    let os: &mut Account<OracleSet> = &mut ctx.accounts.oracle_set;

    let pos = os.oracles.iter().position(|x| *x == oracle).ok_or(TimlgError::OracleNotFound)?;

    // Stable removal (keeps relative order).
    os.oracles.remove(pos);

    // Guard: threshold cannot exceed current oracle count (unless you set it first).
    require!(
        (os.threshold as usize) <= os.oracles.len(),
        TimlgError::ThresholdExceedsOracleCount
    );

    Ok(())
}

pub fn set_oracle_threshold(ctx: Context<SetOracleThreshold>, threshold: u8) -> Result<()> {
    let cfg: &Account<Config> = &ctx.accounts.config;
    require_keys_eq!(cfg.admin, ctx.accounts.admin.key(), TimlgError::Unauthorized);

    let os: &mut Account<OracleSet> = &mut ctx.accounts.oracle_set;

    require!(threshold > 0, TimlgError::InvalidThreshold);
    require!((threshold as usize) <= MAX_ORACLES, TimlgError::InvalidThreshold);

    // Threshold cannot be higher than allowlist size.
    require!(
        (threshold as usize) <= os.oracles.len(),
        TimlgError::ThresholdExceedsOracleCount
    );

    os.threshold = threshold;

    Ok(())
}
