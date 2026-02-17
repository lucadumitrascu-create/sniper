-- Sniper Config: per-user bot configuration
CREATE TABLE IF NOT EXISTS sniper_config (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  enabled BOOLEAN DEFAULT false,
  buy_amount_sol NUMERIC(10, 4) DEFAULT 0.1,
  slippage_bps INTEGER DEFAULT 500,
  auto_sell_enabled BOOLEAN DEFAULT true,
  take_profit_pct NUMERIC(10, 2) DEFAULT 100,
  stop_loss_pct NUMERIC(10, 2) DEFAULT 50,
  max_concurrent_positions INTEGER DEFAULT 3,
  priority_fee_lamports BIGINT DEFAULT 100000,
  bot_wallet_address TEXT NOT NULL,
  bot_wallet_private_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

-- Sniper Positions: tracks open and closed positions
CREATE TABLE IF NOT EXISTS sniper_positions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_mint TEXT NOT NULL,
  token_name TEXT,
  token_symbol TEXT,
  entry_price_sol NUMERIC(20, 10) DEFAULT 0,
  amount_tokens NUMERIC(20, 6) DEFAULT 0,
  amount_sol_spent NUMERIC(10, 6) DEFAULT 0,
  current_price_sol NUMERIC(20, 10) DEFAULT 0,
  pnl_pct NUMERIC(10, 2) DEFAULT 0,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'closed', 'selling')),
  tx_signature_buy TEXT,
  tx_signature_sell TEXT,
  sold_amount_sol NUMERIC(10, 6),
  created_at TIMESTAMPTZ DEFAULT now(),
  closed_at TIMESTAMPTZ
);

-- Sniper Logs: activity logs per user
CREATE TABLE IF NOT EXISTS sniper_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  level TEXT DEFAULT 'info' CHECK (level IN ('info', 'warn', 'error', 'success')),
  message TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sniper_config_user ON sniper_config(user_id);
CREATE INDEX IF NOT EXISTS idx_sniper_config_enabled ON sniper_config(enabled);
CREATE INDEX IF NOT EXISTS idx_sniper_positions_user ON sniper_positions(user_id);
CREATE INDEX IF NOT EXISTS idx_sniper_positions_status ON sniper_positions(status);
CREATE INDEX IF NOT EXISTS idx_sniper_positions_user_status ON sniper_positions(user_id, status);
CREATE INDEX IF NOT EXISTS idx_sniper_logs_user ON sniper_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_sniper_logs_created ON sniper_logs(created_at DESC);

-- RLS Policies: users can only see their own data
ALTER TABLE sniper_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE sniper_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sniper_logs ENABLE ROW LEVEL SECURITY;

-- Config policies
CREATE POLICY "Users can view own config"
  ON sniper_config FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own config"
  ON sniper_config FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own config"
  ON sniper_config FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Positions policies
CREATE POLICY "Users can view own positions"
  ON sniper_positions FOR SELECT
  USING (auth.uid() = user_id);

-- Logs policies
CREATE POLICY "Users can view own logs"
  ON sniper_positions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view own sniper logs"
  ON sniper_logs FOR SELECT
  USING (auth.uid() = user_id);

-- Updated_at trigger for sniper_config
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sniper_config_updated_at
  BEFORE UPDATE ON sniper_config
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
