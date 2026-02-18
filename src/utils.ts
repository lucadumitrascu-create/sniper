import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { SniperConfig, BondingCurveState } from './types';
import { CONFIG } from './config';

const PUMP_PROGRAM = new PublicKey(CONFIG.PUMP_PROGRAM_ID);

/**
 * Safely parse a value to number. Supabase returns NUMERIC columns as strings.
 * Prevents NaN propagation by returning a fallback for any non-finite result.
 */
export function safeNum(value: unknown, fallback: number = 0): number {
  if (value === null || value === undefined) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Normalize a SniperConfig from Supabase, converting all numeric fields
 * from potential string values to proper numbers with safe defaults.
 */
export function normalizeConfig(raw: Record<string, unknown>): SniperConfig {
  return {
    id: String(raw.id || ''),
    user_id: String(raw.user_id || ''),
    enabled: Boolean(raw.enabled),
    buy_amount_sol: safeNum(raw.buy_amount_sol, 0.1),
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

/**
 * Derive the bonding curve PDA for a given mint.
 */
export function deriveBondingCurve(mint: PublicKey): PublicKey {
  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBuffer()],
    PUMP_PROGRAM
  );
  return bondingCurve;
}

/**
 * Read bonding curve state from on-chain account.
 * Layout after 8-byte discriminator:
 *   virtualTokenReserves: u64 (offset 8)
 *   virtualSolReserves: u64 (offset 16)
 *   realTokenReserves: u64 (offset 24)
 *   realSolReserves: u64 (offset 32)
 *   tokenTotalSupply: u64 (offset 40)
 *   complete: bool (offset 48)
 */
export async function readBondingCurve(
  connection: Connection,
  mint: PublicKey
): Promise<BondingCurveState | null> {
  const bondingCurve = deriveBondingCurve(mint);
  const accountInfo = await connection.getAccountInfo(bondingCurve);
  if (!accountInfo || !accountInfo.data || accountInfo.data.length < 49) return null;

  const data = accountInfo.data;
  return {
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualSolReserves: data.readBigUInt64LE(16),
    realTokenReserves: data.readBigUInt64LE(24),
    realSolReserves: data.readBigUInt64LE(32),
    tokenTotalSupply: data.readBigUInt64LE(40),
    complete: data[48] !== 0,
  };
}

/**
 * Estimate the SOL value of a token amount using bonding curve reserves.
 * Returns null if bonding curve can't be read.
 */
export async function estimateTokenValueSol(
  connection: Connection,
  mint: PublicKey,
  tokenAmount: number
): Promise<number | null> {
  const curve = await readBondingCurve(connection, mint);
  if (!curve || curve.virtualTokenReserves === 0n) return null;

  const virtualTokenReserves = Number(curve.virtualTokenReserves);
  const virtualSolReserves = Number(curve.virtualSolReserves);

  // token amounts are in raw units (6 decimals for pump.fun)
  const rawTokenAmount = tokenAmount * 1e6;
  const valueLamports = (rawTokenAmount * virtualSolReserves) / virtualTokenReserves;
  return valueLamports / LAMPORTS_PER_SOL;
}

/**
 * Get market cap in SOL from bonding curve state.
 * Market cap = totalSupply * pricePerToken
 * pricePerToken = virtualSolReserves / virtualTokenReserves
 */
export function getMarketCapSol(curve: BondingCurveState): number {
  if (curve.virtualTokenReserves === 0n) return 0;
  const price = Number(curve.virtualSolReserves) / Number(curve.virtualTokenReserves);
  const totalSupply = Number(curve.tokenTotalSupply);
  return (totalSupply * price) / LAMPORTS_PER_SOL;
}

/**
 * Get liquidity (real SOL reserves) from bonding curve.
 */
export function getLiquiditySol(curve: BondingCurveState): number {
  return Number(curve.realSolReserves) / LAMPORTS_PER_SOL;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
