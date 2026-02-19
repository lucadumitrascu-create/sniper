import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { SniperConfig, BondingCurveState } from './types';
import { CONFIG } from './config';

// ──────────────────────────────────────────────
// Pump.fun program constants
// ──────────────────────────────────────────────

export const PUMP_PROGRAM = new PublicKey(CONFIG.PUMP_PROGRAM_ID);
export const PUMP_FEE_PROGRAM = new PublicKey('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ');
export const PUMP_FEE_RECIPIENT = new PublicKey('62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV');

// Static PDAs (derived once, never change)
export const PUMP_GLOBAL = PublicKey.findProgramAddressSync(
  [Buffer.from('global')],
  PUMP_PROGRAM
)[0];

export const PUMP_EVENT_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from('__event_authority')],
  PUMP_PROGRAM
)[0];

export const PUMP_GLOBAL_VOLUME_ACCUMULATOR = PublicKey.findProgramAddressSync(
  [Buffer.from('global_volume_accumulator')],
  PUMP_PROGRAM
)[0];

export const PUMP_FEE_CONFIG = PublicKey.findProgramAddressSync(
  [Buffer.from('fee_config'), PUMP_PROGRAM.toBuffer()],
  PUMP_FEE_PROGRAM
)[0];

// ──────────────────────────────────────────────
// PDA derivation helpers
// ──────────────────────────────────────────────

export function deriveBondingCurve(mint: PublicKey): PublicKey {
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM
  );
  return bondingCurve;
}

export function deriveCreatorVault(creator: PublicKey): PublicKey {
  const [creatorVault] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), creator.toBuffer()],
    PUMP_PROGRAM
  );
  return creatorVault;
}

export function deriveUserVolumeAccumulator(user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBuffer()],
    PUMP_PROGRAM
  );
  return pda;
}

// ──────────────────────────────────────────────
// Bonding curve reader
// ──────────────────────────────────────────────

/**
 * Read bonding curve state from on-chain account.
 *
 * Account data layout (after 8-byte Anchor discriminator):
 *   offset  8: virtualTokenReserves  (u64)
 *   offset 16: virtualSolReserves    (u64)
 *   offset 24: realTokenReserves     (u64)
 *   offset 32: realSolReserves       (u64)
 *   offset 40: tokenTotalSupply      (u64)
 *   offset 48: complete              (bool, 1 byte)
 *   offset 49: creator               (Pubkey, 32 bytes)
 */
export async function readBondingCurve(
  connection: Connection,
  mint: PublicKey
): Promise<BondingCurveState | null> {
  const bondingCurve = deriveBondingCurve(mint);
  const accountInfo = await connection.getAccountInfo(bondingCurve);
  if (!accountInfo || !accountInfo.data || accountInfo.data.length < 81) return null;

  const data = accountInfo.data;
  const creatorBytes = data.subarray(49, 81);

  return {
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualSolReserves: data.readBigUInt64LE(16),
    realTokenReserves: data.readBigUInt64LE(24),
    realSolReserves: data.readBigUInt64LE(32),
    tokenTotalSupply: data.readBigUInt64LE(40),
    complete: data[48] !== 0,
    creator: new PublicKey(creatorBytes).toBase58(),
  };
}

// ──────────────────────────────────────────────
// Value estimation
// ──────────────────────────────────────────────

export async function estimateTokenValueSol(
  connection: Connection,
  mint: PublicKey,
  tokenAmount: number
): Promise<number | null> {
  const curve = await readBondingCurve(connection, mint);
  if (!curve || curve.virtualTokenReserves === 0n) return null;

  // Use constant-product AMM formula (same as actual sell execution):
  // solOut = (tokenAmount * virtualSolReserves) / (virtualTokenReserves + tokenAmount)
  const rawTokenAmount = BigInt(Math.floor(tokenAmount * 1e6));
  const valueLamports = (rawTokenAmount * curve.virtualSolReserves) / (curve.virtualTokenReserves + rawTokenAmount);
  return Number(valueLamports) / LAMPORTS_PER_SOL;
}

export function getMarketCapSol(curve: BondingCurveState): number {
  if (curve.virtualTokenReserves === 0n) return 0;
  const price = Number(curve.virtualSolReserves) / Number(curve.virtualTokenReserves);
  const totalSupply = Number(curve.tokenTotalSupply);
  return (totalSupply * price) / LAMPORTS_PER_SOL;
}

export function getLiquiditySol(curve: BondingCurveState): number {
  return Number(curve.realSolReserves) / LAMPORTS_PER_SOL;
}

// ──────────────────────────────────────────────
// Misc utilities
// ──────────────────────────────────────────────

export function safeNum(value: unknown, fallback: number = 0): number {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeConfig(raw: Record<string, unknown>): SniperConfig {
  // Accept both 'buy_amount_sol' and 'buy_amount' (dashboard compatibility)
  const rawBuyAmount = raw.buy_amount_sol ?? raw.buy_amount;
  const buyAmountSol = safeNum(rawBuyAmount, 0.1);
  if (rawBuyAmount === undefined || rawBuyAmount === null) {
    console.warn(`[CONFIG] buy_amount_sol missing from DB row (user=${raw.user_id}), using default ${buyAmountSol} SOL`);
  } else {
    console.log(`[CONFIG] buy_amount_sol loaded from DB: ${buyAmountSol} SOL (raw=${rawBuyAmount}, type=${typeof rawBuyAmount})`);
  }

  return {
    id: String(raw.id || ''),
    user_id: String(raw.user_id || ''),
    enabled: Boolean(raw.enabled),
    buy_amount_sol: buyAmountSol,
    slippage_bps: safeNum(raw.slippage_bps, 500),
    auto_sell_enabled: raw.auto_sell_enabled !== false,
    take_profit_pct: safeNum(raw.take_profit_pct, 100),
    stop_loss_pct: safeNum(raw.stop_loss_pct, 50),
    max_concurrent_positions: safeNum(raw.max_concurrent_positions, 3),
    priority_fee_lamports: safeNum(raw.priority_fee_lamports, 100000),
    bot_wallet_address: String(raw.bot_wallet_address || ''),
    bot_wallet_private_key: String(raw.bot_wallet_private_key || ''),
    min_market_cap_sol: safeNum(raw.min_market_cap_sol, 0),
    max_market_cap_sol: safeNum(raw.max_market_cap_sol, 0),
    min_liquidity_sol: safeNum(raw.min_liquidity_sol, 0),
    daily_budget_sol: safeNum(raw.daily_budget_sol, 0),
    daily_spent_sol: safeNum(raw.daily_spent_sol, 0),
    budget_reset_at: String(raw.budget_reset_at || ''),
    created_at: String(raw.created_at || ''),
    updated_at: String(raw.updated_at || ''),
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
