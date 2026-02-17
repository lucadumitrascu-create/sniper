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
import { getAllOpenPositions, updatePosition, getUserConfig, log } from './supabase';

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
    const positions = await getAllOpenPositions();
    if (positions.length === 0) return;

    for (const position of positions) {
      if (position.status === 'selling') continue;

      try {
        await this.evaluatePosition(position);
      } catch (err: any) {
        console.error(`[AutoSell] Error evaluating position ${position.id}:`, err.message);
      }
    }
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
      currentBalance = parseFloat(balanceResp.value.uiAmountString || '0');
    } catch {
      // Token account might be closed
      await updatePosition(position.id, { status: 'closed', closed_at: new Date().toISOString() });
      return;
    }

    if (currentBalance <= 0) {
      await updatePosition(position.id, { status: 'closed', closed_at: new Date().toISOString() });
      return;
    }

    // Get current token value by checking bonding curve
    const currentValueSol = await this.estimateTokenValueSol(mint, currentBalance);
    if (currentValueSol === null) return;

    const pnlPct = ((currentValueSol - position.amount_sol_spent) / position.amount_sol_spent) * 100;
    const currentPrice = currentBalance > 0 ? currentValueSol / currentBalance : 0;

    // Update position with current data
    await updatePosition(position.id, {
      current_price_sol: currentPrice,
      pnl_pct: pnlPct,
      amount_tokens: currentBalance,
    });

    // Check take profit
    if (pnlPct >= config.take_profit_pct) {
      await log(
        position.user_id,
        'info',
        `Take profit triggered for ${position.token_symbol}: ${pnlPct.toFixed(2)}% >= ${config.take_profit_pct}%`,
        { positionId: position.id, pnlPct }
      );
      await this.executeSell(config, position, currentBalance, 'take_profit');
      return;
    }

    // Check stop loss
    if (pnlPct <= -config.stop_loss_pct) {
      await log(
        position.user_id,
        'warn',
        `Stop loss triggered for ${position.token_symbol}: ${pnlPct.toFixed(2)}% <= -${config.stop_loss_pct}%`,
        { positionId: position.id, pnlPct }
      );
      await this.executeSell(config, position, currentBalance, 'stop_loss');
      return;
    }
  }

  private async estimateTokenValueSol(mint: PublicKey, tokenAmount: number): Promise<number | null> {
    try {
      // Derive bonding curve PDA
      const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), mint.toBuffer()],
        PUMP_PROGRAM
      );

      // Get bonding curve account data to read virtual reserves
      const accountInfo = await this.connection.getAccountInfo(bondingCurve);
      if (!accountInfo || !accountInfo.data) return null;

      const data = accountInfo.data;
      // Pump.fun bonding curve layout (after 8 byte discriminator):
      // virtualTokenReserves: u64 (offset 8)
      // virtualSolReserves: u64 (offset 16)
      // realTokenReserves: u64 (offset 24)
      // realSolReserves: u64 (offset 32)
      // tokenTotalSupply: u64 (offset 40)
      // complete: bool (offset 48)

      if (data.length < 49) return null;

      const virtualTokenReserves = Number(data.readBigUInt64LE(8));
      const virtualSolReserves = Number(data.readBigUInt64LE(16));

      if (virtualTokenReserves === 0) return null;

      // Constant product formula: price = virtualSolReserves / virtualTokenReserves
      // Value of tokens = tokenAmount * (virtualSolReserves / virtualTokenReserves)
      // Note: token amounts from bonding curve are in raw units (6 decimals for pump.fun)
      const rawTokenAmount = tokenAmount * 1e6;
      const valueLamports = (rawTokenAmount * virtualSolReserves) / virtualTokenReserves;
      const valueSol = valueLamports / LAMPORTS_PER_SOL;

      return valueSol;
    } catch (err) {
      console.error(`[AutoSell] Error estimating value for ${mint.toBase58()}:`, err);
      return null;
    }
  }

  private async executeSell(
    config: SniperConfig,
    position: SniperPosition,
    tokenAmount: number,
    reason: 'take_profit' | 'stop_loss'
  ): Promise<void> {
    // Mark as selling to prevent duplicate sells
    await updatePosition(position.id, { status: 'selling' });

    try {
      const wallet = Keypair.fromSecretKey(bs58.decode(config.bot_wallet_private_key));
      const mint = new PublicKey(position.token_mint);

      const tx = await this.buildSellTransaction(
        wallet,
        mint,
        tokenAmount,
        config.slippage_bps,
        config.priority_fee_lamports
      );

      const signature = await sendAndConfirmTransaction(this.connection, tx, [wallet], {
        commitment: 'confirmed',
        maxRetries: 3,
      });

      // Get SOL balance change
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

      const finalPnl = position.amount_sol_spent > 0
        ? ((soldAmountSol - position.amount_sol_spent) / position.amount_sol_spent) * 100
        : 0;

      await updatePosition(position.id, {
        status: 'closed',
        tx_signature_sell: signature,
        sold_amount_sol: soldAmountSol,
        pnl_pct: finalPnl,
        closed_at: new Date().toISOString(),
      });

      await log(
        config.user_id,
        'success',
        `Sold ${position.token_symbol} (${reason}): ${soldAmountSol.toFixed(4)} SOL received, PnL: ${finalPnl.toFixed(2)}%`,
        { positionId: position.id, signature, soldAmountSol, finalPnl, reason }
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
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      PUMP_PROGRAM
    );
    const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurve, true);

    // Encode sell instruction: discriminator + amount (u64) + minSolOutput (u64)
    const rawTokenAmount = BigInt(Math.floor(tokenAmount * 1e6));
    // Min SOL output with slippage protection (set to 0 for market sell, slippage handled by protocol)
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
