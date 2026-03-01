use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct RoundRegistry {
    pub admin: Pubkey,
    pub bump: u8,
    pub next_round_id: u64,
    pub version: u16,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub bump: u8,

    pub stake_amount: u64,
    pub commit_window_slots: u64,
    pub reveal_window_slots: u64,

    // MVP-3.1: grace period for claims before sweeping vault
    pub claim_grace_slots: u64,

    // MVP-2: oracle pubkey allowed to set pulse via ed25519 introspection
    pub oracle_pubkey: Pubkey,

    pub paused: bool,
    pub version: u16,

    // MVP-2: TIMLG SPL
    pub timlg_mint: Pubkey,

    // Treasury SPL (pool TIMLG)
    pub treasury: Pubkey,
    pub treasury_bump: u8,

    // ✅ NUEVO: Treasury SOL (lamports) separado
    pub treasury_sol: Pubkey,
    pub treasury_sol_bump: u8,

    // ✅ NUEVO: Tasa de servicio en SOL por ticket (lamports)
    pub sol_service_fee_lamports: u64,
}

#[account]
#[derive(InitSpace)]
pub struct OracleSet {
    pub admin: Pubkey,
    pub bump: u8,

    /// Minimum number of oracle attestations required (PR2 will consume this).
    pub threshold: u8,

    /// Allowlisted oracle pubkeys.
    /// NOTE: fixed max_len to keep account size deterministic.
    #[max_len(16)]
    pub oracles: Vec<Pubkey>,

    pub version: u16,
}

#[account]
#[derive(InitSpace)]
pub struct UserEscrow {
    pub user: Pubkey,
    pub bump: u8,
    pub created_slot: u64,
    pub updated_slot: u64,
}

#[repr(u8)]
pub enum RoundState {
    Announced = 0,
    PulseSet = 1,
    Finalized = 2,
}

#[account]
#[derive(InitSpace)]
pub struct Round {
    pub round_id: u64,
    pub bump: u8,
    pub state: u8,

    // System-owned PDA vault (holds lamports, no data)
    pub vault: Pubkey,
    pub vault_bump: u8,

    pub pulse_index_target: u64,
    pub commit_deadline_slot: u64,
    pub reveal_deadline_slot: u64,
    pub created_slot: u64,

    pub pulse_set: bool,
    pub pulse: [u8; 64], // 512 bits
    pub pulse_set_slot: u64,

    // MVP-2.2 lifecycle
    pub finalized: bool,
    pub finalized_slot: u64,

    // MVP-3.1b: sweep guard (SOL vault sweep)
    pub swept: bool,
    pub swept_slot: u64,

    // SPL token vault (TIMLG) per round
    pub timlg_vault: Pubkey,
    pub timlg_vault_bump: u8,

    // ===== Etapa 2 (economía) =====
    pub committed_count: u64,
    pub revealed_count: u64,
    pub win_count: u64,

    // NEW: number of tickets processed by settlement (winners/losers/unrevealed)
    // removed: settled variables for lazy evaluation architecture
}

#[account]
#[derive(InitSpace)]
pub struct Ticket {
    pub round_id: u64,
    pub user: Pubkey,
    pub nonce: u64,
    pub bump: u8,

    pub commitment: [u8; 32],

    // stake fue realmente aportado (transfer a vault)
    pub stake_paid: bool,

    // stake ya fue liquidado por settle (burn o treasury) → idempotencia
    pub stake_slashed: bool,

    // el ticket ya fue procesado por settlement (incluye winners)
    // processed field removed for lazy evaluation

    pub revealed: bool,
    pub guess: u8,
    pub win: bool,

    // derived on commit and must match on reveal
    pub bit_index: u16,

    // reward claim guard
    pub claimed: bool,
    pub claimed_slot: u64,

    pub created_slot: u64,
    pub revealed_slot: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Tokenomics {
    pub admin: Pubkey,
    pub bump: u8,

    /// Fee charged on minted rewards (basis points). 100 = 1%.
    pub reward_fee_bps: u16,

    /// SPL TokenAccount PDAs (TIMLG mint)
    pub reward_fee_pool: Pubkey,
    pub reward_fee_pool_bump: u8,

    pub replication_pool: Pubkey,
    pub replication_pool_bump: u8,

    pub version: u16,
}
