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

// Pump.fun "buy" instruction discriminator (sha256("global:buy") first 8 bytes)
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
    console.log(`[DEBUG] Config buy_amount_sol: ${userConfig.buy_amount_sol} (type=${typeof userConfig.buy_amount_sol}), resolved: ${buyAmountSol} SOL`);
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

    // Read bonding curve with retries (new tokens may not be propagated yet)
    const mint = new PublicKey(mintKey);
    let curve: BondingCurveState | null = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      curve = await readBondingCurve(this.connection, mint);
      if (curve) break;
      await sleep(400);
    }
    if (!curve) {
      await log(userId, 'error', `Could not read bonding curve for ${launch.symbol} after 5 retries, skipping`);
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

      // Compute SOL amounts for balance check
      const buyAmountLamports = Math.floor(buyAmountSol * LAMPORTS_PER_SOL);
      const slippageLamports = Math.floor(buyAmountLamports * slippageBps / 10000);
      const maxSolCost = buyAmountLamports + slippageLamports;
      const feeBufferLamports = 10_000_000; // 0.01 SOL for tx fees/rent

      // Check wallet has enough SOL (maxSolCost + fee buffer)
      const walletBalance = await this.connection.getBalance(wallet.publicKey);
      const neededLamports = maxSolCost + feeBufferLamports;

      console.log(`[DEBUG] Buy amount breakdown: buy=${buyAmountSol} SOL (${buyAmountLamports} lamports), slippage=${slippageLamports} lamports (${slippageBps}bps), fee_buffer=${feeBufferLamports} lamports`);
      console.log(`[DEBUG] Total needed: ${(neededLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL (${neededLamports} lamports), wallet balance: ${(walletBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

      if (walletBalance < neededLamports) {
        await log(userId, 'error', `Insufficient SOL: have ${(walletBalance / LAMPORTS_PER_SOL).toFixed(4)}, need ~${(neededLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL (buy=${buyAmountSol} + slippage=${(slippageLamports / LAMPORTS_PER_SOL).toFixed(4)} + fees=0.01)`);
        return null;
      }

      await log(userId, 'info', `Sniping ${launch.symbol} (${mintKey}) with ${buyAmountSol} SOL | slippage=${slippageBps}bps | balance=${(walletBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`, {
        mint: mintKey,
        symbol: launch.symbol,
        buyAmount: buyAmountSol,
        slippageBps,
        priorityFeeLamports: priorityFee,
        walletBalance: walletBalance / LAMPORTS_PER_SOL,
        virtualTokenReserves: curve.virtualTokenReserves.toString(),
        virtualSolReserves: curve.virtualSolReserves.toString(),
      });

      // Build instruction (without blockhash — we set it below for fresh signing)
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

      await log(userId, 'info', `Buy tx sent: ${signature}, awaiting confirmation...`, {
        mint: mintKey,
        signature,
      });

      // Confirm with proper blockhash-based strategy
      const confirmation = await this.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      if (confirmation.value.err) {
        throw new Error(`Transaction failed on-chain: ${JSON.stringify(confirmation.value.err)}`);
      }

      await log(userId, 'success', `Buy confirmed for ${launch.symbol}: ${signature}`, {
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
      console.log(`[DEBUG] Saving position to DB for ${launch.symbol} (${mintKey}), user=${userId}, tx=${signature}`);
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

      if (position) {
        console.log(`[DEBUG] Position saved! id=${position.id}, mint=${mintKey}`);
      } else {
        console.error(`[CRITICAL] Failed to save position to DB! Buy tx ${signature} succeeded on-chain but position was NOT recorded. mint=${mintKey}, user=${userId}`);
      }

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
   * Returns an UNSIGNED transaction without blockhash — caller must set
   * recentBlockhash, feePayer, and sign before sending.
   *
   * Account layout (per current IDL):
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
   *  12  globalVolumeAccumulator   (write)
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
    console.log(`[DEBUG BUY] sol=${buyAmountSol}, lamports=${buyAmountLamports}, maxSolCost=${maxSolCost}`);
    console.log(`[DEBUG BUY] reserves: token=${curve.virtualTokenReserves}, sol=${curve.virtualSolReserves}`);
    console.log(`[DEBUG BUY] expectedTokens=${expectedTokens}, minTokenAmount=${minTokenAmount}`);

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
        { pubkey: PUMP_GLOBAL_VOLUME_ACCUMULATOR, isSigner: false, isWritable: true },     // 12 globalVolumeAccumulator (WRITABLE)
        { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },              // 13 userVolumeAccumulator
        { pubkey: PUMP_FEE_CONFIG, isSigner: false, isWritable: false },                   // 14 feeConfig
        { pubkey: PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },                  // 15 feeProgram
      ],
      data,
    });

    tx.add(buyIx);

    return tx;
  }
}
