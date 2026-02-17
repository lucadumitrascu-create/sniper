import { CONFIG, validateConfig } from './config';
import { PumpMonitor } from './PumpMonitor';
import { Sniper } from './Sniper';
import { AutoSell } from './AutoSell';
import { getEnabledConfigs, log } from './supabase';
import { PumpTokenLaunch, SniperConfig } from './types';

class SniperBot {
  private pumpMonitor: PumpMonitor;
  private sniper: Sniper;
  private autoSell: AutoSell;
  private configCache: Map<string, SniperConfig> = new Map();
  private configPollInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.pumpMonitor = new PumpMonitor();
    this.sniper = new Sniper();
    this.autoSell = new AutoSell();
  }

  async start(): Promise<void> {
    console.log('===========================================');
    console.log('   Pump.fun Sniper Bot - Starting...');
    console.log('===========================================');

    validateConfig();

    // Load initial configs
    await this.refreshConfigs();

    // Start config polling
    this.configPollInterval = setInterval(
      () => this.refreshConfigs().catch(console.error),
      CONFIG.POLL_INTERVAL_MS
    );

    // Set up launch handler
    this.pumpMonitor.on('launch', (launch: PumpTokenLaunch) => {
      this.handleLaunch(launch).catch((err) =>
        console.error('[Bot] Error handling launch:', err)
      );
    });

    // Start all modules
    await this.pumpMonitor.start();
    this.autoSell.start();

    console.log('[Bot] All systems operational.');
    console.log(`[Bot] Monitoring ${this.configCache.size} active user(s).`);

    // Keep process alive
    this.setupGracefulShutdown();
  }

  private async refreshConfigs(): Promise<void> {
    const configs = await getEnabledConfigs();
    this.configCache.clear();
    for (const config of configs) {
      this.configCache.set(config.user_id, config);
    }
  }

  private async handleLaunch(launch: PumpTokenLaunch): Promise<void> {
    console.log(`[Bot] New token detected: ${launch.symbol} (${launch.mint})`);

    // Refresh configs to get latest settings
    await this.refreshConfigs();

    const enabledConfigs = Array.from(this.configCache.values());
    if (enabledConfigs.length === 0) {
      console.log('[Bot] No enabled users, skipping.');
      return;
    }

    // Execute snipes for all enabled users concurrently (respecting max concurrent)
    const snipePromises = enabledConfigs.map(async (config) => {
      try {
        await this.sniper.executeBuy(config, launch);
      } catch (err: any) {
        await log(config.user_id, 'error', `Snipe orchestration error: ${err.message}`);
      }
    });

    // Limit concurrency
    const batches = chunk(snipePromises, CONFIG.MAX_CONCURRENT_SNIPES);
    for (const batch of batches) {
      await Promise.allSettled(batch);
    }
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      console.log(`\n[Bot] Received ${signal}. Shutting down gracefully...`);

      if (this.configPollInterval) {
        clearInterval(this.configPollInterval);
      }

      this.pumpMonitor.stop();
      this.autoSell.stop();

      console.log('[Bot] Shutdown complete.');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Handle uncaught errors
    process.on('uncaughtException', (err) => {
      console.error('[Bot] Uncaught exception:', err);
    });

    process.on('unhandledRejection', (reason) => {
      console.error('[Bot] Unhandled rejection:', reason);
    });
  }
}

function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Start the bot
const bot = new SniperBot();
bot.start().catch((err) => {
  console.error('[Bot] Fatal error:', err);
  process.exit(1);
});
