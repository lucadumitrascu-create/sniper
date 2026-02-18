import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CONFIG } from './config';
import { SniperConfig, SniperPosition, SniperLog } from './types';
import { normalizeConfig } from './utils';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_SERVICE_KEY);
  }
  return client;
}

/**
 * Verify Supabase connectivity on startup.
 * Returns true if we can reach the sniper_logs table.
 */
export async function checkSupabaseConnection(): Promise<boolean> {
  try {
    const { error } = await getSupabase()
      .from('sniper_logs')
      .select('id')
      .limit(1);

    if (error) {
      console.error('[Supabase] Connection check failed:', error.message);
      return false;
    }
    console.log('[Supabase] Connection OK.');
    return true;
  } catch (err: any) {
    console.error('[Supabase] Connection check exception:', err.message);
    return false;
  }
}

export async function getEnabledConfigs(): Promise<SniperConfig[]> {
  const { data, error } = await getSupabase()
    .from('sniper_config')
    .select('*')
    .eq('enabled', true);

  if (error) {
    console.error('[Supabase] Error fetching configs:', error.message);
    return [];
  }
  return (data || []).map((row) => normalizeConfig(row));
}

export async function getUserConfig(userId: string): Promise<SniperConfig | null> {
  const { data, error } = await getSupabase()
    .from('sniper_config')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error) return null;
  return normalizeConfig(data);
}

export async function insertPosition(position: Omit<SniperPosition, 'id' | 'created_at' | 'closed_at'>): Promise<SniperPosition | null> {
  const { data, error } = await getSupabase()
    .from('sniper_positions')
    .insert(position)
    .select()
    .single();

  if (error) {
    console.error('[Supabase] Error inserting position:', error.message);
    return null;
  }
  return data;
}

export async function updatePosition(id: string, updates: Partial<SniperPosition>): Promise<void> {
  const { error } = await getSupabase()
    .from('sniper_positions')
    .update(updates)
    .eq('id', id);

  if (error) {
    console.error('[Supabase] Error updating position:', error.message);
  }
}

export async function getOpenPositions(userId: string): Promise<SniperPosition[]> {
  const { data, error } = await getSupabase()
    .from('sniper_positions')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'open');

  if (error) {
    console.error('[Supabase] Error fetching positions:', error.message);
    return [];
  }
  return data || [];
}

export async function getAllOpenPositions(): Promise<SniperPosition[]> {
  const { data, error } = await getSupabase()
    .from('sniper_positions')
    .select('*')
    .in('status', ['open', 'selling']);

  if (error) {
    console.error('[Supabase] Error fetching all positions:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Get positions flagged for manual sell (force_sell = true).
 */
export async function getForceSellPositions(): Promise<SniperPosition[]> {
  const { data, error } = await getSupabase()
    .from('sniper_positions')
    .select('*')
    .eq('force_sell', true)
    .eq('status', 'open');

  if (error) {
    console.error('[Supabase] Error fetching force-sell positions:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Track daily spend: increment daily_spent_sol and reset if past midnight.
 */
export async function trackDailySpend(userId: string, amountSol: number): Promise<void> {
  const config = await getUserConfig(userId);
  if (!config) return;

  const now = new Date();
  const resetAt = config.budget_reset_at ? new Date(config.budget_reset_at) : new Date(0);

  // Reset daily spend if past the reset time (start of today)
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (resetAt < todayStart) {
    await getSupabase()
      .from('sniper_config')
      .update({
        daily_spent_sol: amountSol,
        budget_reset_at: todayStart.toISOString(),
      })
      .eq('user_id', userId);
  } else {
    await getSupabase()
      .from('sniper_config')
      .update({
        daily_spent_sol: config.daily_spent_sol + amountSol,
      })
      .eq('user_id', userId);
  }
}

/**
 * Insert a log row into Supabase. Bulletproof: never throws.
 */
export async function insertLog(entry: SniperLog): Promise<void> {
  try {
    const { error } = await getSupabase()
      .from('sniper_logs')
      .insert(entry);

    if (error) {
      console.error('[Supabase] insertLog failed:', error.message);
    }
  } catch (err: any) {
    console.error('[Supabase] insertLog exception:', err.message);
  }
}

/**
 * Log a message for a specific user: writes to console AND Supabase.
 */
export async function log(userId: string, level: SniperLog['level'], message: string, metadata?: Record<string, unknown>): Promise<void> {
  const prefix = `[${level.toUpperCase()}] [${userId.slice(0, 8)}]`;
  console.log(`${prefix} ${message}`);
  await insertLog({ user_id: userId, level, message, metadata });
}

/**
 * System-level log: writes to console AND inserts a row for EVERY enabled user
 * so the dashboard shows system events (startup, shutdown, errors) for all users.
 * If no users are enabled, it only goes to console.
 */
export async function syslog(level: SniperLog['level'], message: string, metadata?: Record<string, unknown>): Promise<void> {
  const prefix = `[${level.toUpperCase()}] [SYSTEM]`;
  console.log(`${prefix} ${message}`);

  try {
    const configs = await getEnabledConfigs();
    if (configs.length === 0) return;

    const rows = configs.map((c) => ({
      user_id: c.user_id,
      level,
      message: `[SYSTEM] ${message}`,
      metadata,
    }));

    const { error } = await getSupabase()
      .from('sniper_logs')
      .insert(rows);

    if (error) {
      console.error('[Supabase] syslog insert failed:', error.message);
    }
  } catch (err: any) {
    console.error('[Supabase] syslog exception:', err.message);
  }
}
