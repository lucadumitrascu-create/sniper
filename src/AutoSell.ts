import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
  SystemProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
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
} from './supabase';
import { safeNum, deriveBondingCurve, estimateTokenValueSol } from './utils';

const PUMP_PROGRAM = new PublicKey(CONFIG.PUMP_PROGRAM_ID);

// Pump.fun "sell" instruction discriminator
const SELL_DISCRIMINATOR = Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]);

const PUMP_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const PUMP_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ83zX7FnHR1');
const PUMP_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

export class AutoSell {
  private connection: Connection;
  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.connection = new Connection(CONFIG.SOLANA_RPC_URL, {
      commitment: 'confirmed',
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log('[AutoSell] Starting position monitor...');

    this.intervalId = setInterval(() => {
      this.checkPositions().catch((err) =>
        console.error('[AutoSell] Error checking positions:', err)
      );
    }, CONFIG.POLL_INTERVAL_MS);

    // Run immediately on start
    this.checkPositions().catch((err) =>
      console.error('[AutoSell] Error on initial check:', err)
    );
  }

  stop(): void {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    console.log('[AutoSell] Stopped.');
  }

  private async checkPositions(): Promise<void> {
    // 1. Process manual (force) sells first
    const forceSells = await getForceSellPositions();
    for (const position of forceSells) {
      try {
        await this.executeManualSell(position);
      } catch (err: any) {
        console.error(`[AutoSell] Error executing manual sell for ${position.id}:`, err.message);
      }
    }

    // 2. Evaluate auto-sell triggers for open positions
    const positions = await getAllOpenPositions();
    if (positions.length === 0) return;

    for (const position of positions) {
      if (position.status === 'selling') continue;
      if (position.force_sell) continue; // Already handled above

      try {
        await this.evaluatePosition(position);
      } catch (err: any) {
        console.error(`[AutoSell] Error evaluating position ${position.id}:`, err.message);
      }
    }
  }

  /**
   * Manual sell: user sets force_sell=true from dashboard, bot sells immediately.
   */
  private async executeManualSell(position: SniperPosition): Promise<void> {
    const config = await getUserConfig(position.user_id);
    if (!config) {
      await log(position.user_id, 'error', `No config found for manual sell of ${position.token_symbol}`);
      return;
    }

    const mint = new PublicKey(position.token_mint);
    const wallet = Keypair.fromSecretKey(bs58.decode(config.bot_wallet_private_key));

    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
    let currentBalance: number;
    try {
      const balanceResp = await this.connection.getTokenAccountBalance(ata);
      currentBalance = safeNum(balanceResp.value.uiAmount, 0);
    } catch {
      await updatePosition(position.id, {
        status: 'closed',
        force_sell: false,
        closed_at: new Date().toISOString(),
      });
      return;
    }

    if (currentBalance <= 0) {
      await updatePosition(position.id, {
        status: 'closed',
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

  private async evaluatePosition(position: SniperPosition): Promise<void> {
    const config = await getUserConfig(position.user_id);
    if (!config || !config.auto_sell_enabled) return;

    const mint = new PublicKey(position.token_mint);
    const wallet = Keypair.fromSecretKey(bs58.decode(config.bot_wallet_private_key));

    // Get current token balance
    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
    let currentBalance: number;
    try {
      const balanceResp = await this.connection.getTokenAccountBalance(ata);
      currentBalance = safeNum(balanceResp.value.uiAmount, 0);
    } catch {
      // Token account might be closed
      await updatePosition(position.id, { status: 'closed', closed_at: new Date().toISOString() });
      return;
    }

    if (currentBalance <= 0) {
      await updatePosition(position.id, { status: 'closed', closed_at: new Date().toISOString() });
      return;
    }

    // Get current token value from bonding curve
    const currentValueSol = await estimateTokenValueSol(this.connection, mint, currentBalance);
    if (currentValueSol === null) return;

    const amountSpent = safeNum(position.amount_sol_spent, 0);
    const pnlPct = amountSpent > 0
      ? ((currentValueSol - amountSpent) / amountSpent) * 100
      : 0;
    const currentPrice = currentBalance > 0 ? currentValueSol / currentBalance : 0;

    // Guard against NaN in DB update
    const safePnl = Number.isFinite(pnlPct) ? pnlPct : 0;
    const safePrice = Number.isFinite(currentPrice) ? currentPrice : 0;

    // Update position with current data
    await updatePosition(position.id, {
      current_price_sol: safePrice,
      pnl_pct: safePnl,
      amount_tokens: currentBalance,
    });

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
    // Mark as selling to prevent duplicate sells
    await updatePosition(position.id, { status: 'selling', force_sell: false });

    try {
      const wallet = Keypair.fromSecretKey(bs58.decode(config.bot_wallet_private_key));
      const mint = new PublicKey(position.token_mint);

      const slippageBps = safeNum(config.slippage_bps, 500);
      const priorityFee = safeNum(config.priority_fee_lamports, 100000);

      const tx = await this.buildSellTransaction(
        wallet,
        mint,
        tokenAmount,
        slippageBps,
        priorityFee
      );

      const signature = await sendAndConfirmTransaction(this.connection, tx, [wallet], {
        commitment: 'confirmed',
        maxRetries: 3,
      });

      // Get SOL balance change to determine actual sell proceeds
      const txDetails = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
      });

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

      const amountSpent = safeNum(position.amount_sol_spent, 0);
      const finalPnl = amountSpent > 0
        ? ((soldAmountSol - amountSpent) / amountSpent) * 100
        : 0;
      const safeFinalPnl = Number.isFinite(finalPnl) ? finalPnl : 0;

      await updatePosition(position.id, {
        status: 'closed',
        tx_signature_sell: signature,
        sold_amount_sol: soldAmountSol,
        pnl_pct: safeFinalPnl,
        closed_at: new Date().toISOString(),
      });

      await log(
        config.user_id,
        'success',
        `Sold ${position.token_symbol} (${reason}): ${soldAmountSol.toFixed(4)} SOL received, PnL: ${safeFinalPnl.toFixed(2)}%`,
        { positionId: position.id, signature, soldAmountSol, finalPnl: safeFinalPnl, reason }
      );
    } catch (err: any) {
      // Revert status to open so we can retry
      await updatePosition(position.id, { status: 'open' });
      await log(
        config.user_id,
        'error',
        `Sell failed for ${position.token_symbol}: ${err.message}`,
        { positionId: position.id, error: err.message, reason }
      );
    }
  }

  private async buildSellTransaction(
    wallet: Keypair,
    mint: PublicKey,
    tokenAmount: number,
    slippageBps: number,
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
          units: 250_000,
        })
      );
    }

    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);

    // Derive bonding curve accounts
    const bondingCurve = deriveBondingCurve(mint);
    const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurve, true);

    // Encode sell instruction: discriminator + amount (u64) + minSolOutput (u64)
    const rawTokenAmount = BigInt(Math.floor(tokenAmount * 1e6));
    const minSolOutput = BigInt(0);

    const data = Buffer.alloc(24);
    SELL_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(rawTokenAmount, 8);
    data.writeBigUInt64LE(minSolOutput, 16);

    const sellIx = new TransactionInstruction({
      programId: PUMP_PROGRAM,
      keys: [
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
      ],
      data,
    });

    tx.add(sellIx);

    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    return tx;
  }
}
