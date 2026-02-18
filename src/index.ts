import { CONFIG, validateConfig } from './config';
import { PumpMonitor } from './PumpMonitor';
import { Sniper } from './Sniper';
import { AutoSell } from './AutoSell';
import { getEnabledConfigs, log, syslog, checkSupabaseConnection } from './supabase';
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
    await syslog('info', 'Pump.fun Sniper Bot - Starting...');

    validateConfig();

    // Verify Supabase connectivity before proceeding
    const connected = await checkSupabaseConnection();
    if (!connected) {
      await syslog('error', 'Supabase connection failed. Bot will continue but logs may not appear in dashboard.');
    }

    // Load initial configs
    await this.refreshConfigs();

    // Start config polling
    this.configPollInterval = setInterval(
      () => this.refreshConfigs().catch((err) =>
        syslog('error', `Config refresh error: ${err.message}`)
      ),
      CONFIG.POLL_INTERVAL_MS
    );

    // Set up launch handler
    this.pumpMonitor.on('launch', (launch: PumpTokenLaunch) => {
      this.handleLaunch(launch).catch((err) =>
        syslog('error', `Error handling launch: ${err.message}`, { error: err.message })
      );
    });

    // Start all modules
    await this.pumpMonitor.start();
    this.autoSell.start();

    await syslog('success', `All systems operational. Monitoring ${this.configCache.size} active user(s).`);

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
    await syslog('info', `New token detected: ${launch.symbol} (${launch.mint})`, {
      mint: launch.mint,
      symbol: launch.symbol,
    });

    // Refresh configs to get latest settings
    await this.refreshConfigs();

    const enabledConfigs = Array.from(this.configCache.values());
    if (enabledConfigs.length === 0) {
      await syslog('info', 'No enabled users, skipping.');
      return;
    }

    // Execute snipes for all enabled users with proper concurrency limiting
    // (promises must be created lazily per batch, not eagerly via .map)
    for (let i = 0; i < enabledConfigs.length; i += CONFIG.MAX_CONCURRENT_SNIPES) {
      const batch = enabledConfigs.slice(i, i + CONFIG.MAX_CONCURRENT_SNIPES);
      await Promise.allSettled(
        batch.map(async (config) => {
          try {
            await this.sniper.executeBuy(config, launch);
          } catch (err: any) {
            await log(config.user_id, 'error', `Snipe orchestration error: ${err.message}`);
          }
        })
      );
    }
  }

  private setupGracefulShutdown(): void {
    const shutdown = async (signal: string) => {
      await syslog('warn', `Received ${signal}. Shutting down gracefully...`);

      if (this.configPollInterval) {
        clearInterval(this.configPollInterval);
      }

      this.pumpMonitor.stop();
      this.autoSell.stop();

      await syslog('info', 'Shutdown complete.');
      process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Handle uncaught errors
    process.on('uncaughtException', (err) => {
      syslog('error', `Uncaught exception: ${err.message}`, { stack: err.stack });
    });

    process.on('unhandledRejection', (reason) => {
      syslog('error', `Unhandled rejection: ${reason}`, { reason: String(reason) });
    });
  }
}

// Start the bot
const bot = new SniperBot();
bot.start().catch((err) => {
  console.error('[FATAL] Bot startup failed:', err);
  syslog('error', `Fatal startup error: ${err.message}`).finally(() => process.exit(1));
});
