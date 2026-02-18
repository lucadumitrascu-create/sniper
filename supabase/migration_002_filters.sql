-- Migration: Add filters, budget tracking, and manual sell support
-- Run this on existing databases that already have the v1 schema.

-- === sniper_config: filter & budget columns ===
ALTER TABLE sniper_config
  ADD COLUMN IF NOT EXISTS min_market_cap_sol NUMERIC(14, 4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_market_cap_sol NUMERIC(14, 4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS min_liquidity_sol NUMERIC(14, 4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_budget_sol NUMERIC(10, 4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_spent_sol NUMERIC(10, 4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS budget_reset_at TIMESTAMPTZ DEFAULT now();

-- === sniper_positions: manual sell flag ===
ALTER TABLE sniper_positions
  ADD COLUMN IF NOT EXISTS force_sell BOOLEAN DEFAULT false;

-- Index for efficient force_sell queries
CREATE INDEX IF NOT EXISTS idx_sniper_positions_force_sell
  ON sniper_positions(force_sell) WHERE force_sell = true AND status = 'open';

-- RLS: allow users to update their own positions (for force_sell toggle)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'sniper_positions' AND policyname = 'Users can update own positions'
  ) THEN
    CREATE POLICY "Users can update own positions"
      ON sniper_positions FOR UPDATE
      USING (auth.uid() = user_id);
  END IF;
END
$$;
