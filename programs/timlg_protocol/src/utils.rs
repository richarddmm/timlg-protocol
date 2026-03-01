use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use solana_sha256_hasher::hashv;

// Ed25519SigVerify111111111111111111111111111
pub fn ed25519_program_id() -> Pubkey {
    Pubkey::new_from_array([
        3, 125, 70, 214, 124, 147, 251, 190, 18, 249, 66, 143, 131, 141, 64, 255,
        5, 112, 116, 73, 39, 244, 138, 100, 252, 202, 112, 68, 128, 0, 0, 0,
    ])
}


use crate::{
    errors::TimlgError,
    state::{Round, Ticket},
};

// -----------------
// Seeds / constants
// -----------------
pub const ROUND_REGISTRY_SEED: &[u8] = b"round_registry_v3";

pub const CONFIG_SEED: &[u8] = b"config_v3";
pub const ROUND_SEED: &[u8] = b"round_v3";
pub const VAULT_SEED: &[u8] = b"vault_v3";
pub const TICKET_SEED: &[u8] = b"ticket_v3";

pub const TREASURY_SEED: &[u8] = b"treasury_v3";
pub const TIMLG_VAULT_SEED: &[u8] = b"timlg_vault_v3";
pub const TREASURY_SOL_SEED: &[u8] = b"treasury_sol_v3";

pub const MAX_BATCH: usize = 16;

pub const USER_ESCROW_SEED: &[u8] = b"user_escrow_v3";
pub const USER_ESCROW_VAULT_SEED: &[u8] = b"user_escrow_vault_v3";

// OracleSet
pub const ORACLE_SET_SEED: &[u8] = b"oracle_set_v3";
pub const MAX_ORACLES: usize = 16;

// Tokenomics
pub const TOKENOMICS_SEED: &[u8] = b"tokenomics_v3";
pub const REWARD_FEE_POOL_SEED: &[u8] = b"reward_fee_pool_v3";
pub const REPLICATION_POOL_SEED: &[u8] = b"replication_pool_v3";


// ---------------
// Batch payloads
// ---------------
#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CommitEntry {
    pub nonce: u64,
    pub commitment: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RevealEntry {
    pub nonce: u64,
    pub guess: u8,      // 0/1
    pub salt: [u8; 32], // 32 bytes
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CommitSignedEntry {
    pub user: Pubkey,
    pub nonce: u64,
    pub commitment: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RevealSignedEntry {
    pub user: Pubkey,
    pub nonce: u64,
    pub guess: u8,
    pub salt: [u8; 32],
}

// -------------------------
// Shared reveal logic
// -------------------------
pub fn reveal_core(
    round: &Round,
    ticket: &mut Ticket,
    user_pk: Pubkey,
    round_id: u64,
    nonce: u64,
    guess: u8,
    salt: [u8; 32],
    current_slot: u64,
) -> Result<()> {
    let computed = commit_hash(round_id, &user_pk, nonce, guess, &salt);
    require!(computed == ticket.commitment, TimlgError::CommitmentMismatch);

    let derived = derive_bit_index(round_id, &user_pk, nonce);
    require!(ticket.bit_index == derived, TimlgError::BitIndexMismatch);

    let bit = get_pulse_bit(&round.pulse, ticket.bit_index);

    ticket.revealed = true;
    ticket.guess = guess;
    ticket.win = bit == guess;
    ticket.revealed_slot = current_slot;

    Ok(())
}

// -------------------------
// Derive bit index
// -------------------------
pub fn derive_bit_index(round_id: u64, user: &Pubkey, nonce: u64) -> u16 {
    let h = hashv(&[
        b"bitindex".as_ref(),
        round_id.to_le_bytes().as_ref(),
        user.as_ref(),
        nonce.to_le_bytes().as_ref(),
    ])
    .to_bytes();

    u16::from_le_bytes([h[0], h[1]]) % 512
}

#[cfg(test)]
mod consistency_tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn test_bit_index_consistency() {
        let round_id: u64 = 37000;
        let user = Pubkey::from_str("3ubbYD5VrSpQQW1GLWubkH9owvZK5GZVjvBnoADZSxpo").unwrap();
        let nonce: u64 = 12345678;
        
        // Manual trace
        let h = solana_sha256_hasher::hashv(&[
            b"bitindex".as_ref(),
            round_id.to_le_bytes().as_ref(),
            user.as_ref(),
            nonce.to_le_bytes().as_ref(),
        ]).to_bytes();
        println!("Rust Hash Bytes: {:?}", &h[0..8]);
        
        let idx = derive_bit_index(round_id, &user, nonce);
        println!("Rust Bit Index: {}", idx);
    }
}

// -------------------------
// Commit hash + pulse bit
// -------------------------
pub fn commit_hash(
    round_id: u64,
    user: &Pubkey,
    nonce: u64,
    guess: u8,
    salt: &[u8; 32],
) -> [u8; 32] {
    let h = hashv(&[
        b"commit".as_ref(),
        round_id.to_le_bytes().as_ref(),
        user.as_ref(),
        nonce.to_le_bytes().as_ref(),
        &[guess],
        salt.as_ref(),
    ]);
    h.to_bytes()
}

pub fn get_pulse_bit(pulse: &[u8; 64], bit_index: u16) -> u8 {
    let idx = bit_index as usize;
    let byte_i = idx / 8;
    let bit_i = idx % 8;
    ((pulse[byte_i] >> bit_i) & 1) as u8
}

// -------------------------
// Signed commit message + ed25519 parsing
// -------------------------
pub fn expected_commit_msg(
    program_id: &Pubkey,
    round_id: u64,
    user: &Pubkey,
    nonce: u64,
    commitment: &[u8; 32],
) -> Vec<u8> {
    let mut v = Vec::new();
    v.extend_from_slice(b"timlg-protocol:commit_v1");
    v.extend_from_slice(program_id.as_ref());
    v.extend_from_slice(&round_id.to_le_bytes());
    v.extend_from_slice(user.as_ref());
    v.extend_from_slice(&nonce.to_le_bytes());
    v.extend_from_slice(commitment);
    v
}

pub fn parse_ed25519_ix_pubkey_and_msg(ix: &Instruction) -> Result<(Pubkey, Vec<u8>)> {
    require!(
        ix.program_id == ed25519_program_id(),
        TimlgError::MissingOrInvalidEd25519Ix
    );

    let data = &ix.data;
    require!(data.len() >= 16, TimlgError::MissingOrInvalidEd25519Ix);

    let num_sigs = data[0];
    require!(num_sigs == 1, TimlgError::MissingOrInvalidEd25519Ix);

    // Require "self-contained" offsets (instruction_index == u16::MAX)
    let sig_ix = u16::from_le_bytes([data[4], data[5]]);
    let pk_ix = u16::from_le_bytes([data[8], data[9]]);
    let msg_ix = u16::from_le_bytes([data[14], data[15]]);
    require!(sig_ix == u16::MAX, TimlgError::MissingOrInvalidEd25519Ix);
    require!(pk_ix == u16::MAX, TimlgError::MissingOrInvalidEd25519Ix);
    require!(msg_ix == u16::MAX, TimlgError::MissingOrInvalidEd25519Ix);

    let pk_off = u16::from_le_bytes([data[6], data[7]]) as usize;
    let msg_off = u16::from_le_bytes([data[10], data[11]]) as usize;
    let msg_sz = u16::from_le_bytes([data[12], data[13]]) as usize;

    require!(pk_off + 32 <= data.len(), TimlgError::MissingOrInvalidEd25519Ix);
    require!(msg_off + msg_sz <= data.len(), TimlgError::MissingOrInvalidEd25519Ix);

    let pk_bytes: [u8; 32] = data[pk_off..pk_off + 32]
        .try_into()
        .map_err(|_| error!(TimlgError::MissingOrInvalidEd25519Ix))?;
    let msg = data[msg_off..msg_off + msg_sz].to_vec();

    Ok((Pubkey::new_from_array(pk_bytes), msg))
}

// -------------------------
// Expected reveal msg + ed25519 parsing
// -------------------------
pub fn expected_reveal_msg(
    program_id: &Pubkey,
    round_id: u64,
    user: &Pubkey,
    nonce: u64,
    guess: u8,
    salt: &[u8; 32],
) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"timlg-protocol:reveal_v1");
    out.extend_from_slice(program_id.as_ref());
    out.extend_from_slice(&round_id.to_le_bytes());
    out.extend_from_slice(user.as_ref());
    out.extend_from_slice(&nonce.to_le_bytes());
    out.push(guess);
    out.extend_from_slice(salt);
    out
}

// -------------------------
// MVP-2: Expected oracle pulse msg
// -------------------------
pub fn expected_pulse_msg(
    program_id: &Pubkey,
    round_id: u64,
    pulse_index_target: u64,
    pulse: &[u8; 64],
) -> Vec<u8> {
    let mut out = Vec::with_capacity(b"timlg-protocol:pulse_v1".len() + 32 + 8 + 8 + 64);
    out.extend_from_slice(b"timlg-protocol:pulse_v1");
    out.extend_from_slice(program_id.as_ref());
    out.extend_from_slice(&round_id.to_le_bytes());
    out.extend_from_slice(&pulse_index_target.to_le_bytes());
    out.extend_from_slice(pulse);
    out
}

pub fn assert_ed25519_ix_matches(
    ix: &anchor_lang::solana_program::instruction::Instruction,
    expected_pubkey: &Pubkey,
    expected_msg: &[u8],
) -> Result<()> {
    // Reusa el parser "seguro" que ya exige offsets self-contained
    // (signature_instruction_index == pubkey_instruction_index == message_instruction_index == u16::MAX)
    let (pk, msg) = parse_ed25519_ix_pubkey_and_msg(ix)?;

    require_keys_eq!(pk, *expected_pubkey, TimlgError::Ed25519PubkeyMismatch);
    require!(msg.as_slice() == expected_msg, TimlgError::Ed25519MessageMismatch);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::instruction::Instruction;

    fn u16le(v: u16) -> [u8; 2] {
        v.to_le_bytes()
    }

    /// Construye un "ed25519-like instruction data" con el layout estándar:
    /// [num_sigs: u8, padding: u8, offsets(14 bytes), signature(64), pubkey(32), msg(N)]
    ///
    /// OJO: aquí NO estamos generando una firma válida; para estos tests sólo nos interesa
    /// comprobar que el parser rechaza instruction_index != u16::MAX.
    fn make_ed25519_ix(pubkey: [u8; 32], msg: &[u8], sig_ix: u16, pk_ix: u16, msg_ix: u16) -> Instruction {
        let header_len: usize = 2 + 14; // 16
        let sig_off: u16 = header_len as u16;
        let pk_off: u16 = sig_off + 64;
        let msg_off: u16 = pk_off + 32;
        let msg_sz: u16 = msg
            .len()
            .try_into()
            .expect("message too long for u16 size in this test");

        let total_len = header_len + 64 + 32 + msg.len();
        let mut data = vec![0u8; total_len];

        // num signatures + padding
        data[0] = 1;
        data[1] = 0;

        // offsets struct starts at byte 2
        let o = 2usize;

        // signature_offset
        data[o + 0..o + 2].copy_from_slice(&u16le(sig_off));
        // signature_instruction_index
        data[o + 2..o + 4].copy_from_slice(&u16le(sig_ix));

        // public_key_offset
        data[o + 4..o + 6].copy_from_slice(&u16le(pk_off));
        // public_key_instruction_index
        data[o + 6..o + 8].copy_from_slice(&u16le(pk_ix));

        // message_data_offset
        data[o + 8..o + 10].copy_from_slice(&u16le(msg_off));
        // message_data_size
        data[o + 10..o + 12].copy_from_slice(&u16le(msg_sz));
        // message_instruction_index
        data[o + 12..o + 14].copy_from_slice(&u16le(msg_ix));

        // signature bytes: dejamos 0s (no se verifica en estos tests)
        let sig_start = sig_off as usize;
        let pk_start = pk_off as usize;
        let msg_start = msg_off as usize;

        // pubkey
        data[pk_start..pk_start + 32].copy_from_slice(&pubkey);

        // msg
        data[msg_start..msg_start + msg.len()].copy_from_slice(msg);

        Instruction {
            program_id: ed25519_program_id(),
            accounts: vec![],
            data,
        }
    }

    #[test]
    fn parse_ed25519_accepts_self_contained_indices() {
        let user = Pubkey::new_unique();
        let msg = b"hello-world".to_vec();

        let ix = make_ed25519_ix(user.to_bytes(), &msg, u16::MAX, u16::MAX, u16::MAX);

        let (pk, parsed_msg) = parse_ed25519_ix_pubkey_and_msg(&ix).expect("should parse");
        assert_eq!(pk, user);
        assert_eq!(parsed_msg, msg);
    }

    #[test]
    fn parse_ed25519_rejects_external_message_instruction_index() {
        let user = Pubkey::new_unique();
        let msg = b"evil-msg".to_vec();

        // msg_ix != u16::MAX => debería fallar
        let ix = make_ed25519_ix(user.to_bytes(), &msg, u16::MAX, u16::MAX, 0);

        let res = parse_ed25519_ix_pubkey_and_msg(&ix);
        assert!(res.is_err(), "parser must reject non-self-contained msg_ix");
    }

    #[test]
    fn assert_ed25519_ix_matches_rejects_external_message_instruction_index() {
        let user = Pubkey::new_unique();
        let msg = b"evil-msg-2".to_vec();

        let ix = make_ed25519_ix(user.to_bytes(), &msg, u16::MAX, u16::MAX, 7);

        let res = assert_ed25519_ix_matches(&ix, &user, &msg);
        assert!(res.is_err(), "assert must reject non-self-contained msg_ix");
    }

    #[test]
    fn assert_ed25519_ix_matches_rejects_wrong_pubkey_or_msg() {
        let user = Pubkey::new_unique();
        let other = Pubkey::new_unique();
        let msg = b"good".to_vec();

        let ix = make_ed25519_ix(user.to_bytes(), &msg, u16::MAX, u16::MAX, u16::MAX);

        // pubkey mismatch
        let res_pk = assert_ed25519_ix_matches(&ix, &other, &msg);
        assert!(res_pk.is_err());

        // msg mismatch
        let res_msg = assert_ed25519_ix_matches(&ix, &user, b"bad");
        assert!(res_msg.is_err());
    }
}
