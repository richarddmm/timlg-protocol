use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;
pub mod utils;
pub mod contexts;
pub mod constants;

pub use utils::*;
pub use instructions::*;
pub use state::*;
pub use errors::*;
pub use contexts::*;
pub use constants::*;

use solana_security_txt::security_txt;

security_txt! {
    // Required fields
    name: "TIMLG MVP",
    project_url: "https://timlg.org",
    contacts: "email:support@timlg.org,link:https://github.com/richarddmm/timlg-protocol/issues",
    policy: "https://github.com/richarddmm/timlg-protocol/blob/main/SECURITY.md",

    // Optional fields
    preferred_languages: "en,es",
    source_code: "https://github.com/richarddmm/timlg-protocol"
}



declare_id!("GeA3JqAjAWBCoW3JVDbdTjEoxfUaSgtHuxiAeGG5PrUP");

#[program]
pub mod timlg_protocol {
    use super::*;
    use crate::instructions::{admin, oracle_set, oracle, lifecycle, commit, reveal, reward, escrow};

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        stake_amount: u64,
        commit_window_slots: u64,
        reveal_window_slots: u64,
    ) -> Result<()> {
        admin::initialize_config(
            ctx,
            stake_amount,
            commit_window_slots,
            reveal_window_slots,
        )
    }

    pub fn close_config(ctx: Context<CloseConfig>) -> Result<()> {
        instructions::admin::close_config(ctx)
    }

    pub fn set_pause(ctx: Context<SetPause>, paused: bool) -> Result<()> {
        admin::set_pause(ctx, paused)
    }

    // ----------------------------
    // OracleSet admin controls
    // ----------------------------
    pub fn initialize_oracle_set(
        ctx: Context<InitializeOracleSet>,
        threshold: u8,
        initial_oracles: Vec<Pubkey>,
    ) -> Result<()> {
        oracle_set::initialize_oracle_set(ctx, threshold, initial_oracles)
    }

    pub fn add_oracle(ctx: Context<AddOracle>, oracle: Pubkey) -> Result<()> {
        oracle_set::add_oracle(ctx, oracle)
    }

    pub fn remove_oracle(ctx: Context<RemoveOracle>, oracle: Pubkey) -> Result<()> {
        oracle_set::remove_oracle(ctx, oracle)
    }

    pub fn set_oracle_threshold(ctx: Context<SetOracleThreshold>, threshold: u8) -> Result<()> {
        oracle_set::set_oracle_threshold(ctx, threshold)
    }

    pub fn set_oracle_pubkey(ctx: Context<SetOraclePubkey>, oracle_pubkey: Pubkey) -> Result<()> {
        oracle::set_oracle_pubkey(ctx, oracle_pubkey)
    }

    pub fn create_round(
        ctx: Context<CreateRound>,
        round_id: u64,
        pulse_index_target: u64,
        commit_deadline_slot: u64,
        reveal_deadline_slot: u64,
    ) -> Result<()> {
        admin::create_round(
            ctx,
            round_id,
            pulse_index_target,
            commit_deadline_slot,
            reveal_deadline_slot,
        )
    }

    pub fn fund_vault(ctx: Context<FundVault>, round_id: u64, amount: u64) -> Result<()> {
        admin::fund_vault(ctx, round_id, amount)
    }

    #[cfg(feature = "mock-pulse")]
    pub fn set_pulse_mock(
        ctx: Context<SetPulseMock>,
        round_id: u64,
        pulse: [u8; 64],
    ) -> Result<()> {
        instructions::admin::set_pulse_mock(ctx, round_id, pulse)
    }

    pub fn set_pulse_signed(ctx: Context<SetPulseSigned>, round_id: u64, pulse: [u8; 64]) -> Result<()> {
        oracle::set_pulse_signed(ctx, round_id, pulse)
    }

    // ✅ lifecycle
    pub fn finalize_round(ctx: Context<FinalizeRound>, round_id: u64) -> Result<()> {
        lifecycle::finalize_round(ctx, round_id)
    }

    pub fn sweep_unclaimed(ctx: Context<SweepUnclaimed>, round_id: u64) -> Result<()> {
        lifecycle::sweep_unclaimed(ctx, round_id)
    }

    pub fn close_round(ctx: Context<CloseRound>, round_id: u64) -> Result<()> {
        lifecycle::close_round(ctx, round_id)
    }

    pub fn recover_funds(ctx: Context<RecoverFunds>, round_id: u64) -> Result<()> {
        lifecycle::recover_funds(ctx, round_id)
    }

    pub fn recover_funds_anyone(ctx: Context<RecoverFundsAnyone>, round_id: u64) -> Result<()> {
        lifecycle::recover_funds_anyone(ctx, round_id)
    }

    pub fn close_ticket(ctx: Context<CloseTicket>, round_id: u64, nonce: u64) -> Result<()> {
        lifecycle::close_ticket(ctx, round_id, nonce)
    }

    // core
    pub fn commit_ticket(
        ctx: Context<CommitTicket>,
        round_id: u64,
        nonce: u64,
        commitment: [u8; 32],
    ) -> Result<()> {
        commit::commit_ticket(ctx, round_id, nonce, commitment)
    }

    pub fn reveal_ticket(
        ctx: Context<RevealTicket>,
        round_id: u64,
        nonce: u64,
        guess: u8,
        salt: [u8; 32],
    ) -> Result<()> {
        reveal::reveal_ticket(ctx, round_id, nonce, guess, salt)
    }

    // ✅ FIX lifetimes: debe coincidir con commit::commit_batch
    pub fn commit_batch<'info>(
        ctx: Context<'_, '_, 'info, 'info, CommitBatch<'info>>,
        round_id: u64,
        entries: Vec<CommitEntry>,
    ) -> Result<()> {
        commit::commit_batch(ctx, round_id, entries)
    }

    pub fn reveal_batch<'info>(
        ctx: Context<'_, '_, '_, 'info, RevealBatch<'info>>,
        round_id: u64,
        entries: Vec<RevealEntry>,
    ) -> Result<()> {
        reveal::reveal_batch(ctx, round_id, entries)
    }

    pub fn commit_batch_signed<'info>(
        ctx: Context<'_, '_, 'info, 'info, CommitBatchSigned<'info>>,
        round_id: u64,
        entries: Vec<CommitSignedEntry>,
    ) -> Result<()> {
        commit::commit_batch_signed(ctx, round_id, entries)
    }

    pub fn reveal_batch_signed<'info>(
        ctx: Context<'_, '_, 'info, 'info, RevealBatchSigned<'info>>,
        round_id: u64,
        entries: Vec<RevealSignedEntry>,
    ) -> Result<()> {
        reveal::reveal_batch_signed(ctx, round_id, entries)
    }

    pub fn claim_reward(ctx: Context<ClaimReward>, round_id: u64, nonce: u64) -> Result<()> {
        reward::claim_reward(ctx, round_id, nonce)
    }

    pub fn set_claim_grace_slots(ctx: Context<SetClaimGraceSlots>, claim_grace_slots: u64) -> Result<()> {
        admin::set_claim_grace_slots(ctx, claim_grace_slots)
    }

    pub fn update_stake_amount(ctx: Context<UpdateStakeAmount>, new_stake_amount: u64) -> Result<()> {
        admin::update_stake_amount(ctx, new_stake_amount)
    }

    pub fn init_user_escrow(ctx: Context<InitUserEscrow>) -> Result<()> {
        escrow::init_user_escrow(ctx)
    }

    pub fn deposit_escrow(ctx: Context<DepositEscrow>, amount: u64) -> Result<()> {
        escrow::deposit_escrow(ctx, amount)
    }

    pub fn withdraw_escrow(ctx: Context<WithdrawEscrow>, amount: u64) -> Result<()> {
        escrow::withdraw_escrow(ctx, amount)
    }

    // ✅ FIX lifetimes: debe coincidir con lifecycle::settle_round_tokens
    pub fn settle_round_tokens<'info>(
        ctx: Context<'_, '_, 'info, 'info, SettleRoundTokens<'info>>,
        round_id: u64,
    ) -> Result<()> {
        lifecycle::settle_round_tokens(ctx, round_id)
    }

    pub fn initialize_round_registry(ctx: Context<InitializeRoundRegistry>, start_round_id: u64) -> Result<()> {
        instructions::admin::initialize_round_registry(ctx, start_round_id)
    }

    pub fn create_round_auto(
        ctx: Context<CreateRoundAuto>,
        pulse_index_target: u64,
        commit_deadline_slot: u64,
        reveal_deadline_slot: u64,
    ) -> Result<()> {
        instructions::admin::create_round_auto(ctx, pulse_index_target, commit_deadline_slot, reveal_deadline_slot)
    }

    pub fn initialize_tokenomics(
        ctx: Context<InitializeTokenomics>,
        reward_fee_bps: u16,
    ) -> Result<()> {
        admin::initialize_tokenomics(ctx, reward_fee_bps)
    }

    pub fn update_tokenomics(
        ctx: Context<UpdateTokenomics>,
        reward_fee_bps: u16,
    ) -> Result<()> {
        admin::update_tokenomics(ctx, reward_fee_bps)
    }

}
