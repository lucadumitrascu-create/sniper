import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL || '',
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY || '',
  SOLANA_RPC_URL: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  SOLANA_WS_URL: process.env.SOLANA_WS_URL || 'wss://api.mainnet-beta.solana.com',
  PUMP_PROGRAM_ID: process.env.PUMP_PROGRAM_ID || '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || '5000', 10),
  MAX_CONCURRENT_SNIPES: parseInt(process.env.MAX_CONCURRENT_SNIPES || '3', 10),
} as const;

export function validateConfig(): void {
  if (!CONFIG.SUPABASE_URL) throw new Error('SUPABASE_URL is required');
  if (!CONFIG.SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_SERVICE_KEY is required');
  if (!CONFIG.SOLANA_RPC_URL) throw new Error('SOLANA_RPC_URL is required');
}
