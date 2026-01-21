use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};
use anchor_spl::token::{self, Transfer};

use crate::{
    errors::TimlgError,
    state::Ticket,
    utils::{
        derive_bit_index, expected_commit_msg, parse_ed25519_ix_pubkey_and_msg,
        CommitEntry, CommitSignedEntry, MAX_BATCH, TICKET_SEED,
    },
    CommitBatch, CommitBatchSigned, CommitTicket,
};

pub fn commit_ticket(
    ctx: Context<CommitTicket>,
    round_id: u64,
    nonce: u64,
    commitment: [u8; 32],
) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, TimlgError::Paused);

    let round = &mut ctx.accounts.round;
    require!(!round.finalized, TimlgError::RoundFinalized);
    require!(!round.pulse_set, TimlgError::CommitAfterPulseSet);

    let current_slot = Clock::get()?.slot;
    require!(current_slot <= round.commit_deadline_slot, TimlgError::CommitClosed);

    // --- TRANSFER stake to timlg_vault (1 ticket) ---
    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_timlg_ata.to_account_info(),
                to: ctx.accounts.timlg_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        cfg.stake_amount,
    )?;

    // --- ticket ---
    let user_pk = ctx.accounts.user.key();
    let ticket = &mut ctx.accounts.ticket;

    ticket.round_id = round.round_id;
    ticket.user = user_pk;
    ticket.nonce = nonce;
    ticket.bump = ctx.bumps.ticket;

    ticket.commitment = commitment;
    ticket.stake_paid = true;
    ticket.stake_slashed = false;
    ticket.processed = false;

    ticket.revealed = false;
    ticket.guess = 0;
    ticket.win = false;

    ticket.bit_index = derive_bit_index(round_id, &user_pk, nonce);

    ticket.claimed = false;
    ticket.claimed_slot = 0;

    ticket.created_slot = current_slot;
    ticket.revealed_slot = 0;

    // counters
    round.committed_count = round
        .committed_count
        .checked_add(1)
        .ok_or_else(|| error!(TimlgError::MathOverflow))?;

    Ok(())
}

pub fn commit_batch<'info>(
    ctx: Context<'_, '_, 'info, 'info, CommitBatch<'info>>,
    round_id: u64,
    entries: Vec<CommitEntry>,
) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, TimlgError::Paused);

    require!(entries.len() <= MAX_BATCH, TimlgError::TooManyEntries);
    require!(ctx.remaining_accounts.len() == entries.len(), TimlgError::TicketPdaMismatch);

    let round = &mut ctx.accounts.round;
    require!(!round.finalized, TimlgError::RoundFinalized);
    require!(!round.pulse_set, TimlgError::CommitAfterPulseSet);

    let current_slot = Clock::get()?.slot;
    require!(current_slot <= round.commit_deadline_slot, TimlgError::CommitClosed);

    // --- TRANSFER stake (batch) ---
    let n = entries.len() as u64;
    let total = cfg
        .stake_amount
        .checked_mul(n)
        .ok_or_else(|| error!(TimlgError::MathOverflow))?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_timlg_ata.to_account_info(),
                to: ctx.accounts.timlg_vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        total,
    )?;

    // --- crear tickets (PDA accounts) ---
    let user_pk = ctx.accounts.user.key();
    let round_le = round_id.to_le_bytes();
    let space = 8 + Ticket::INIT_SPACE;
    let lamports = Rent::get()?.minimum_balance(space);

    for (i, e) in entries.iter().enumerate() {
        let ticket_ai = ctx.remaining_accounts[i].clone();

        let nonce_le = e.nonce.to_le_bytes();
        let (expected_pda, bump) = Pubkey::find_program_address(
            &[TICKET_SEED, &round_le, user_pk.as_ref(), &nonce_le],
            ctx.program_id,
        );
        require_keys_eq!(expected_pda, *ticket_ai.key, TimlgError::TicketPdaMismatch);

        // ✅ HARDENING: si el ticket ya existe (replay), falla con error explícito
        require!(
            ticket_ai.lamports() == 0 && ticket_ai.data_is_empty(),
            TimlgError::TicketAlreadyExists
        );

        let ix = system_instruction::create_account(
            &user_pk,
            ticket_ai.key,
            lamports,
            space as u64,
            ctx.program_id,
        );

        // ✅ IMPORTANT: el PDA ticket debe “firmar” la creación
        let ticket_signer: &[&[&[u8]]] = &[&[
            TICKET_SEED,
            &round_le,
            user_pk.as_ref(),
            &nonce_le,
            &[bump],
        ]];

        invoke_signed(
            &ix,
            &[
                ctx.accounts.user.to_account_info(),
                ticket_ai.clone(),
                ctx.accounts.system_program.to_account_info(),
            ],
            ticket_signer,
        )?;

        // write Ticket data
        let mut data = ticket_ai
            .try_borrow_mut_data()
            .map_err(|_| error!(TimlgError::AccountBorrowFailed))?;

        let ticket = Ticket {
            round_id,
            user: user_pk,
            nonce: e.nonce,
            bump,
            commitment: e.commitment,
            stake_paid: true,
            stake_slashed: false,
            processed: false,
            revealed: false,
            guess: 0,
            win: false,
            bit_index: derive_bit_index(round_id, &user_pk, e.nonce),
            claimed: false,
            claimed_slot: 0,
            created_slot: current_slot,
            revealed_slot: 0,
        };

        let mut w = std::io::Cursor::new(&mut data[..]);
        ticket
            .try_serialize(&mut w)
            .map_err(|_| error!(TimlgError::TicketPdaMismatch))?;
    }

    // counters
    round.committed_count = round
        .committed_count
        .checked_add(n)
        .ok_or_else(|| error!(TimlgError::MathOverflow))?;

    Ok(())
}

pub fn commit_batch_signed<'info>(
    ctx: Context<'_, '_, 'info, 'info, CommitBatchSigned<'info>>,
    round_id: u64,
    entries: Vec<CommitSignedEntry>,
) -> Result<()> {
    let cfg = &ctx.accounts.config;
    require!(!cfg.paused, TimlgError::Paused);

    require!(entries.len() <= MAX_BATCH, TimlgError::TooManyEntries);
    require!(ctx.remaining_accounts.len() == entries.len(), TimlgError::TicketPdaMismatch);

    let round = &mut ctx.accounts.round;
    require!(!round.finalized, TimlgError::RoundFinalized);
    require!(!round.pulse_set, TimlgError::CommitAfterPulseSet);

    let current_slot = Clock::get()?.slot;
    require!(current_slot <= round.commit_deadline_slot, TimlgError::CommitClosed);

    // --- signed batch must be for a single user (ctx.accounts.user) ---
    let user_pk = ctx.accounts.user.key();
    for e in entries.iter() {
        require_keys_eq!(e.user, user_pk, TimlgError::SignedBatchMixedUsers);
    }

    // --- ed25519 introspection: expects N ed25519 verify ix immediately before this ix ---
    let ix_sys = ctx.accounts.instructions.to_account_info();
    let current_ix = load_current_index_checked(&ix_sys)? as usize;
    require!(current_ix >= entries.len(), TimlgError::MissingOrInvalidEd25519Ix);
    let first_ed_ix = current_ix - entries.len();

    for (i, e) in entries.iter().enumerate() {
        let ix = load_instruction_at_checked(first_ed_ix + i, &ix_sys)
            .map_err(|_| error!(TimlgError::MissingOrInvalidEd25519Ix))?;

        let (pk, msg) = parse_ed25519_ix_pubkey_and_msg(&ix)?;
        require_keys_eq!(pk, e.user, TimlgError::Ed25519PubkeyMismatch);

        let expected =
            expected_commit_msg(ctx.program_id, round_id, &e.user, e.nonce, &e.commitment);
        require!(msg == expected, TimlgError::Ed25519MessageMismatch);
    }

    // --- PRECHECK: validate PDAs + reject replay BEFORE moving funds ---
    let round_le = round_id.to_le_bytes();
    for (i, e) in entries.iter().enumerate() {
        let ticket_ai = ctx.remaining_accounts[i].clone();

        let nonce_le = e.nonce.to_le_bytes();
        let (expected_pda, _bump) = Pubkey::find_program_address(
            &[TICKET_SEED, &round_le, user_pk.as_ref(), &nonce_le],
            ctx.program_id,
        );
        require_keys_eq!(expected_pda, *ticket_ai.key, TimlgError::TicketPdaMismatch);

        // ✅ if it already exists, stop now (replay) -> deterministic error
        require!(
            ticket_ai.lamports() == 0 && ticket_ai.data_is_empty(),
            TimlgError::TicketAlreadyExists
        );
    }

    // --- TRANSFER stake from escrow -> timlg_vault (batch) ---
    let n = entries.len() as u64;
    let total = cfg
        .stake_amount
        .checked_mul(n)
        .ok_or_else(|| error!(TimlgError::MathOverflow))?;

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.user_escrow_ata.to_account_info(),
                to: ctx.accounts.timlg_vault.to_account_info(),
                authority: ctx.accounts.user_escrow.to_account_info(),
            },
        )
        .with_signer(&[&[
            crate::USER_ESCROW_SEED,
            user_pk.as_ref(),
            &[ctx.accounts.user_escrow.bump],
        ]]),
        total,
    )?;

    // --- create ticket PDA accounts (payer = relayer/payer) ---
    let payer_pk = ctx.accounts.payer.key();
    let space = 8 + Ticket::INIT_SPACE;
    let lamports = Rent::get()?.minimum_balance(space);

    for (i, e) in entries.iter().enumerate() {
        let ticket_ai = ctx.remaining_accounts[i].clone();

        let nonce_le = e.nonce.to_le_bytes();
        let (expected_pda, bump) = Pubkey::find_program_address(
            &[TICKET_SEED, &round_le, user_pk.as_ref(), &nonce_le],
            ctx.program_id,
        );
        require_keys_eq!(expected_pda, *ticket_ai.key, TimlgError::TicketPdaMismatch);

        // This should still hold, but keep as defense in depth.
        require!(
            ticket_ai.lamports() == 0 && ticket_ai.data_is_empty(),
            TimlgError::TicketAlreadyExists
        );

        let ix = system_instruction::create_account(
            &payer_pk,
            ticket_ai.key,
            lamports,
            space as u64,
            ctx.program_id,
        );

        let ticket_signer: &[&[&[u8]]] = &[&[
            TICKET_SEED,
            &round_le,
            user_pk.as_ref(),
            &nonce_le,
            &[bump],
        ]];

        invoke_signed(
            &ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ticket_ai.clone(),
                ctx.accounts.system_program.to_account_info(),
            ],
            ticket_signer,
        )?;

        let mut data = ticket_ai
            .try_borrow_mut_data()
            .map_err(|_| error!(TimlgError::AccountBorrowFailed))?;

        let ticket = Ticket {
            round_id,
            user: user_pk,
            nonce: e.nonce,
            bump,
            commitment: e.commitment,
            stake_paid: true,
            stake_slashed: false,
            processed: false,
            revealed: false,
            guess: 0,
            win: false,
            bit_index: derive_bit_index(round_id, &user_pk, e.nonce),
            claimed: false,
            claimed_slot: 0,
            created_slot: current_slot,
            revealed_slot: 0,
        };

        let mut w = std::io::Cursor::new(&mut data[..]);
        ticket
            .try_serialize(&mut w)
            .map_err(|_| error!(TimlgError::TicketPdaMismatch))?;
    }

    round.committed_count = round
        .committed_count
        .checked_add(n)
        .ok_or_else(|| error!(TimlgError::MathOverflow))?;

    Ok(())
}
