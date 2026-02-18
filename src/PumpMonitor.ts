import WebSocket from 'ws';
import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import { CONFIG } from './config';
import { PumpTokenLaunch } from './types';
import { sleep } from './utils';
import { EventEmitter } from 'events';

const PUMP_PROGRAM = new PublicKey(CONFIG.PUMP_PROGRAM_ID);

// Pump.fun "create" instruction discriminator (first 8 bytes of sha256("global:create"))
const CREATE_DISCRIMINATOR = Buffer.from([0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77]);

export class PumpMonitor extends EventEmitter {
  private connection: Connection;
  private wsSubscriptionId: number | null = null;
  private running = false;

  constructor() {
    super();
    this.connection = new Connection(CONFIG.SOLANA_RPC_URL, {
      wsEndpoint: CONFIG.SOLANA_WS_URL,
      commitment: 'confirmed',
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    console.log('[PumpMonitor] Starting Pump.fun launch monitor...');
    console.log(`[PumpMonitor] Watching program: ${PUMP_PROGRAM.toBase58()}`);

    this.subscribeToLogs();
  }

  stop(): void {
    this.running = false;
    if (this.wsSubscriptionId !== null) {
      this.connection.removeOnLogsListener(this.wsSubscriptionId)
        .catch((err) => console.error('[PumpMonitor] Error removing listener:', err));
      this.wsSubscriptionId = null;
    }
    console.log('[PumpMonitor] Stopped.');
  }

  private subscribeToLogs(): void {
    try {
      this.wsSubscriptionId = this.connection.onLogs(
        PUMP_PROGRAM,
        async (logInfo) => {
          if (logInfo.err) return;

          const hasCreate = logInfo.logs.some(
            (line) => line.includes('Program log: Instruction: Create')
          );

          if (hasCreate) {
            console.log(`[PumpMonitor] Detected CREATE tx: ${logInfo.signature}`);
            try {
              const launch = await this.parseCreateTransaction(logInfo.signature);
              if (launch) {
                this.emit('launch', launch);
              }
            } catch (err) {
              console.error(`[PumpMonitor] Error parsing tx ${logInfo.signature}:`, err);
            }
          }
        },
        'confirmed'
      );
      console.log('[PumpMonitor] WebSocket subscription active.');
    } catch (err) {
      console.error('[PumpMonitor] Failed to subscribe:', err);
      // Retry after delay
      if (this.running) {
        setTimeout(() => this.subscribeToLogs(), 5000);
      }
    }
  }

  private async parseCreateTransaction(signature: string): Promise<PumpTokenLaunch | null> {
    // Wait briefly for tx to be fully confirmed and available
    await sleep(2000);

    let tx: ParsedTransactionWithMeta | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (tx) break;
      await sleep(1000);
    }

    if (!tx || !tx.meta || tx.meta.err) return null;

    const accountKeys = tx.transaction.message.accountKeys;

    // Pump.fun create instruction account layout:
    // 0: mint (the new token)
    // 1: mintAuthority
    // 2: bondingCurve
    // 3: associatedBondingCurve
    // 4: global
    // 5: mplTokenMetadata
    // 6: metadata
    // 7: user (creator)
    // ...
    const pumpIx = tx.transaction.message.instructions.find(
      (ix) => 'programId' in ix && ix.programId.equals(PUMP_PROGRAM)
    );

    if (!pumpIx || !('accounts' in pumpIx)) {
      // Try inner instructions
      return this.parseFromInnerInstructions(tx, signature);
    }

    const accounts = (pumpIx as any).accounts as PublicKey[];
    if (!accounts || accounts.length < 8) {
      return this.parseFromInnerInstructions(tx, signature);
    }

    const mint = accounts[0].toBase58();
    const bondingCurve = accounts[2].toBase58();
    const associatedBondingCurve = accounts[3].toBase58();
    const creator = accounts[7].toBase58();

    // Try to extract token metadata from logs
    const { name, symbol, uri } = this.extractMetadataFromLogs(tx.meta.logMessages || []);

    return {
      signature,
      mint,
      name: name || 'Unknown',
      symbol: symbol || 'UNKNOWN',
      uri: uri || '',
      bondingCurve,
      associatedBondingCurve,
      creator,
      timestamp: tx.blockTime || Date.now() / 1000,
    };
  }

  private parseFromInnerInstructions(
    tx: ParsedTransactionWithMeta,
    signature: string
  ): PumpTokenLaunch | null {
    if (!tx.meta?.innerInstructions) return null;

    // Look for the mint creation in inner instructions
    for (const inner of tx.meta.innerInstructions) {
      for (const ix of inner.instructions) {
        if ('parsed' in ix && ix.parsed?.type === 'initializeMint') {
          const mint = ix.parsed.info?.mint;
          if (mint) {
            const { name, symbol, uri } = this.extractMetadataFromLogs(
              tx.meta?.logMessages || []
            );
            return {
              signature,
              mint,
              name: name || 'Unknown',
              symbol: symbol || 'UNKNOWN',
              uri: uri || '',
              bondingCurve: '',
              associatedBondingCurve: '',
              creator: tx.transaction.message.accountKeys[0]?.pubkey?.toBase58() || '',
              timestamp: tx.blockTime || Date.now() / 1000,
            };
          }
        }
      }
    }
    return null;
  }

  private extractMetadataFromLogs(logs: string[]): { name: string; symbol: string; uri: string } {
    let name = '';
    let symbol = '';
    let uri = '';

    for (const line of logs) {
      // Pump.fun logs token info in specific formats
      const nameMatch = line.match(/Name:\s*(.+?)(?:\s*$|,)/);
      const symbolMatch = line.match(/Symbol:\s*(.+?)(?:\s*$|,)/);
      const uriMatch = line.match(/URI:\s*(.+?)(?:\s*$|,)/);

      if (nameMatch) name = nameMatch[1].trim();
      if (symbolMatch) symbol = symbolMatch[1].trim();
      if (uriMatch) uri = uriMatch[1].trim();
    }

    return { name, symbol, uri };
  }
}

