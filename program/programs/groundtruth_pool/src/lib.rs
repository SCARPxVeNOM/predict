//! Groundtruth parimutuel pools.
//!
//! One market per TxLINE `terms_hash` (sha256 of the borsh-encoded market
//! terms). Users stake devnet USDT on YES or NO. After the deciding batch
//! root is on-chain, ANYONE may resolve the market by submitting the Merkle
//! proof bundle; the program CPIs into the TxLINE `txoracle` program's
//! `validate_stat` (read-only proof check against the posted daily root) and
//! stores the outcome. Because a proof only shows the stat AT ONE record, a
//! dispute window follows: a proof anchored at a strictly later record ts
//! supersedes the outcome. After the window closes, winners claim
//! stake + pro-rata share of the losing pool.
//!
//! No admin can move funds; resolution authority is the proof itself.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::Instruction,
    program::{get_return_data, invoke},
};
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("B3XJrPdtvDRpnwNyk6s633WNrwJed2jJCKrE3Xuwn537");

/// TxLINE txoracle program (Solana devnet).
pub const TXORACLE_ID: Pubkey = pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");
/// Devnet USDT mint used by the txoracle faucet.
pub const USDT_MINT: Pubkey = pubkey!("ELWTKspHKCnCfCiCiqYw1EDH77k8VCP74dK9qytG2Ujh");
/// Anchor discriminator of txoracle's `validate_stat` (from its IDL v1.5.5).
const VALIDATE_STAT_DISC: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];

/// How long a first resolution can be superseded by later evidence.
pub const DISPUTE_WINDOW_SECS: i64 = 30 * 60;

/// A market settles only against a FINAL record. TxLINE tags each proof leaf
/// with the record's phase: mid-match records carry the phase id (1..19,
/// e.g. H1=2, ET2=9), the end-of-match normalized-totals record carries the
/// market's own period (0), and a post-match archival record (posted ~5 min
/// after full time, and after extra time / penalties the ONLY record whose
/// proof still validates against the retipped daily root) carries a period at
/// or above this floor (observed 100). Accepting >= this floor lets an
/// extra-time / penalty match settle by proof, while still rejecting every
/// mid-match record so a market can never settle before full time.
const FINAL_PERIOD_FLOOR: i32 = 20;

#[program]
pub mod groundtruth_pool {
    use super::*;

    /// Create a market for the given terms. Permissionless; the PDA is keyed
    /// by terms_hash, so a market for identical terms exists at most once.
    pub fn create_market(
        ctx: Context<CreateMarket>,
        terms: MarketTerms,
        lock_ts: i64,
        resolve_deadline_ts: i64,
    ) -> Result<()> {
        require!(lock_ts < resolve_deadline_ts, PoolError::BadTimeline);
        let market = &mut ctx.accounts.market;
        market.creator = ctx.accounts.creator.key();
        market.terms = terms;
        market.terms_hash = market.terms.hash();
        market.lock_ts = lock_ts;
        market.resolve_deadline_ts = resolve_deadline_ts;
        market.yes_pool = 0;
        market.no_pool = 0;
        market.state = MarketState::Open;
        market.evidence_ts = 0;
        market.dispute_until_ts = 0;
        market.winner_yes = false;
        market.bump = ctx.bumps.market;
        market.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    /// Stake `amount` USDT on a side. Allowed while the market is Open and
    /// before lock_ts.
    pub fn deposit(ctx: Context<Deposit>, side_yes: bool, amount: u64) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.state == MarketState::Open, PoolError::MarketNotOpen);
        require!(
            Clock::get()?.unix_timestamp < market.lock_ts,
            PoolError::MarketLocked
        );
        require!(amount > 0, PoolError::ZeroAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        let position = &mut ctx.accounts.position;
        if position.amount == 0 {
            position.market = market.key();
            position.owner = ctx.accounts.user.key();
            position.side_yes = side_yes;
            position.claimed = false;
            position.bump = ctx.bumps.position;
        }
        require!(position.side_yes == side_yes, PoolError::SideMismatch);
        require!(!position.claimed, PoolError::AlreadyClaimed);
        position.amount = position.amount.checked_add(amount).ok_or(PoolError::Overflow)?;

        if side_yes {
            market.yes_pool = market.yes_pool.checked_add(amount).ok_or(PoolError::Overflow)?;
        } else {
            market.no_pool = market.no_pool.checked_add(amount).ok_or(PoolError::Overflow)?;
        }
        Ok(())
    }

    /// Resolve (or supersede a resolution of) the market with a Merkle proof.
    /// The proof is verified by the TxLINE oracle program against its posted
    /// daily scores root; this program only checks that the proven stats are
    /// the ones the market terms name, then records the outcome.
    pub fn resolve(
        ctx: Context<Resolve>,
        ts: i64,
        fixture_summary: ScoresBatchSummary,
        fixture_proof: Vec<ProofNode>,
        main_tree_proof: Vec<ProofNode>,
        stat_a: StatTerm,
        stat_b: Option<StatTerm>,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let market = &mut ctx.accounts.market;

        match market.state {
            MarketState::Open => require!(now >= market.lock_ts, PoolError::MarketNotLocked),
            MarketState::Resolved => {
                require!(now < market.dispute_until_ts, PoolError::DisputeWindowClosed);
                require!(ts > market.evidence_ts, PoolError::StaleEvidence);
            }
            MarketState::Void => return err!(PoolError::MarketVoid),
        }

        let terms = &market.terms;
        // The proven record must belong to this market's fixture and stats.
        require!(
            fixture_summary.fixture_id == terms.fixture_id,
            PoolError::FixtureMismatch
        );
        let period_ok = |p: i32| p == terms.period as i32 || p >= FINAL_PERIOD_FLOOR;
        require!(
            stat_a.stat_to_prove.key == terms.stat_a_key && period_ok(stat_a.stat_to_prove.period),
            PoolError::StatMismatch
        );
        match (&stat_b, terms.stat_b_key) {
            (Some(b), Some(key)) => require!(
                b.stat_to_prove.key == key && period_ok(b.stat_to_prove.period),
                PoolError::StatMismatch
            ),
            (None, None) => {}
            _ => return err!(PoolError::StatMismatch),
        }
        // Records from before kickoff can never decide a market.
        require!(ts / 1000 >= market.lock_ts, PoolError::EvidenceTooEarly);

        // CPI into txoracle validate_stat — reverts on any invalid proof or
        // missing root; returns the predicate boolean on success.
        let args = ValidateStatArgs {
            ts,
            fixture_summary,
            fixture_proof,
            main_tree_proof,
            predicate: terms.predicate.clone(),
            stat_a,
            stat_b,
            op: terms.op.clone(),
        };
        let mut data = VALIDATE_STAT_DISC.to_vec();
        args.serialize(&mut data)?;
        let ix = Instruction {
            program_id: TXORACLE_ID,
            accounts: vec![AccountMeta::new_readonly(
                ctx.accounts.daily_scores_merkle_roots.key(),
                false,
            )],
            data,
        };
        invoke(&ix, &[ctx.accounts.daily_scores_merkle_roots.to_account_info()])?;

        let (returning_program, return_data) =
            get_return_data().ok_or(PoolError::NoReturnData)?;
        require_keys_eq!(returning_program, TXORACLE_ID, PoolError::NoReturnData);
        let predicate_true = return_data.first().copied().unwrap_or(0) == 1;

        let outcome_yes = predicate_true != terms.negation;
        if market.state == MarketState::Open {
            market.dispute_until_ts = now + DISPUTE_WINDOW_SECS;
        }
        market.state = MarketState::Resolved;
        market.evidence_ts = ts;
        market.winner_yes = outcome_yes;
        emit!(MarketResolved {
            market: market.key(),
            winner_yes: outcome_yes,
            evidence_ts: ts,
            resolver: ctx.accounts.resolver.key(),
        });
        Ok(())
    }

    /// Flip an unresolved market to Void once its resolve deadline passed
    /// (abandoned fixture, missing root, …). Permissionless.
    pub fn void_market(ctx: Context<VoidMarket>) -> Result<()> {
        let market = &mut ctx.accounts.market;
        require!(market.state == MarketState::Open, PoolError::MarketNotOpen);
        require!(
            Clock::get()?.unix_timestamp >= market.resolve_deadline_ts,
            PoolError::DeadlineNotReached
        );
        market.state = MarketState::Void;
        Ok(())
    }

    /// Pay out a position. Resolved: winners get stake + pro-rata share of the
    /// losing pool (if the winning pool is empty, everyone reclaims stake).
    /// Void: everyone reclaims stake.
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let market = &ctx.accounts.market;
        let position = &mut ctx.accounts.position;
        require!(!position.claimed, PoolError::AlreadyClaimed);

        let now = Clock::get()?.unix_timestamp;
        let payout: u64 = match market.state {
            MarketState::Resolved => {
                require!(now >= market.dispute_until_ts, PoolError::DisputeWindowOpen);
                let (winner_pool, loser_pool) = if market.winner_yes {
                    (market.yes_pool, market.no_pool)
                } else {
                    (market.no_pool, market.yes_pool)
                };
                if winner_pool == 0 {
                    // Nobody backed the winning side — refund stakes.
                    position.amount
                } else if position.side_yes == market.winner_yes {
                    let share = (position.amount as u128)
                        .checked_mul(loser_pool as u128)
                        .ok_or(PoolError::Overflow)?
                        / (winner_pool as u128);
                    position
                        .amount
                        .checked_add(u64::try_from(share).map_err(|_| PoolError::Overflow)?)
                        .ok_or(PoolError::Overflow)?
                } else {
                    0
                }
            }
            MarketState::Void => position.amount,
            MarketState::Open => return err!(PoolError::MarketNotResolved),
        };
        require!(payout > 0, PoolError::NothingToClaim);

        position.claimed = true;
        let market_key = market.key();
        let seeds: &[&[u8]] = &[b"vault", market_key.as_ref(), &[market.vault_bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.user_token.to_account_info(),
                    authority: ctx.accounts.vault.to_account_info(),
                },
                &[seeds],
            ),
            payout,
        )?;
        emit!(Claimed {
            market: market_key,
            owner: position.owner,
            payout,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Types mirrored from the txoracle IDL (must borsh-encode identically).
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct TraderPredicate {
    pub threshold: i32,
    pub comparison: Comparison,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, InitSpace)]
pub enum Comparison {
    GreaterThan,
    LessThan,
    EqualTo,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, InitSpace)]
pub enum BinaryExpression {
    Add,
    Subtract,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoreStat {
    pub key: u32,
    pub value: i32,
    pub period: i32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofNode {
    pub hash: [u8; 32],
    pub is_right_sibling: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresUpdateStats {
    pub update_count: u32,
    pub min_timestamp: i64,
    pub max_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

#[derive(AnchorSerialize)]
struct ValidateStatArgs {
    ts: i64,
    fixture_summary: ScoresBatchSummary,
    fixture_proof: Vec<ProofNode>,
    main_tree_proof: Vec<ProofNode>,
    predicate: TraderPredicate,
    stat_a: StatTerm,
    stat_b: Option<StatTerm>,
    op: Option<BinaryExpression>,
}

/// Market terms — deliberately identical in layout to txoracle's
/// MarketIntentParams so `hash()` equals the TxLINE terms_hash convention.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct MarketTerms {
    pub fixture_id: i64,
    pub period: u16,
    pub stat_a_key: u32,
    pub stat_b_key: Option<u32>,
    pub predicate: TraderPredicate,
    pub op: Option<BinaryExpression>,
    pub negation: bool,
}

impl MarketTerms {
    pub fn hash(&self) -> [u8; 32] {
        let bytes = self.try_to_vec().expect("terms serialize");
        anchor_lang::solana_program::hash::hash(&bytes).to_bytes()
    }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, InitSpace)]
pub enum MarketState {
    Open,
    Resolved,
    Void,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub creator: Pubkey,
    pub terms: MarketTerms,
    pub terms_hash: [u8; 32],
    pub lock_ts: i64,
    pub resolve_deadline_ts: i64,
    pub yes_pool: u64,
    pub no_pool: u64,
    pub state: MarketState,
    /// ts (ms) of the scores record backing the current resolution.
    pub evidence_ts: i64,
    pub dispute_until_ts: i64,
    pub winner_yes: bool,
    pub bump: u8,
    pub vault_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub side_yes: bool,
    pub amount: u64,
    pub claimed: bool,
    pub bump: u8,
}

#[derive(Accounts)]
#[instruction(terms: MarketTerms)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = 8 + Market::INIT_SPACE,
        seeds = [b"market", terms.hash().as_ref()],
        bump,
    )]
    pub market: Account<'info, Market>,
    #[account(
        init,
        payer = creator,
        seeds = [b"vault", market.key().as_ref()],
        bump,
        token::mint = usdt_mint,
        token::authority = vault,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(address = USDT_MINT)]
    pub usdt_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(side_yes: bool)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = USDT_MINT, token::authority = user)]
    pub user_token: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = user,
        space = 8 + Position::INIT_SPACE,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref(), &[side_yes as u8]],
        bump,
    )]
    pub position: Account<'info, Position>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    pub resolver: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
    /// CHECK: validated by the txoracle program during the CPI (it derives and
    /// checks its own daily_scores_roots PDA / epoch alignment).
    pub daily_scores_merkle_roots: UncheckedAccount<'info>,
    /// CHECK: fixed txoracle program id.
    #[account(address = TXORACLE_ID)]
    pub txoracle_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct VoidMarket<'info> {
    pub caller: Signer<'info>,
    #[account(mut)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref(), &[position.side_yes as u8]],
        bump = position.bump,
        constraint = position.owner == user.key() @ PoolError::NotYourPosition,
        constraint = position.market == market.key() @ PoolError::NotYourPosition,
    )]
    pub position: Account<'info, Position>,
    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = USDT_MINT, token::authority = user)]
    pub user_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// Events + errors
// ---------------------------------------------------------------------------

#[event]
pub struct MarketResolved {
    pub market: Pubkey,
    pub winner_yes: bool,
    pub evidence_ts: i64,
    pub resolver: Pubkey,
}

#[event]
pub struct Claimed {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub payout: u64,
}

#[error_code]
pub enum PoolError {
    #[msg("lock_ts must precede resolve_deadline_ts")]
    BadTimeline,
    #[msg("Market is not open")]
    MarketNotOpen,
    #[msg("Market is locked for new positions")]
    MarketLocked,
    #[msg("Market has not reached its lock time")]
    MarketNotLocked,
    #[msg("Market is void")]
    MarketVoid,
    #[msg("Market is not resolved")]
    MarketNotResolved,
    #[msg("Amount must be positive")]
    ZeroAmount,
    #[msg("Position side does not match")]
    SideMismatch,
    #[msg("Position already claimed")]
    AlreadyClaimed,
    #[msg("Proven fixture does not match market terms")]
    FixtureMismatch,
    #[msg("Proven stat key/period does not match market terms")]
    StatMismatch,
    #[msg("Evidence record predates market lock")]
    EvidenceTooEarly,
    #[msg("Dispute window still open")]
    DisputeWindowOpen,
    #[msg("Dispute window closed")]
    DisputeWindowClosed,
    #[msg("Evidence is not newer than current resolution")]
    StaleEvidence,
    #[msg("Resolve deadline not reached")]
    DeadlineNotReached,
    #[msg("Oracle returned no data")]
    NoReturnData,
    #[msg("Nothing to claim")]
    NothingToClaim,
    #[msg("Position does not belong to caller")]
    NotYourPosition,
    #[msg("Arithmetic overflow")]
    Overflow,
}
