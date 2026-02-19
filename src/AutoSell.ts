import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { CONFIG } from './config';
import { SniperConfig, SniperPosition } from './types';
import {
  getAllOpenPositions,
  getForceSellPositions,
  updatePosition,
  getUserConfig,
  log,
  syslog,
} from './supabase';
import {
  safeNum,
  PUMP_PROGRAM,
  PUMP_GLOBAL,
  PUMP_FEE_RECIPIENT,
  PUMP_EVENT_AUTHORITY,
  PUMP_FEE_CONFIG,
  PUMP_FEE_PROGRAM,
  deriveBondingCurve,
  deriveCreatorVault,
  readBondingCurve,
  estimateTokenValueSol,
} from './utils';

// Pump.fun "sell" instruction discriminator (sha256("global:sell") first 8 bytes)
const SELL_DISCRIMINATOR = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);

export class AutoSell {
  private connection: Connection;
  private running = false;
  private sellCheckInterval: ReturnType<typeof setInterval> | null = null;
  private priceMonitorInterval: ReturnType<typeof setInterval> | null = null;
  private sellingPositions = new Set<string>(); // In-memory guard to prevent duplicate sells

  constructor() {
    this.connection = new Connection(CONFIG.SOLANA_RPC_URL, {
      commitment: 'confirmed',
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    syslog('info', 'AutoSell + PriceMonitor starting...');

    // Sell-check loop (every POLL_INTERVAL_MS, default 5s)
    this.sellCheckInterval = setInterval(() => {
      this.checkPositions().catch((err) =>
        syslog('error', `AutoSell error checking positions: ${err.message}`, { error: err.message })
      );
    }, CONFIG.POLL_INTERVAL_MS);

    // Price monitoring loop (every 30s, independent from sell checks)
    this.priceMonitorInterval = setInterval(() => {
      this.updateAllPrices().catch((err) =>
        syslog('error', `PriceMonitor error: ${err.message}`, { error: err.message })
      );
    }, 30_000);

    // Run both immediately on start
    this.checkPositions().catch((err) =>
      syslog('error', `AutoSell error on initial check: ${err.message}`, { error: err.message })
    );
    this.updateAllPrices().catch((err) =>
      syslog('error', `PriceMonitor error on initial run: ${err.message}`, { error: err.message })
    );
  }

  stop(): void {
    this.running = false;
    if (this.sellCheckInterval) {
      clearInterval(this.sellCheckInterval);
      this.sellCheckInterval = null;
    }
    if (this.priceMonitorInterval) {
      clearInterval(this.priceMonitorInterval);
      this.priceMonitorInterval = null;
    }
    syslog('info', 'AutoSell + PriceMonitor stopped.');
  }

  /**
   * Independent price monitoring loop. Updates current_price, pnl_percent,
   * and tokens_received for ALL open positions every 30 seconds.
   * Uses position.wallet_address directly — no config/private key needed.
   */
  private async updateAllPrices(): Promise<void> {
    const positions = await getAllOpenPositions();
    if (positions.length === 0) return;

    let updated = 0;
    let failed = 0;

    for (const position of positions) {
      try {
        const mint = new PublicKey(position.token_mint);
        const walletPubkey = new PublicKey(position.wallet_address);

        // Get current token balance from ATA
        const ata = await getAssociatedTokenAddress(mint, walletPubkey, false, TOKEN_2022_PROGRAM_ID);
        let currentBalance: number;
        try {
          const balanceResp = await this.connection.getTokenAccountBalance(ata);
          currentBalance = safeNum(balanceResp.value.uiAmount, 0);
        } catch {
          // ATA doesn't exist or was closed — tokens are gone
          await updatePosition(position.id, { status: 'sold', closed_at: new Date().toISOString() });
          console.log(`[PriceMonitor] ${position.token_symbol}: ATA not found, marking sold`);
          continue;
        }

        if (currentBalance <= 0) {
          await updatePosition(position.id, { status: 'sold', closed_at: new Date().toISOString() });
          console.log(`[PriceMonitor] ${position.token_symbol}: balance=0, marking sold`);
          continue;
        }

        // Read bonding curve and estimate value
        const currentValueSol = await estimateTokenValueSol(this.connection, mint, currentBalance);
        if (currentValueSol === null) {
          console.log(`[PriceMonitor] ${position.token_symbol}: bonding curve unreadable, skipping`);
          failed++;
          continue;
        }

        const amountSpent = safeNum(position.buy_amount_sol, 0);
        const pnlPct = amountSpent > 0
          ? ((currentValueSol - amountSpent) / amountSpent) * 100
          : 0;
        const curPrice = currentBalance > 0 ? currentValueSol / currentBalance : 0;

        const safePnl = Number.isFinite(pnlPct) ? pnlPct : 0;
        const safePrice = Number.isFinite(curPrice) ? curPrice : 0;

        await updatePosition(position.id, {
          current_price: safePrice,
          pnl_percent: safePnl,
          tokens_received: currentBalance,
        });

        updated++;
      } catch (err: any) {
        console.error(`[PriceMonitor] Error updating ${position.token_symbol}: ${err.message}`);
        failed++;
      }
    }

    console.log(`[PriceMonitor] Cycle complete: ${updated} updated, ${failed} failed, ${positions.length} total`);
  }

  private async checkPositions(): Promise<void> {
    // 1. Process manual (force) sells first
    const forceSells = await getForceSellPositions();
    for (const position of forceSells) {
      try {
        await this.executeManualSell(position);
      } catch (err: any) {
        await log(position.user_id, 'error', `AutoSell manual sell error for ${position.token_symbol}: ${err.message}`, {
          positionId: position.id, error: err.message,
        });
      }
    }

    // 2. Evaluate auto-sell triggers for open positions
    const positions = await getAllOpenPositions();
    if (positions.length === 0) return;

    for (const position of positions) {
      if (this.sellingPositions.has(position.id)) continue; // Currently being sold
      if (position.force_sell) continue; // Already handled above

      try {
        await this.evaluatePosition(position);
      } catch (err: any) {
        await log(position.user_id, 'error', `AutoSell evaluation error for ${position.token_symbol}: ${err.message}`, {
          positionId: position.id, error: err.message,
        });
      }
    }
  }

  private async executeManualSell(position: SniperPosition): Promise<void> {
    const config = await getUserConfig(position.user_id);
    if (!config) {
      await log(position.user_id, 'error', `No config found for manual sell of ${position.token_symbol}`);
      return;
    }

    const mint = new PublicKey(position.token_mint);
    const wallet = Keypair.fromSecretKey(bs58.decode(config.bot_wallet_private_key));

    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
    let currentBalance: number;
    try {
      const balanceResp = await this.connection.getTokenAccountBalance(ata);
      currentBalance = safeNum(balanceResp.value.uiAmount, 0);
    } catch {
      await updatePosition(position.id, {
        status: 'sold',
        force_sell: false,
        closed_at: new Date().toISOString(),
      });
      return;
    }

    if (currentBalance <= 0) {
      await updatePosition(position.id, {
        status: 'sold',
        force_sell: false,
        closed_at: new Date().toISOString(),
      });
      return;
    }

    await log(
      position.user_id,
      'info',
      `Manual sell triggered for ${position.token_symbol} (${currentBalance} tokens)`,
      { positionId: position.id }
    );

    await this.executeSell(config, position, currentBalance, 'manual');
  }

  /**
   * Update live price and PnL for a position. Runs for ALL open positions
   * regardless of auto_sell_enabled, so the dashboard always shows current data.
   * Returns the updated balance and config, or null if the position should be closed.
   */
  private async updatePositionPrice(position: SniperPosition): Promise<{
    config: SniperConfig;
    currentBalance: number;
    safePnl: number;
  } | null> {
    const config = await getUserConfig(position.user_id);
    if (!config) return null;

    const mint = new PublicKey(position.token_mint);
    const wallet = Keypair.fromSecretKey(bs58.decode(config.bot_wallet_private_key));

    // Get current token balance
    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
    let currentBalance: number;
    try {
      const balanceResp = await this.connection.getTokenAccountBalance(ata);
      currentBalance = safeNum(balanceResp.value.uiAmount, 0);
    } catch {
      await updatePosition(position.id, { status: 'sold', closed_at: new Date().toISOString() });
      return null;
    }

    if (currentBalance <= 0) {
      await updatePosition(position.id, { status: 'sold', closed_at: new Date().toISOString() });
      return null;
    }

    // Get current token value from bonding curve
    const currentValueSol = await estimateTokenValueSol(this.connection, mint, currentBalance);
    if (currentValueSol === null) return null;

    const amountSpent = safeNum(position.buy_amount_sol, 0);
    const pnlPct = amountSpent > 0
      ? ((currentValueSol - amountSpent) / amountSpent) * 100
      : 0;
    const curPrice = currentBalance > 0 ? currentValueSol / currentBalance : 0;

    const safePnl = Number.isFinite(pnlPct) ? pnlPct : 0;
    const safePrice = Number.isFinite(curPrice) ? curPrice : 0;

    await updatePosition(position.id, {
      current_price: safePrice,
      pnl_percent: safePnl,
      tokens_received: currentBalance,
    });

    return { config, currentBalance, safePnl };
  }

  private async evaluatePosition(position: SniperPosition): Promise<void> {
    // Always update price/PnL for all positions (dashboard visibility)
    const result = await this.updatePositionPrice(position);
    if (!result) return;

    const { config, currentBalance, safePnl } = result;

    // Only check sell triggers if auto_sell is enabled
    if (!config.auto_sell_enabled) return;

    // Check take profit
    const tp = safeNum(config.take_profit_pct, 100);
    if (safePnl >= tp) {
      await log(
        position.user_id,
        'info',
        `Take profit triggered for ${position.token_symbol}: ${safePnl.toFixed(2)}% >= ${tp}%`,
        { positionId: position.id, pnlPct: safePnl }
      );
      await this.executeSell(config, position, currentBalance, 'take_profit');
      return;
    }

    // Check stop loss
    const sl = safeNum(config.stop_loss_pct, 50);
    if (safePnl <= -sl) {
      await log(
        position.user_id,
        'warn',
        `Stop loss triggered for ${position.token_symbol}: ${safePnl.toFixed(2)}% <= -${sl}%`,
        { positionId: position.id, pnlPct: safePnl }
      );
      await this.executeSell(config, position, currentBalance, 'stop_loss');
      return;
    }
  }

  private async executeSell(
    config: SniperConfig,
    position: SniperPosition,
    tokenAmount: number,
    reason: 'take_profit' | 'stop_loss' | 'manual'
  ): Promise<void> {
    this.sellingPositions.add(position.id);
    await updatePosition(position.id, { force_sell: false });

    try {
      const wallet = Keypair.fromSecretKey(bs58.decode(config.bot_wallet_private_key));
      const mint = new PublicKey(position.token_mint);

      // Read bonding curve to get creator for creatorVault PDA + estimate sell value
      const curve = await readBondingCurve(this.connection, mint);
      if (!curve) {
        throw new Error('Could not read bonding curve to derive creatorVault');
      }
      const creator = new PublicKey(curve.creator);

      const slippageBps = safeNum(config.slippage_bps, 500);
      const priorityFee = safeNum(config.priority_fee_lamports, 100000);

      // Calculate expected SOL output for minSolOutput (slippage protection)
      const rawTokenAmount = BigInt(Math.floor(tokenAmount * 1e6));
      let minSolOutput = BigInt(0);
      if (curve.virtualTokenReserves > 0n) {
        // expectedSol = (tokenAmount * virtualSolReserves) / (virtualTokenReserves + tokenAmount)
        const expectedSolLamports = (rawTokenAmount * curve.virtualSolReserves) / (curve.virtualTokenReserves + rawTokenAmount);
        // Apply slippage downward: accept less SOL
        minSolOutput = expectedSolLamports * BigInt(10000 - slippageBps) / BigInt(10000);
      }
      // For stop loss / manual emergency, accept any output
      if (reason === 'stop_loss' || reason === 'manual') {
        minSolOutput = BigInt(0);
      }

      console.log(`[DEBUG SELL] tokens=${tokenAmount}, rawTokenAmount=${rawTokenAmount}, minSolOutput=${minSolOutput}, reason=${reason}`);

      const tx = await this.buildSellTransaction(
        wallet,
        mint,
        creator,
        rawTokenAmount,
        minSolOutput,
        priorityFee
      );

      // Get fresh blockhash, sign, and send
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;
      tx.sign(wallet);

      const rawTx = tx.serialize();
      const signature = await this.connection.sendRawTransaction(rawTx, {
        skipPreflight: true,
        maxRetries: 5,
      });

      await log(config.user_id, 'info', `Sell tx sent for ${position.token_symbol}: ${signature}, awaiting confirmation...`, {
        positionId: position.id, signature, reason,
      });

      // Confirm with proper blockhash-based strategy
      const confirmation = await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      if (confirmation.value.err) {
        throw new Error(`Sell tx failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      }

      // Get SOL balance change to determine actual sell proceeds (retry for indexing lag)
      let txDetails = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        txDetails = await this.connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
        });
        if (txDetails?.meta) break;
        await new Promise((r) => setTimeout(r, 1500));
      }

      let soldAmountSol = 0;
      if (txDetails?.meta) {
        const walletIndex = txDetails.transaction.message.accountKeys.findIndex(
          (k) => k.pubkey.equals(wallet.publicKey)
        );
        if (walletIndex >= 0) {
          const pre = txDetails.meta.preBalances[walletIndex];
          const post = txDetails.meta.postBalances[walletIndex];
          soldAmountSol = Math.max(0, (post - pre)) / LAMPORTS_PER_SOL;
        }
      }

      // If we couldn't determine actual proceeds, fall back to bonding curve estimate
      // (calculated before the sell tx was sent). This prevents writing -100% PnL.
      if (soldAmountSol <= 0 && curve.virtualTokenReserves > 0n) {
        const estimatedLamports = (rawTokenAmount * curve.virtualSolReserves) / (curve.virtualTokenReserves + rawTokenAmount);
        soldAmountSol = Number(estimatedLamports) / LAMPORTS_PER_SOL;
        console.log(`[AutoSell] getParsedTransaction returned no data for ${signature}, using bonding curve estimate: ${soldAmountSol.toFixed(4)} SOL`);
      }

      const amountSpent = safeNum(position.buy_amount_sol, 0);
      const finalPnl = amountSpent > 0
        ? ((soldAmountSol - amountSpent) / amountSpent) * 100
        : 0;
      const safeFinalPnl = Number.isFinite(finalPnl) ? finalPnl : 0;

      // Freeze final price + PnL at sell time so sold positions retain accurate data
      const finalPrice = tokenAmount > 0 ? soldAmountSol / tokenAmount : 0;
      const safeFinalPrice = Number.isFinite(finalPrice) ? finalPrice : 0;

      await updatePosition(position.id, {
        status: 'sold',
        sell_signature: signature,
        sell_amount_sol: soldAmountSol,
        pnl_percent: safeFinalPnl,
        current_price: safeFinalPrice,
        closed_at: new Date().toISOString(),
      });

      await log(
        config.user_id,
        'success',
        `Sold ${position.token_symbol} (${reason}): ${soldAmountSol.toFixed(4)} SOL received, PnL: ${safeFinalPnl.toFixed(2)}%`,
        { positionId: position.id, signature, soldAmountSol, finalPnl: safeFinalPnl, reason }
      );
    } catch (err: any) {
      await updatePosition(position.id, { status: 'open' });
      await log(
        config.user_id,
        'error',
        `Sell failed for ${position.token_symbol}: ${err.message}`,
        { positionId: position.id, error: err.message, reason }
      );
    } finally {
      this.sellingPositions.delete(position.id);
    }
  }

  /**
   * Build Pump.fun sell transaction with all 14 required accounts.
   * Returns an UNSIGNED transaction without blockhash.
   *
   * Account layout:
   *   0  global                  (read)
   *   1  feeRecipient            (write)
   *   2  mint                    (read)
   *   3  bondingCurve            (write)
   *   4  associatedBondingCurve  (write)
   *   5  associatedUser          (write)  - user's ATA
   *   6  user                    (write, signer)
   *   7  systemProgram           (read)
   *   8  creatorVault            (write)
   *   9  tokenProgram            (read)  - Token-2022
   *  10  eventAuthority          (read)
   *  11  program                 (read)  - Pump program
   *  12  feeConfig               (read)
   *  13  feeProgram              (read)
   *
   * Data: discriminator(8) + amount(u64) + minSolOutput(u64)
   */
  private async buildSellTransaction(
    wallet: Keypair,
    mint: PublicKey,
    creator: PublicKey,
    rawTokenAmount: bigint,
    minSolOutput: bigint,
    priorityFeeLamports: number
  ): Promise<Transaction> {
    const tx = new Transaction();

    // Priority fees
    if (priorityFeeLamports > 0) {
      tx.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFeeLamports,
        }),
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 300_000,
        })
      );
    }

    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);

    // Derive all required accounts
    const bondingCurve = deriveBondingCurve(mint);
    const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurve, true, TOKEN_2022_PROGRAM_ID);
    const creatorVault = deriveCreatorVault(creator);

    // Encode sell instruction data (24 bytes):
    // discriminator(8) + amount(u64) + minSolOutput(u64)
    const data = Buffer.alloc(24);
    SELL_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(rawTokenAmount, 8);
    data.writeBigUInt64LE(minSolOutput, 16);

    const sellIx = new TransactionInstruction({
      programId: PUMP_PROGRAM,
      keys: [
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },                // 0  global
        { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },           // 1  feeRecipient
        { pubkey: mint, isSigner: false, isWritable: false },                        // 2  mint
        { pubkey: bondingCurve, isSigner: false, isWritable: true },                 // 3  bondingCurve
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },       // 4  associatedBondingCurve
        { pubkey: ata, isSigner: false, isWritable: true },                          // 5  associatedUser
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },              // 6  user
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },     // 7  systemProgram
        { pubkey: creatorVault, isSigner: false, isWritable: true },                 // 8  creatorVault
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },       // 9  tokenProgram
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },        // 10 eventAuthority
        { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },                // 11 program
        { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },             // 12 feeConfig
        { pubkey: PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },            // 13 feeProgram
      ],
      data,
    });

    tx.add(sellIx);

    return tx;
  }
}
