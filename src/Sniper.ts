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
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { CONFIG } from './config';
import { SniperConfig, PumpTokenLaunch, SniperPosition } from './types';
import { insertPosition, log, getOpenPositions } from './supabase';

const PUMP_PROGRAM = new PublicKey(CONFIG.PUMP_PROGRAM_ID);

// Pump.fun "buy" instruction discriminator
const BUY_DISCRIMINATOR = Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]);

// Pump.fun global state account
const PUMP_GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const PUMP_FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJ83zX7FnHR1');
const PUMP_EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

export class Sniper {
  private connection: Connection;
  private activeSnipes = new Map<string, boolean>(); // mint -> in progress

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

    // Prevent duplicate snipes
    if (this.activeSnipes.has(mintKey)) {
      await log(userId, 'warn', `Already sniping ${launch.symbol} (${mintKey}), skipping`);
      return null;
    }

    // Check position limit
    const openPositions = await getOpenPositions(userId);
    if (openPositions.length >= userConfig.max_concurrent_positions) {
      await log(userId, 'warn', `Max positions (${userConfig.max_concurrent_positions}) reached, skipping ${launch.symbol}`);
      return null;
    }

    this.activeSnipes.set(mintKey, true);

    try {
      await log(userId, 'info', `Sniping ${launch.symbol} (${mintKey}) with ${userConfig.buy_amount_sol} SOL`, {
        mint: mintKey,
        symbol: launch.symbol,
        buyAmount: userConfig.buy_amount_sol,
      });

      const wallet = Keypair.fromSecretKey(bs58.decode(userConfig.bot_wallet_private_key));
      const mint = new PublicKey(mintKey);

      // Build the buy transaction
      const tx = await this.buildBuyTransaction(
        wallet,
        mint,
        launch,
        userConfig.buy_amount_sol,
        userConfig.slippage_bps,
        userConfig.priority_fee_lamports
      );

      // Send and confirm
      const signature = await sendAndConfirmTransaction(this.connection, tx, [wallet], {
        commitment: 'confirmed',
        maxRetries: 3,
      });

      await log(userId, 'success', `Buy executed for ${launch.symbol}: ${signature}`, {
        mint: mintKey,
        signature,
      });

      // Get token balance after buy
      const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
      let tokenBalance = 0;
      try {
        const balanceResp = await this.connection.getTokenAccountBalance(ata);
        tokenBalance = parseFloat(balanceResp.value.uiAmountString || '0');
      } catch {
        // ATA might not be indexed yet
        tokenBalance = 0;
      }

      // Calculate entry price
      const entryPrice = tokenBalance > 0
        ? userConfig.buy_amount_sol / tokenBalance
        : 0;

      // Record position
      const position = await insertPosition({
        user_id: userId,
        token_mint: mintKey,
        token_name: launch.name,
        token_symbol: launch.symbol,
        entry_price_sol: entryPrice,
        amount_tokens: tokenBalance,
        amount_sol_spent: userConfig.buy_amount_sol,
        current_price_sol: entryPrice,
        pnl_pct: 0,
        status: 'open',
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

    // Add priority fee
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

    // Create ATA if needed
    const ata = await getAssociatedTokenAddress(mint, wallet.publicKey);
    const ataInfo = await this.connection.getAccountInfo(ata);
    if (!ataInfo) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          ata,
          wallet.publicKey,
          mint
        )
      );
    }

    // Pump.fun buy instruction
    const buyAmountLamports = Math.floor(buyAmountSol * LAMPORTS_PER_SOL);
    // Max SOL cost including slippage
    const maxSolCost = buyAmountLamports + Math.floor(buyAmountLamports * slippageBps / 10000);

    // Encode buy instruction data
    // Discriminator (8 bytes) + amount (u64) + maxSolCost (u64)
    const data = Buffer.alloc(24);
    BUY_DISCRIMINATOR.copy(data, 0);
    // For pump.fun buys, "amount" is the token amount to buy (0 = use SOL amount)
    // We use max u64 to indicate "buy as much as possible with this SOL"
    data.writeBigUInt64LE(BigInt(0), 8); // token amount (0 = buy with SOL)
    data.writeBigUInt64LE(BigInt(maxSolCost), 16); // max SOL cost

    const bondingCurve = launch.bondingCurve
      ? new PublicKey(launch.bondingCurve)
      : await this.deriveBondingCurve(mint);

    const associatedBondingCurve = launch.associatedBondingCurve
      ? new PublicKey(launch.associatedBondingCurve)
      : await getAssociatedTokenAddress(mint, bondingCurve, true);

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
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
        { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM, isSigner: false, isWritable: false },
      ],
      data,
    });

    tx.add(buyIx);

    // Set recent blockhash
    const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    return tx;
  }

  private async deriveBondingCurve(mint: PublicKey): Promise<PublicKey> {
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding-curve'), mint.toBuffer()],
      PUMP_PROGRAM
    );
    return bondingCurve;
  }
}
