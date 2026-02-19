import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import bs58 from 'bs58';
import { CONFIG } from './config';
import { PumpTokenLaunch } from './types';
import { sleep } from './utils';
import { syslog } from './supabase';
import { EventEmitter } from 'events';

const PUMP_PROGRAM = new PublicKey(CONFIG.PUMP_PROGRAM_ID);
const METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

export class PumpMonitor extends EventEmitter {
  private connection: Connection;
  private wsSubscriptionId: number | null = null;
  private running = false;
  private lastEventTime = Date.now();
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

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
    await syslog('info', `PumpMonitor starting. Watching program: ${PUMP_PROGRAM.toBase58()}`);

    this.subscribeToLogs();

    // Health check: if no events for 60s, the WebSocket is probably dead — reconnect
    this.healthCheckInterval = setInterval(() => {
      const elapsed = Date.now() - this.lastEventTime;
      if (elapsed > 60_000) {
        syslog('warn', `PumpMonitor: no events for ${Math.floor(elapsed / 1000)}s, reconnecting WebSocket...`);
        this.reconnect();
      }
    }, 30_000);
  }

  stop(): void {
    this.running = false;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.wsSubscriptionId !== null) {
      this.connection.removeOnLogsListener(this.wsSubscriptionId)
        .catch((err) => syslog('error', `PumpMonitor error removing listener: ${err.message}`));
      this.wsSubscriptionId = null;
    }
    syslog('info', 'PumpMonitor stopped.');
  }

  private reconnect(): void {
    // Remove old subscription
    if (this.wsSubscriptionId !== null) {
      this.connection.removeOnLogsListener(this.wsSubscriptionId).catch(() => {});
      this.wsSubscriptionId = null;
    }

    // Create fresh connection to force a new WebSocket
    this.connection = new Connection(CONFIG.SOLANA_RPC_URL, {
      wsEndpoint: CONFIG.SOLANA_WS_URL,
      commitment: 'confirmed',
    });

    this.lastEventTime = Date.now(); // Reset timer to avoid immediate re-reconnect
    this.subscribeToLogs();
  }

  private subscribeToLogs(): void {
    try {
      this.wsSubscriptionId = this.connection.onLogs(
        PUMP_PROGRAM,
        async (logInfo) => {
          // Update last event time on ANY event (even non-create) to track WS health
          this.lastEventTime = Date.now();

          if (logInfo.err) return;

          const hasCreate = logInfo.logs.some(
            (line) => line.includes('Program log: Instruction: Create')
          );

          if (hasCreate) {
            await syslog('info', `Detected CREATE tx: ${logInfo.signature}`, {
              signature: logInfo.signature,
            });
            try {
              const launch = await this.parseCreateTransaction(logInfo.signature);
              if (launch) {
                this.emit('launch', launch);
              }
            } catch (err: any) {
              await syslog('error', `Error parsing tx ${logInfo.signature}: ${err.message}`, {
                signature: logInfo.signature,
                error: err.message,
              });
            }
          }
        },
        'confirmed'
      );
      syslog('success', 'PumpMonitor WebSocket subscription active.');
    } catch (err: any) {
      syslog('error', `PumpMonitor failed to subscribe: ${err.message}`, { error: err.message });
      // Retry after delay
      if (this.running) {
        setTimeout(() => this.subscribeToLogs(), 5000);
      }
    }
  }

  private async parseCreateTransaction(signature: string): Promise<PumpTokenLaunch | null> {
    // Short delay for tx to propagate (reduced from 2000ms)
    await sleep(500);

    let tx: ParsedTransactionWithMeta | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (tx) break;
      await sleep(500);
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

    // Extract metadata with fallback chain + diagnostic logging
    console.log(`[METADATA] Attempting extraction for ${mint}`);

    // Method 1: Parse from instruction data (Borsh: discriminator + name + symbol + uri)
    let { name, symbol, uri } = this.extractMetadataFromInstructionData(pumpIx);
    console.log(`[METADATA] Method 1 (instruction data): ${name && symbol ? 'SUCCESS' : 'FAIL'} name="${name}" symbol="${symbol}"`);

    // Method 2: Regex on program log messages
    if (!name && !symbol) {
      ({ name, symbol, uri } = this.extractMetadataFromLogs(tx.meta.logMessages || []));
      console.log(`[METADATA] Method 2 (logs): ${name && symbol ? 'SUCCESS' : 'FAIL'} name="${name}" symbol="${symbol}"`);
    }

    // Method 3: Read Metaplex Token Metadata account (with retries for propagation delay)
    if (!name && !symbol) {
      ({ name, symbol, uri } = await this.fetchMetaplexMetadata(mint));
      console.log(`[METADATA] Method 3 (Metaplex account): ${name && symbol ? 'SUCCESS' : 'FAIL'} name="${name}" symbol="${symbol}"`);
    }

    // Method 4: Read Token-2022 metadata extension from mint account
    if (!name && !symbol) {
      ({ name, symbol, uri } = await this.fetchToken2022Metadata(mint));
      console.log(`[METADATA] Method 4 (Token-2022 extension): ${name && symbol ? 'SUCCESS' : 'FAIL'} name="${name}" symbol="${symbol}"`);
    }

    const finalName = name || 'Unknown';
    const finalSymbol = symbol || 'UNKNOWN';
    console.log(`[METADATA] RESULT: symbol="${finalSymbol}", name="${finalName}"`);

    return {
      signature,
      mint,
      name: finalName,
      symbol: finalSymbol,
      uri: uri || '',
      bondingCurve,
      associatedBondingCurve,
      creator,
      timestamp: tx.blockTime || Date.now() / 1000,
    };
  }

  private async parseFromInnerInstructions(
    tx: ParsedTransactionWithMeta,
    signature: string
  ): Promise<PumpTokenLaunch | null> {
    if (!tx.meta?.innerInstructions) return null;

    let mint: string | null = null;

    // Look for the mint creation in inner instructions
    for (const inner of tx.meta.innerInstructions) {
      for (const ix of inner.instructions) {
        if ('parsed' in ix && ix.parsed?.type === 'initializeMint') {
          mint = ix.parsed.info?.mint || null;
          if (mint) break;
        }
      }
      if (mint) break;
    }

    // Also try to find pump.fun instruction data in inner instructions
    let pumpIxData: any = null;
    for (const inner of tx.meta.innerInstructions) {
      for (const ix of inner.instructions) {
        if ('programId' in ix && (ix as any).programId?.equals?.(PUMP_PROGRAM) && 'data' in ix) {
          pumpIxData = ix;
          break;
        }
      }
      if (pumpIxData) break;
    }

    if (!mint) return null;

    console.log(`[METADATA] (inner) Attempting extraction for ${mint}`);

    // Method 1: Parse pump.fun instruction data from inner instructions
    let name = '';
    let symbol = '';
    let uri = '';
    if (pumpIxData) {
      ({ name, symbol, uri } = this.extractMetadataFromInstructionData(pumpIxData));
      console.log(`[METADATA] (inner) Method 1 (instruction data): ${name && symbol ? 'SUCCESS' : 'FAIL'}`);
    }

    // Method 2: Regex on log messages
    if (!name && !symbol) {
      ({ name, symbol, uri } = this.extractMetadataFromLogs(tx.meta?.logMessages || []));
      console.log(`[METADATA] (inner) Method 2 (logs): ${name && symbol ? 'SUCCESS' : 'FAIL'}`);
    }

    // Method 3: Metaplex metadata account
    if (!name && !symbol) {
      ({ name, symbol, uri } = await this.fetchMetaplexMetadata(mint));
      console.log(`[METADATA] (inner) Method 3 (Metaplex): ${name && symbol ? 'SUCCESS' : 'FAIL'}`);
    }

    // Method 4: Token-2022 metadata extension
    if (!name && !symbol) {
      ({ name, symbol, uri } = await this.fetchToken2022Metadata(mint));
      console.log(`[METADATA] (inner) Method 4 (Token-2022): ${name && symbol ? 'SUCCESS' : 'FAIL'}`);
    }

    const finalName = name || 'Unknown';
    const finalSymbol = symbol || 'UNKNOWN';
    console.log(`[METADATA] (inner) RESULT: symbol="${finalSymbol}", name="${finalName}"`);

    return {
      signature,
      mint,
      name: finalName,
      symbol: finalSymbol,
      uri: uri || '',
      bondingCurve: '',
      associatedBondingCurve: '',
      creator: tx.transaction.message.accountKeys[0]?.pubkey?.toBase58() || '',
      timestamp: tx.blockTime || Date.now() / 1000,
    };
  }

  /**
   * Parse name/symbol/uri from Pump.fun CREATE instruction data.
   * Layout after 8-byte discriminator: Borsh strings (u32 length + utf8 bytes).
   */
  private extractMetadataFromInstructionData(pumpIx: any): { name: string; symbol: string; uri: string } {
    let name = '';
    let symbol = '';
    let uri = '';

    try {
      if (!pumpIx?.data) return { name, symbol, uri };

      const data = Buffer.from(bs58.decode(pumpIx.data));

      // Skip 8-byte Anchor discriminator
      let offset = 8;

      // Read name (Borsh string: u32 length prefix + utf8 bytes)
      if (offset + 4 <= data.length) {
        const nameLen = data.readUInt32LE(offset);
        offset += 4;
        if (nameLen > 0 && nameLen < 200 && offset + nameLen <= data.length) {
          name = data.subarray(offset, offset + nameLen).toString('utf8').replace(/\0/g, '').trim();
          offset += nameLen;
        }
      }

      // Read symbol
      if (offset + 4 <= data.length) {
        const symbolLen = data.readUInt32LE(offset);
        offset += 4;
        if (symbolLen > 0 && symbolLen < 50 && offset + symbolLen <= data.length) {
          symbol = data.subarray(offset, offset + symbolLen).toString('utf8').replace(/\0/g, '').trim();
          offset += symbolLen;
        }
      }

      // Read uri
      if (offset + 4 <= data.length) {
        const uriLen = data.readUInt32LE(offset);
        offset += 4;
        if (uriLen > 0 && uriLen < 500 && offset + uriLen <= data.length) {
          uri = data.subarray(offset, offset + uriLen).toString('utf8').replace(/\0/g, '').trim();
        }
      }

      if (name || symbol) {
        console.log(`[PumpMonitor] Extracted metadata from instruction data: name="${name}", symbol="${symbol}"`);
      }
    } catch (err: any) {
      console.log(`[PumpMonitor] Could not parse instruction data: ${err.message}`);
    }

    return { name, symbol, uri };
  }

  /**
   * Fetch name/symbol/uri from the Metaplex Token Metadata account on-chain.
   * Retries up to 3 times with 500ms delay (account may not be propagated yet).
   */
  private async fetchMetaplexMetadata(mintAddress: string): Promise<{ name: string; symbol: string; uri: string }> {
    let name = '';
    let symbol = '';
    let uri = '';

    try {
      const mint = new PublicKey(mintAddress);
      const [metadataPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('metadata'),
          METADATA_PROGRAM_ID.toBuffer(),
          mint.toBuffer(),
        ],
        METADATA_PROGRAM_ID
      );

      // Retry: metadata account may not be propagated immediately after create tx
      let accountInfo = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        accountInfo = await this.connection.getAccountInfo(metadataPDA);
        if (accountInfo?.data) break;
        await sleep(500);
      }
      if (!accountInfo?.data) return { name, symbol, uri };

      const data = accountInfo.data;

      // Metadata account layout:
      // [1 byte] key, [32 bytes] update_authority, [32 bytes] mint = offset 65
      let offset = 65;

      // Read name (Borsh string: u32 length + utf8 bytes, null-padded to 32 chars)
      if (offset + 4 <= data.length) {
        const nameLen = data.readUInt32LE(offset);
        offset += 4;
        if (nameLen > 0 && nameLen <= 200 && offset + nameLen <= data.length) {
          name = data.subarray(offset, offset + nameLen).toString('utf8').replace(/\0/g, '').trim();
          offset += nameLen;
        }
      }

      // Read symbol (null-padded to 10 chars)
      if (offset + 4 <= data.length) {
        const symbolLen = data.readUInt32LE(offset);
        offset += 4;
        if (symbolLen > 0 && symbolLen <= 50 && offset + symbolLen <= data.length) {
          symbol = data.subarray(offset, offset + symbolLen).toString('utf8').replace(/\0/g, '').trim();
          offset += symbolLen;
        }
      }

      // Read uri (null-padded to 200 chars)
      if (offset + 4 <= data.length) {
        const uriLen = data.readUInt32LE(offset);
        offset += 4;
        if (uriLen > 0 && uriLen <= 500 && offset + uriLen <= data.length) {
          uri = data.subarray(offset, offset + uriLen).toString('utf8').replace(/\0/g, '').trim();
        }
      }
    } catch (err: any) {
      console.log(`[METADATA] Metaplex fetch error: ${err.message}`);
    }

    return { name, symbol, uri };
  }

  /**
   * Fetch name/symbol/uri from Token-2022 metadata extension on the mint account.
   * Pump.fun tokens use Token-2022, which can store metadata inline via TLV extensions.
   *
   * Mint account layout:
   *   [165 bytes] base mint data + padding
   *   [1 byte]    account type (2 = Mint)
   *   [N bytes]   TLV extensions: [u16 type][u16 length][data...]
   *
   * TokenMetadata extension (type 19) data layout:
   *   [32 bytes] update_authority (all zeros = None)
   *   [32 bytes] mint pubkey
   *   name, symbol, uri as Borsh strings (u32 len + utf8)
   */
  private async fetchToken2022Metadata(mintAddress: string): Promise<{ name: string; symbol: string; uri: string }> {
    let name = '';
    let symbol = '';
    let uri = '';

    try {
      const mint = new PublicKey(mintAddress);
      const accountInfo = await this.connection.getAccountInfo(mint);
      if (!accountInfo?.data || accountInfo.data.length <= 166) return { name, symbol, uri };

      const data = accountInfo.data;
      const TOKEN_METADATA_EXTENSION_TYPE = 19;

      // Scan TLV extensions starting at offset 166
      let offset = 166;
      while (offset + 4 <= data.length) {
        const extType = data.readUInt16LE(offset);
        const extLen = data.readUInt16LE(offset + 2);
        offset += 4;

        if (extType === TOKEN_METADATA_EXTENSION_TYPE && extLen > 0 && offset + extLen <= data.length) {
          // Skip update_authority (32 bytes) + mint (32 bytes) = 64 bytes
          let metaOffset = offset + 64;

          // Read name
          if (metaOffset + 4 <= offset + extLen) {
            const nameLen = data.readUInt32LE(metaOffset);
            metaOffset += 4;
            if (nameLen > 0 && nameLen < 200 && metaOffset + nameLen <= offset + extLen) {
              name = data.subarray(metaOffset, metaOffset + nameLen).toString('utf8').replace(/\0/g, '').trim();
              metaOffset += nameLen;
            }
          }

          // Read symbol
          if (metaOffset + 4 <= offset + extLen) {
            const symbolLen = data.readUInt32LE(metaOffset);
            metaOffset += 4;
            if (symbolLen > 0 && symbolLen < 50 && metaOffset + symbolLen <= offset + extLen) {
              symbol = data.subarray(metaOffset, metaOffset + symbolLen).toString('utf8').replace(/\0/g, '').trim();
              metaOffset += symbolLen;
            }
          }

          // Read uri
          if (metaOffset + 4 <= offset + extLen) {
            const uriLen = data.readUInt32LE(metaOffset);
            metaOffset += 4;
            if (uriLen > 0 && uriLen < 500 && metaOffset + uriLen <= offset + extLen) {
              uri = data.subarray(metaOffset, metaOffset + uriLen).toString('utf8').replace(/\0/g, '').trim();
            }
          }

          break; // Found and parsed metadata extension
        }

        offset += extLen;
      }
    } catch (err: any) {
      console.log(`[METADATA] Token-2022 extension fetch error: ${err.message}`);
    }

    return { name, symbol, uri };
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
