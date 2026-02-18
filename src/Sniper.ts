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
  createAssociatedTokenAccountInstruction,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { CONFIG } from './config';
import { SniperConfig, PumpTokenLaunch, SniperPosition } from './types';
import { insertPosition, log, getOpenPositions, trackDailySpend } from './supabase';
import {
  safeNum,
  deriveBondingCurve,
  readBondingCurve,
  getMarketCapSol,
  getLiquiditySol,
  sleep,
} from './utils';

const PUMP_PROGRAM = new PublicKey(CONFIG.PUMP_PROGRAM_ID);

// Pump.fun "buy" instruction discriminator
const BUY_DISCRIMINATOR = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);

// Pump.fun global state account
const PUMP_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const PUMP_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ83zX7FnHR1');
const PUMP_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

export class Sniper {
  private connection: Connection;
  private activeSnipes = new Map<string, boolean>();

  constructor() {
    this.connection = new Connection(CONFIG.SOLANA_RPC_URL, {
      commitment: 'confirmed',
    });
  }

  async executeBuy(
    userConfig: SniperConfig,
    launch: PumpTokenLaunch
  ): Promise<SniperPosition | null> {
    const userId = userConfig.user_id;
    const mintKey = launch.mint;

    // Prevent duplicate snipes on same mint
    if (this.activeSnipes.has(mintKey)) {
      await log(userId, 'warn', `Already sniping ${launch.symbol} (${mintKey}), skipping`);
      return null;
    }

    // --- Pre-flight checks ---

    // Position limit
    const openPositions = await getOpenPositions(userId);
    if (openPositions.length >= userConfig.max_concurrent_positions) {
      await log(userId, 'warn', `Max positions (${userConfig.max_concurrent_positions}) reached, skipping ${launch.symbol}`);
      return null;
    }

    // Buy amount sanity check (NaN guard)
    const buyAmountSol = safeNum(userConfig.buy_amount_sol, 0);
    if (buyAmountSol <= 0) {
      await log(userId, 'error', `Invalid buy_amount_sol (${userConfig.buy_amount_sol}), skipping ${launch.symbol}`);
      return null;
    }

    // Daily budget check
    if (userConfig.daily_budget_sol > 0) {
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const resetAt = userConfig.budget_reset_at ? new Date(userConfig.budget_reset_at) : new Date(0);
      const spent = resetAt < todayStart ? 0 : safeNum(userConfig.daily_spent_sol, 0);

      if (spent + buyAmountSol > userConfig.daily_budget_sol) {
        await log(userId, 'warn', `Daily budget exceeded (${spent.toFixed(4)}/${userConfig.daily_budget_sol} SOL), skipping ${launch.symbol}`);
        return null;
      }
    }

    // Market cap + liquidity filters (read bonding curve on-chain)
    const mint = new PublicKey(mintKey);
    const hasFilters = userConfig.min_market_cap_sol > 0
      || userConfig.max_market_cap_sol > 0
      || userConfig.min_liquidity_sol > 0;

    if (hasFilters) {
      const curve = await readBondingCurve(this.connection, mint);
      if (!curve) {
        await log(userId, 'warn', `Could not read bonding curve for ${launch.symbol}, skipping filter check`);
      } else {
        if (curve.complete) {
          await log(userId, 'warn', `Bonding curve already complete for ${launch.symbol}, skipping`);
          return null;
        }

        const mcap = getMarketCapSol(curve);
        const liquidity = getLiquiditySol(curve);

        if (userConfig.min_market_cap_sol > 0 && mcap < userConfig.min_market_cap_sol) {
          await log(userId, 'info', `Market cap ${mcap.toFixed(2)} SOL < min ${userConfig.min_market_cap_sol} SOL, skipping ${launch.symbol}`);
          return null;
        }
        if (userConfig.max_market_cap_sol > 0 && mcap > userConfig.max_market_cap_sol) {
          await log(userId, 'info', `Market cap ${mcap.toFixed(2)} SOL > max ${userConfig.max_market_cap_sol} SOL, skipping ${launch.symbol}`);
          return null;
        }
        if (userConfig.min_liquidity_sol > 0 && liquidity < userConfig.min_liquidity_sol) {
          await log(userId, 'info', `Liquidity ${liquidity.toFixed(4)} SOL < min ${userConfig.min_liquidity_sol} SOL, skipping ${launch.symbol}`);
          return null;
        }
      }
    }

    // --- Execute snipe ---
    this.activeSnipes.set(mintKey, true);

    try {
      await log(userId, 'info', `Sniping ${launch.symbol} (${mintKey}) with ${buyAmountSol} SOL`, {
        mint: mintKey,
        symbol: launch.symbol,
        buyAmount: buyAmountSol,
      });

      const wallet = Keypair.fromSecretKey(bs58.decode(userConfig.bot_wallet_private_key));

      const slippageBps = safeNum(userConfig.slippage_bps, 500);
      const priorityFee = safeNum(userConfig.priority_fee_lamports, 100000);

      const tx = await this.buildBuyTransaction(
        wallet,
        mint,
        launch,
        buyAmountSol,
        slippageBps,
        priorityFee
      );

      const signature = await sendAndConfirmTransaction(this.connection, tx, [wallet], {
        commitment: 'confirmed',
        maxRetries: 3,
      });

      await log(userId, 'success', `Buy executed for ${launch.symbol}: ${signature}`, {
        mint: mintKey,
        signature,
      });

      // Get token balance after buy (retry a few times for indexing delay)
      const ata = await getAssociatedTokenAddress(mint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
      let tokenBalance = 0;
      for (let i = 0; i < 3; i++) {
        try {
          const balanceResp = await this.connection.getTokenAccountBalance(ata);
          tokenBalance = safeNum(balanceResp.value.uiAmount, 0);
          if (tokenBalance > 0) break;
        } catch {
          // ATA might not be indexed yet
        }
        await sleep(1500);
      }

      // Calculate entry price - guard against division by zero / NaN
      const entryPrice = tokenBalance > 0 ? buyAmountSol / tokenBalance : 0;

      // Track daily spend
      await trackDailySpend(userId, buyAmountSol);

      // Record position in DB
      const position = await insertPosition({
        user_id: userId,
        token_mint: mintKey,
        token_name: launch.name,
        token_symbol: launch.symbol,
        entry_price_sol: entryPrice,
        amount_tokens: tokenBalance,
        amount_sol_spent: buyAmountSol,
        current_price_sol: entryPrice,
        pnl_pct: 0,
        status: 'open',
        force_sell: false,
        tx_signature_buy: signature,
        tx_signature_sell: null,
        sold_amount_sol: null,
      });

      return position;
    } catch (err: any) {
      await log(userId, 'error', `Buy failed for ${launch.symbol}: ${err.message}`, {
        mint: mintKey,
        error: err.message,
      });
      return null;
    } finally {
      this.activeSnipes.delete(mintKey);
    }
  }

  private async buildBuyTransaction(
    wallet: Keypair,
    mint: PublicKey,
    launch: PumpTokenLaunch,
    buyAmountSol: number,
    slippageBps: number,
    priorityFeeLamports: number
  ): Promise<Transaction> {
    const tx = new Transaction();

    // Priority fee
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

    // Create ATA if needed (Pump.fun uses Token-2022)
    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ataInfo = await this.connection.getAccountInfo(ata);
    if (!ataInfo) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          ata,
          wallet.publicKey,
          mint,
          TOKEN_2022_PROGRAM_ID
        )
      );
    }

    // Compute SOL amounts safely (all values are guaranteed finite by safeNum upstream)
    const buyAmountLamports = Math.floor(buyAmountSol * LAMPORTS_PER_SOL);
    const maxSolCost = buyAmountLamports + Math.floor(buyAmountLamports * slippageBps / 10000);

    // Encode buy instruction data: discriminator (8) + tokenAmount (u64) + maxSolCost (u64)
    const data = Buffer.alloc(24);
    BUY_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(BigInt(0), 8); // 0 = buy as much as possible with SOL
    data.writeBigUInt64LE(BigInt(maxSolCost), 16);

    const bondingCurve = launch.bondingCurve
      ? new PublicKey(launch.bondingCurve)
      : deriveBondingCurve(mint);

    const associatedBondingCurve = launch.associatedBondingCurve
      ? new PublicKey(launch.associatedBondingCurve)
      : await getAssociatedTokenAddress(mint, bondingCurve, true, TOKEN_2022_PROGRAM_ID);

    const buyIx = new TransactionInstruction({
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
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
      ],
      data,
    });

    tx.add(buyIx);

    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    return tx;
  }
}
