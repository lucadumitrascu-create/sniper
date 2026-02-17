import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { CONFIG } from './config';
import { SniperConfig, SniperPosition, SniperLog } from './types';

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_SERVICE_KEY);
  }
  return client;
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
  return data || [];
}

export async function getUserConfig(userId: string): Promise<SniperConfig | null> {
  const { data, error } = await getSupabase()
    .from('sniper_config')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error) return null;
  return data;
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

export async function insertLog(log: SniperLog): Promise<void> {
  const { error } = await getSupabase()
    .from('sniper_logs')
    .insert(log);

  if (error) {
    console.error('[Supabase] Error inserting log:', error.message);
  }
}

export async function log(userId: string, level: SniperLog['level'], message: string, metadata?: Record<string, unknown>): Promise<void> {
  const prefix = `[${level.toUpperCase()}] [${userId.slice(0, 8)}]`;
  console.log(`${prefix} ${message}`);
  await insertLog({ user_id: userId, level, message, metadata });
}
