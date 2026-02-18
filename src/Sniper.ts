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
} from '@solana/spl-token';
import bs58 from 'bs58';
import { CONFIG } from './config';
import { SniperConfig, PumpTokenLaunch, SniperPosition, BondingCurveState } from './types';
import { insertPosition, log, getOpenPositions, trackDailySpend } from './supabase';
import {
  safeNum,
  PUMP_PROGRAM,
  PUMP_GLOBAL,
  PUMP_FEE_RECIPIENT,
  PUMP_EVENT_AUTHORITY,
  PUMP_GLOBAL_VOLUME_ACCUMULATOR,
  PUMP_FEE_CONFIG,
  PUMP_FEE_PROGRAM,
  deriveBondingCurve,
  deriveCreatorVault,
  deriveUserVolumeAccumulator,
  readBondingCurve,
  getMarketCapSol,
  getLiquiditySol,
  sleep,
} from './utils';

// Pump.fun "buy" instruction discriminator
const BUY_DISCRIMINATOR = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);

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

    // Always read bonding curve: needed for creator (creatorVault PDA) and optional filters
    const mint = new PublicKey(mintKey);
    const curve = await readBondingCurve(this.connection, mint);
    if (!curve) {
      await log(userId, 'error', `Could not read bonding curve for ${launch.symbol}, cannot derive accounts`);
      return null;
    }

    if (curve.complete) {
      await log(userId, 'warn', `Bonding curve already complete for ${launch.symbol}, skipping`);
      return null;
    }

    // Market cap + liquidity filters
    const hasFilters = userConfig.min_market_cap_sol > 0
      || userConfig.max_market_cap_sol > 0
      || userConfig.min_liquidity_sol > 0;

    if (hasFilters) {
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

    // --- Execute snipe ---
    this.activeSnipes.set(mintKey, true);

    try {
      const wallet = Keypair.fromSecretKey(bs58.decode(userConfig.bot_wallet_private_key));
      const creator = new PublicKey(curve.creator);

      const slippageBps = safeNum(userConfig.slippage_bps, 500);
      const priorityFee = safeNum(userConfig.priority_fee_lamports, 100000);

      await log(userId, 'info', `Sniping ${launch.symbol} (${mintKey}) with ${buyAmountSol} SOL | slippage=${slippageBps}bps | priorityFee=${priorityFee}`, {
        mint: mintKey,
        symbol: launch.symbol,
        buyAmount: buyAmountSol,
        slippageBps,
        priorityFeeLamports: priorityFee,
        virtualTokenReserves: curve.virtualTokenReserves.toString(),
        virtualSolReserves: curve.virtualSolReserves.toString(),
      });

      const tx = await this.buildBuyTransaction(
        wallet,
        mint,
        launch,
        creator,
        curve,
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

  /**
   * Build Pump.fun buy transaction with all 16 required accounts.
   *
   * Account layout:
   *   0  global                    (read)
   *   1  feeRecipient              (write)
   *   2  mint                      (read)
   *   3  bondingCurve              (write)
   *   4  associatedBondingCurve    (write)
   *   5  associatedUser            (write)  - user's ATA
   *   6  user                      (write, signer)
   *   7  systemProgram             (read)
   *   8  tokenProgram              (read)  - Token-2022
   *   9  creatorVault              (write)
   *  10  eventAuthority            (read)
   *  11  program                   (read)  - Pump program
   *  12  globalVolumeAccumulator   (read)
   *  13  userVolumeAccumulator     (write)
   *  14  feeConfig                 (read)
   *  15  feeProgram                (read)
   *
   * Data: discriminator(8) + amount(u64) + maxSolCost(u64) + trackVolume(u8)
   */
  private async buildBuyTransaction(
    wallet: Keypair,
    mint: PublicKey,
    launch: PumpTokenLaunch,
    creator: PublicKey,
    curve: BondingCurveState,
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
          units: 300_000,
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

    // Compute SOL amounts safely
    const buyAmountLamports = Math.floor(buyAmountSol * LAMPORTS_PER_SOL);
    const maxSolCost = buyAmountLamports + Math.floor(buyAmountLamports * slippageBps / 10000);

    // Calculate expected token amount from bonding curve reserves
    // Formula: tokensOut = (solIn * virtualTokenReserves) / (virtualSolReserves + solIn)
    const solIn = BigInt(buyAmountLamports);
    const expectedTokens = (solIn * curve.virtualTokenReserves) / (curve.virtualSolReserves + solIn);

    // Apply slippage downward: accept fewer tokens to account for price movement
    const minTokenAmount = expectedTokens * BigInt(10000 - slippageBps) / BigInt(10000);

    if (minTokenAmount <= 0n) {
      throw new Error(
        `Calculated token amount is 0. buyAmountLamports=${buyAmountLamports}, ` +
        `virtualTokenReserves=${curve.virtualTokenReserves}, virtualSolReserves=${curve.virtualSolReserves}`
      );
    }

    // Debug: log all computed values before building instruction
    console.log(`[DEBUG] buy_amount_sol=${buyAmountSol}, lamports=${buyAmountLamports}, maxSolCost=${maxSolCost}`);
    console.log(`[DEBUG] virtualTokenReserves=${curve.virtualTokenReserves}, virtualSolReserves=${curve.virtualSolReserves}`);
    console.log(`[DEBUG] expectedTokens=${expectedTokens}, minTokenAmount (after slippage)=${minTokenAmount}`);

    // Encode buy instruction data (25 bytes):
    // discriminator(8) + amount(u64) + maxSolCost(u64) + trackVolume(u8)
    const data = Buffer.alloc(25);
    BUY_DISCRIMINATOR.copy(data, 0);
    data.writeBigUInt64LE(minTokenAmount, 8);       // token amount to buy (must be > 0)
    data.writeBigUInt64LE(BigInt(maxSolCost), 16);  // max SOL willing to pay (with slippage)
    data.writeUInt8(0, 24);                          // trackVolume = false

    // Derive all required accounts
    const bondingCurve = launch.bondingCurve
      ? new PublicKey(launch.bondingCurve)
      : deriveBondingCurve(mint);

    const associatedBondingCurve = launch.associatedBondingCurve
      ? new PublicKey(launch.associatedBondingCurve)
      : await getAssociatedTokenAddress(mint, bondingCurve, true, TOKEN_2022_PROGRAM_ID);

    const creatorVault = deriveCreatorVault(creator);
    const userVolumeAccumulator = deriveUserVolumeAccumulator(wallet.publicKey);

    const buyIx = new TransactionInstruction({
      programId: PUMP_PROGRAM,
      keys: [
        { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },                      // 0  global
        { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },                 // 1  feeRecipient
        { pubkey: mint, isSigner: false, isWritable: false },                              // 2  mint
        { pubkey: bondingCurve, isSigner: false, isWritable: true },                       // 3  bondingCurve
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },             // 4  associatedBondingCurve
        { pubkey: ata, isSigner: false, isWritable: true },                                // 5  associatedUser
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },                    // 6  user
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },           // 7  systemProgram
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },             // 8  tokenProgram
        { pubkey: creatorVault, isSigner: false, isWritable: true },                       // 9  creatorVault
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },              // 10 eventAuthority
        { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },                      // 11 program
        { pubkey: PUMP_GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: false },    // 12 globalVolumeAccumulator
        { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },              // 13 userVolumeAccumulator
        { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },                   // 14 feeConfig
        { pubkey: PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },                  // 15 feeProgram
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
