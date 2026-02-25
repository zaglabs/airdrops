#![allow(unexpected_cfgs)]

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

declare_id!("HXdbLyrXemG2rSx4YX81Sqt177kZSUB3R9U3K3QMuCm7");

/// Only this pubkey may call create_instance. Replace with your deployer/DAO before build.
pub const INSTANCE_AUTHORITY: Pubkey = pubkey!("CrNCQQWMAU7Ss4gs87bBMR2cZ2yWuVuQ2sS5wgdqCErD");

// Constants for ed25519 instruction layout (indices assumed 0xFFFF — data in same instruction)
const ED25519_OFFSETS_SIZE: usize = 14; // one offset entry: 7 * u16
const ED25519_SIGNATURE_SIZE: usize = 64;
const ED25519_PUBKEY_SIZE: usize = 32;

#[program]
pub mod airdrop {
    use super::*;

    pub fn create_airdrop(
        ctx: Context<CreateAirdrop>,
        total_amount: u64,
        vouchers_size_bits: u32,
    ) -> Result<()> {
        require!(total_amount > 0, AirdropError::InsufficientFunds);
        require!(vouchers_size_bits > 0, AirdropError::InvalidVouchersSize);
        require!(vouchers_size_bits <= 1000000, AirdropError::InvalidVouchersSize);

        let airdrop = &mut *ctx.accounts.airdrop;
        airdrop.creator = ctx.accounts.creator.key();
        airdrop.mint = ctx.accounts.mint.key();
        airdrop.total_amount = total_amount;
        airdrop.claimed_amount = 0;
        airdrop.bump = ctx.bumps.airdrop;
        airdrop.nonce = ctx.accounts.nonce.key();
        airdrop.backend = ctx.accounts.backend.key();
        airdrop.paused = false;
        airdrop.instance_config = ctx.accounts.instance_config.key();

        let bitmap_bytes = ((vouchers_size_bits + 7) / 8) as usize; // round up to full bytes
        let replay_bitmap = &mut *ctx.accounts.replay_bitmap;

        replay_bitmap.size_bits = vouchers_size_bits;
        replay_bitmap.bits = vec![0u8; bitmap_bytes]; // initialize all bits to 0

        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.as_ref().clone(),
                TransferChecked {
                    from: ctx.accounts.creator_ata.to_account_info(),
                    to: ctx.accounts.pda_ata.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            total_amount,
            ctx.accounts.mint.decimals,
        )?;

        let fee_amount = ctx.accounts.instance_config.fee_lamports;
        if fee_amount > 0 {
            anchor_lang::system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    anchor_lang::system_program::Transfer {
                        from: ctx.accounts.creator.to_account_info(),
                        to: ctx.accounts.fee_recipient.to_account_info(),
                    },
                ),
                fee_amount,
            )?;
        }

        Ok(())
    } 

    pub fn create_instance(ctx: Context<CreateInstance>, fee_lamports: u64) -> Result<()> {
        ctx.accounts.instance_config.admin = ctx.accounts.admin.key();
        ctx.accounts.instance_config.fee_recipient = ctx.accounts.fee_recipient.key();
        ctx.accounts.instance_config.fee_lamports = fee_lamports;
        Ok(())
    }

    /// INSTANCE_AUTHORITY only: close an instance PDA and reclaim rent. Use before recreating
    /// an instance with the same fee_recipient (e.g. after a layout change). Does not deserialize
    /// the account, so safe for old layouts. No-op if the instance does not exist (0 lamports).
    pub fn close_instance(ctx: Context<CloseInstance>) -> Result<()> {
        let lamports = ctx.accounts.instance_config.lamports();
        if lamports == 0 {
            return Ok(());
        }
        ctx.accounts.instance_config.sub_lamports(lamports)?;
        ctx.accounts.authority.add_lamports(lamports)?;
        Ok(())
    }

    /// Instance admin only: update the fee_lamports for this instance.
    pub fn update_instance(ctx: Context<UpdateInstance>, fee_lamports: u64) -> Result<()> {
        ctx.accounts.instance_config.fee_lamports = fee_lamports;
        Ok(())
    }

    /// claim a variable amount specified by the caller
    /// `voucher` is NOT used directly on-chain; instead the client places an
    /// ed25519 verify instruction earlier in the same transaction which the
    /// program inspects via the `sysvar::instructions` sysvar.
    /// The amount must be included in the signed voucher message to prevent
    /// users from claiming more than authorized.
    pub fn claim(ctx: Context<Claim>, amount: u64, nonce: u64, expiry: i64) -> Result<()> {
        let creator_ata = &ctx.accounts.pda_ata;

        require_keys_eq!(
            creator_ata.mint,
            ctx.accounts.airdrop.mint,
            AirdropError::InvalidMint
        );
        require!(!ctx.accounts.airdrop.paused, AirdropError::AirdropPaused);

        // 2) Ensure ed25519 instruction exists and authorizes this claimant
        // Build the exact message bytes that backend signed:
        // canonical = airdrop_pda (32) || claimant_pubkey (32) || amount (u64 LE) || nonce (u64 LE) || expiry (i64 LE)
        let mut expected_msg = Vec::with_capacity(32 + 32 + 8 + 8 + 8);
        expected_msg.extend_from_slice(&ctx.accounts.airdrop.key().to_bytes());
        expected_msg.extend_from_slice(&ctx.accounts.claimant.key().to_bytes());
        expected_msg.extend_from_slice(&amount.to_le_bytes());
        expected_msg.extend_from_slice(&nonce.to_le_bytes());
        expected_msg.extend_from_slice(&expiry.to_le_bytes());

        // 3) Inspect the instructions sysvar to find a prior ed25519 verify instruction
        let ix_sysvar = &ctx.accounts.instructions_sysvar;
        let cur_index =
            solana_program::sysvar::instructions::load_current_index_checked(ix_sysvar)?;

        // Strict parse: look for an ed25519 instruction earlier in the tx where one
        // of the signature-offset entries references exactly the backend pubkey and
        // the expected message bytes.
        let found = ed25519_instruction_contains(
            ix_sysvar,
            cur_index as u32,
            &ctx.accounts.airdrop.backend,
            &expected_msg,
        )?;
        require!(found, AirdropError::InvalidVoucher);

        // 4) Check expiry
        require!(
            expiry > Clock::get()?.unix_timestamp,
            AirdropError::VoucherExpired
        );

        // 5) Replay protection via bitmap
        let bitmap = &mut ctx.accounts.replay_bitmap;
        let bits = bitmap.size_bits as usize;
        let nonce_usize = nonce as usize;
        require!(nonce_usize < bits, AirdropError::NonceOutOfRange);

        let byte_idx = nonce_usize / 8;
        let bit_idx = (nonce_usize % 8) as u8;
        let mask: u8 = 1u8
            .checked_shl(bit_idx.into())
            .ok_or(AirdropError::Overflow)?;

        // Ensure we don't access beyond the allocated bitmap size
        require!(byte_idx < bitmap.bits.len(), AirdropError::NonceOutOfRange);

        // If bit already set -> voucher replayed
        require!(
            (bitmap.bits[byte_idx] & mask) == 0,
            AirdropError::VoucherAlreadyUsed
        );

        // Mark bit as used
        bitmap.bits[byte_idx] |= mask;

        // 6) Check available
        
        let available = ctx
            .accounts
            .airdrop
            .total_amount
            .checked_sub(ctx.accounts.airdrop.claimed_amount)
            .ok_or(AirdropError::Overflow)?;
        let mut true_amount: u64 = amount;
        if amount > available {
            true_amount = available;
        }

        // 7) Transfer tokens from PDA ATA -> user ATA using PDA authority
        let pda_seeds: &[&[u8]] = &[
            b"airdrop",
            ctx.accounts.airdrop.creator.as_ref(),
            ctx.accounts.airdrop.mint.as_ref(),
            ctx.accounts.airdrop.nonce.as_ref(),
            &[ctx.accounts.airdrop.bump],
        ];
        let signer = &[&pda_seeds[..]];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.pda_ata.to_account_info(),
            to: ctx.accounts.dest_ata.to_account_info(),
            authority: ctx.accounts.airdrop.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.as_ref().clone();
        token_interface::transfer_checked(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer),
            true_amount,
            ctx.accounts.mint.decimals,
        )?;

        let airdrop = &mut ctx.accounts.airdrop;
        if true_amount == available {
            airdrop.close(ctx.accounts.creator.to_account_info())?;
            ctx.accounts.replay_bitmap.close(ctx.accounts.creator.to_account_info())?;
            return Ok(());
        }

        airdrop.claimed_amount = airdrop
            .claimed_amount
            .checked_add(true_amount)
            .ok_or(AirdropError::Overflow)?;

        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let airdrop = &ctx.accounts.airdrop;

        let available = ctx.accounts.pda_ata.amount;
        require!(amount <= available, AirdropError::InsufficientFunds);

        let pda_seeds: &[&[u8]] = &[
            b"airdrop",
            airdrop.creator.as_ref(),
            airdrop.mint.as_ref(),
            airdrop.nonce.as_ref(),
            &[airdrop.bump],
        ];
        let signer = &[&pda_seeds[..]];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.pda_ata.to_account_info(),
            to: ctx.accounts.creator_ata.to_account_info(),
            authority: ctx.accounts.airdrop.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
        };

        let mut true_amount: u64 = amount;
        if amount == 0 {
            true_amount = available;
        };

        let cpi_program = ctx.accounts.token_program.as_ref().clone();
        token_interface::transfer_checked(
            CpiContext::new_with_signer(cpi_program, cpi_accounts, signer),
            true_amount,
            ctx.accounts.mint.decimals,
        )?;

        // add withdrawn token amount to claimed amount
        let airdrop = &mut ctx.accounts.airdrop;
        if true_amount == available {
            airdrop.close(ctx.accounts.creator.to_account_info())?;

            return Ok(());
        }

        airdrop.claimed_amount = airdrop
            .claimed_amount
            .checked_add(true_amount)
            .ok_or(AirdropError::Overflow)?;

        Ok(())
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        ctx.accounts.airdrop.paused = paused;
        Ok(())
    }

    pub fn update_backend(ctx: Context<UpdateBackend>) -> Result<()> {
        ctx.accounts.airdrop.backend = ctx.accounts.new_backend.key();
        Ok(())
    }
}

// Finds a prior ed25519 instruction (0xFFFF indices: data in same instruction) with backend pubkey and expected message.
fn ed25519_instruction_contains(
    ix_sysvar: &AccountInfo,
    cur_index: u32,
    backend_pk: &Pubkey,
    expected_msg: &[u8],
) -> Result<bool> {
    let max_index = cur_index as usize;

    for instr_idx in 0..max_index {
        let compiled = solana_program::sysvar::instructions::load_instruction_at_checked(
            instr_idx, ix_sysvar,
        )?;
        if compiled.program_id != solana_program::ed25519_program::id() {
            continue;
        }

        let data = &compiled.data;
        if data.len() < 2 + ED25519_OFFSETS_SIZE || data[0] != 1 {
            continue;
        }

        let base = 2usize;
        let sig_off = u16::from_le_bytes([data[base], data[base + 1]]) as usize;
        let pk_off = u16::from_le_bytes([data[base + 4], data[base + 5]]) as usize;
        let msg_off = u16::from_le_bytes([data[base + 8], data[base + 9]]) as usize;
        let msg_len = u16::from_le_bytes([data[base + 10], data[base + 11]]) as usize;

        if sig_off
            .checked_add(ED25519_SIGNATURE_SIZE)
            .map_or(true, |end| end > data.len())
            || pk_off
                .checked_add(ED25519_PUBKEY_SIZE)
                .map_or(true, |end| end > data.len())
            || msg_off
                .checked_add(msg_len)
                .map_or(true, |end| end > data.len())
        {
            continue;
        }

        if data[pk_off..pk_off + ED25519_PUBKEY_SIZE].ne(backend_pk.as_ref()) {
            continue;
        }
        if data[msg_off..msg_off + msg_len].ne(expected_msg) {
            continue;
        }

        return Ok(true);
    }

    Ok(false)
}

#[account]
pub struct Airdrop {
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub total_amount: u64,
    pub claimed_amount: u64,
    pub bump: u8,
    pub backend: Pubkey,
    pub nonce: Pubkey,
    pub paused: bool,
    pub instance_config: Pubkey,
}

#[account]
pub struct ReplayBitmap {
    // number of bits supported (e.g. 8192)
    pub size_bits: u32,
    // fixed length byte-array storing the bits
    pub bits: Vec<u8>,
}

/// One instance per fee recipient. PDA seeds = [b"instance", fee_recipient].
/// Admin can update fee_lamports; create_airdrop transfers fee_lamports to fee_recipient when > 0.
#[account]
pub struct InstanceConfig {
    pub admin: Pubkey,
    pub fee_recipient: Pubkey,
    pub fee_lamports: u64,
}

#[derive(Accounts)]
#[instruction(total_amount: u64, vouchers_size_bits: u32)]
pub struct CreateAirdrop<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    /// The backend pubkey that will sign claim vouchers.
    /// CHECK: This account is validated by ed25519 voucher verification in the claim function.
    pub backend: UncheckedAccount<'info>,

    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,

    /// CHECK: used as randomiser in airdrop address generation
    #[account(mut)]
    pub nonce: UncheckedAccount<'info>,

    /// Instance for this fee recipient (PDA per recipient). Fee (instance_config.fee_lamports) is transferred to fee_recipient when > 0.
    #[account(
        mut,
        seeds = [b"instance", fee_recipient.key().as_ref()],
        bump
    )]
    pub instance_config: Box<Account<'info, InstanceConfig>>,

    /// Fee recipient; must match instance_config PDA (seeds = [b"instance", fee_recipient]).
    /// CHECK: validated by instance_config PDA seeds
    #[account(mut)]
    pub fee_recipient: UncheckedAccount<'info>,

    #[account(
        init,
        payer = creator,
        space = 8 + size_of::<Airdrop>(), // 8 = Anchor discriminator
        seeds = [b"airdrop".as_ref(), creator.key().as_ref(), mint.key().as_ref(), nonce.key().as_ref()],
        bump
    )]
    pub airdrop: Box<Account<'info, Airdrop>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = airdrop,
        associated_token::token_program = token_program
    )]
    pub pda_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        init,
        seeds = [b"bitmap", airdrop.key().as_ref()],
        bump,
        payer = creator,
        space = 8 + 4 + 4 + (vouchers_size_bits as usize + 7) / 8, // 8 = discriminator, 4 = size_bits, 4 = Vec len, then bits
    )]
    pub replay_bitmap: Box<Account<'info, ReplayBitmap>>,

    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = creator,
        associated_token::token_program = token_program
    )]
    pub creator_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    /// Airdrop account
    #[account(mut, seeds = [b"airdrop", airdrop.creator.as_ref(), airdrop.mint.as_ref(), airdrop.nonce.as_ref()], bump = airdrop.bump)]
    pub airdrop: Account<'info, Airdrop>,

    /// CHECK: This is the creator account, no data needed.
    #[account(mut, address = airdrop.creator)]
    pub creator: AccountInfo<'info>,

    pub mint: InterfaceAccount<'info, Mint>,

    /// PDA's token account
    #[account(
        mut,
        associated_token::mint = airdrop.mint, 
        associated_token::authority = airdrop,
        associated_token::token_program = token_program
    )]
    pub pda_ata: InterfaceAccount<'info, TokenAccount>,

    /// Destination token account for the claimant
    #[account(
        mut,
        constraint = dest_ata.mint == airdrop.mint,
        constraint = dest_ata.owner == claimant.key()
    )]
    pub dest_ata: InterfaceAccount<'info, TokenAccount>,

    /// The claimant
    pub claimant: Signer<'info>,

    /// Replay bitmap — must be the same PDA created at `create_airdrop` time
    #[account(mut, seeds = [b"bitmap", airdrop.key().as_ref()], bump)]
    pub replay_bitmap: Account<'info, ReplayBitmap>,

    /// CHECK: This is a sysvar account that contains all instructions in the transaction.
    #[account(address = solana_program::sysvar::instructions::id())]
    pub instructions_sysvar: AccountInfo<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(amount: u64)]
pub struct Withdraw<'info> {
    #[account(mut, has_one = creator, seeds = [b"airdrop", airdrop.creator.as_ref(), airdrop.mint.as_ref(), airdrop.nonce.as_ref()], bump = airdrop.bump)]
    pub airdrop: Account<'info, Airdrop>,

    #[account(mut, address = airdrop.mint)]
    pub mint: InterfaceAccount<'info, Mint>,

    /// Instance config for this airdrop; must match airdrop.instance_config.
    #[account(mut, address = airdrop.instance_config)]
    pub instance_config: Account<'info, InstanceConfig>,

    /// Withdraw authority: only this account may call withdraw (must match instance_config.admin).
    #[account(constraint = authority.key() == instance_config.admin @ AirdropError::Unauthorized)]
    pub authority: Signer<'info>,

    /// Creator; used as close target only. Validated by has_one on airdrop.
    /// CHECK: has_one = creator ensures airdrop.creator == creator.key()
    #[account(mut, address = airdrop.creator)]
    pub creator: UncheckedAccount<'info>,

    #[account(
        mut,
        associated_token::mint = airdrop.mint,
        associated_token::authority = airdrop,
        associated_token::token_program = token_program
    )]
    pub pda_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        constraint = creator_ata.mint == airdrop.mint,
        constraint = creator_ata.owner == airdrop.creator
    )]
    pub creator_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(
        mut,
        seeds = [b"airdrop", airdrop.creator.as_ref(), airdrop.mint.as_ref(), airdrop.nonce.as_ref()],
        bump = airdrop.bump,
        has_one = creator,
    )]
    pub airdrop: Account<'info, Airdrop>,

    pub creator: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateBackend<'info> {
    #[account(
        mut,
        seeds = [b"airdrop", airdrop.creator.as_ref(), airdrop.mint.as_ref(), airdrop.nonce.as_ref()],
        bump = airdrop.bump,
        has_one = creator,
    )]
    pub airdrop: Account<'info, Airdrop>,

    pub creator: Signer<'info>,

    /// CHECK: New backend pubkey, no data needed.
    pub new_backend: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CreateInstance<'info> {
    /// Must equal INSTANCE_AUTHORITY (only this key may create instances).
    #[account(mut, address = INSTANCE_AUTHORITY)]
    pub authority: Signer<'info>,

    /// CHECK: admin account, no data needed.
    #[account()]
    pub admin: UncheckedAccount<'info>,

    /// CHECK: fee recipient; PDA seeds = [b"instance", fee_recipient.key()]
    pub fee_recipient: UncheckedAccount<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + size_of::<InstanceConfig>(),
        seeds = [b"instance", fee_recipient.key().as_ref()],
        bump
    )]
    pub instance_config: Account<'info, InstanceConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateInstance<'info> {
    #[account(
        mut,
        seeds = [b"instance", fee_recipient.key().as_ref()],
        bump,
        has_one = admin
    )]
    pub instance_config: Account<'info, InstanceConfig>,

    pub admin: Signer<'info>,

    /// CHECK: fee recipient; PDA seeds = [b"instance", fee_recipient.key()]
    pub fee_recipient: UncheckedAccount<'info>,
}

/// Close instance PDA and reclaim rent. Does not deserialize account data (safe for old layouts).
#[derive(Accounts)]
pub struct CloseInstance<'info> {
    #[account(mut, address = INSTANCE_AUTHORITY)]
    pub authority: Signer<'info>,

    /// Instance PDA; seeds constrain address so only our instance can be closed.
    /// CHECK: not deserialized (safe for old layouts); address validated by seeds
    #[account(mut, seeds = [b"instance", fee_recipient.key().as_ref()], bump)]
    pub instance_config: UncheckedAccount<'info>,

    /// CHECK: used for instance_config PDA seeds
    pub fee_recipient: UncheckedAccount<'info>,
}

#[error_code]
pub enum AirdropError {
    #[msg("Insufficient funds in airdrop")]
    InsufficientFunds,
    #[msg("Overflow error")]
    Overflow,
    #[msg("Voucher missing or invalid")]
    InvalidVoucher,
    #[msg("Voucher already used (replay detected)")]
    VoucherAlreadyUsed,
    #[msg("Nonce value out of bitmap range")]
    NonceOutOfRange,
    #[msg("Requested mint is invalid")]
    InvalidMint,
    #[msg("Voucher expired")]
    VoucherExpired,
    #[msg("Airdrop is paused")]
    AirdropPaused,
    #[msg("Vouchers size must be greater than zero")]
    InvalidVouchersSize,
    #[msg("Not authorized to perform this action")]
    Unauthorized,
}
