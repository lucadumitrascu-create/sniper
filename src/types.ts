export interface SniperConfig {
  id: string;
  user_id: string;
  enabled: boolean;
  buy_amount_sol: number;
  slippage_bps: number;
  auto_sell_enabled: boolean;
  take_profit_pct: number;
  stop_loss_pct: number;
  max_concurrent_positions: number;
  priority_fee_lamports: number;
  bot_wallet_address: string;
  bot_wallet_private_key: string;
  // Filters
  min_market_cap_sol: number;
  max_market_cap_sol: number;
  min_liquidity_sol: number;
  daily_budget_sol: number;
  daily_spent_sol: number;
  budget_reset_at: string;
  created_at: string;
  updated_at: string;
}

export interface SniperPosition {
  id: string;
  user_id: string;
  token_mint: string;
  token_name: string;
  token_symbol: string;
  entry_price_sol: number;
  amount_tokens: number;
  amount_sol_spent: number;
  current_price_sol: number;
  pnl_pct: number;
  status: 'open' | 'closed' | 'selling';
  force_sell: boolean;
  tx_signature_buy: string;
  tx_signature_sell: string | null;
  sold_amount_sol: number | null;
  created_at: string;
  closed_at: string | null;
}

export interface SniperLog {
  id?: string;
  user_id: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface PumpTokenLaunch {
  signature: string;
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  bondingCurve: string;
  associatedBondingCurve: string;
  creator: string;
  timestamp: number;
}

/** Bonding curve state read from on-chain account */
export interface BondingCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
}
