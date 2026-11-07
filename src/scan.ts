import { getAddress, type Address, type Hex } from 'viem';
import { LOG_CHUNK_BLOCKS } from './config';
import { checkAnnouncement, stealthPrivateKey, type StealthKeys } from './stealth';

export interface AnnouncementLog {
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  metadata: Hex;
  txHash: Hex;
  blockNumber: bigint;
}
export interface FoundPayment extends AnnouncementLog {
  privateKey: Hex;
  /** From the metadata when the payer followed the token-transfer layout. Informational only. */
  announcedToken?: Address;
  announcedAmount?: bigint;
}

const TRANSFER_SELECTOR = 'a9059cbb';

/** Metadata layout for token transfers: view tag, selector, token address, 32-byte amount. */
export function parseMetadata(metadata: Hex): { token?: Address; amount?: bigint } {
  const hex = metadata.slice(2).toLowerCase();
  if (hex.length < 2 * 57 || hex.slice(2, 10) !== TRANSFER_SELECTOR) return {};
  return { token: getAddress(`0x${hex.slice(10, 50)}`), amount: BigInt(`0x${hex.slice(50, 114)}`) };
}

/** Keeps the announcements addressed to these keys, one per stealth address. */
export function matchAnnouncements(keys: Pick<StealthKeys, 'spendingPrivateKey' | 'viewingPrivateKey'>, logs: AnnouncementLog[]): FoundPayment[] {
  const found = new Map<Address, FoundPayment>();
  for (const log of logs) {
    const address = getAddress(log.stealthAddress);
    if (found.has(address) || !checkAnnouncement(keys, log.ephemeralPublicKey, log.metadata, address)) continue;
    const { token, amount } = parseMetadata(log.metadata);
    found.set(address, { ...log, stealthAddress: address, privateKey: stealthPrivateKey(keys, log.ephemeralPublicKey), announcedToken: token, announcedAmount: amount });
  }
  return [...found.values()];
}

/**
 * Fetches [fromBlock, toBlock] in RPC-sized chunks, a few at a time, retrying each chunk.
 * Results come back in block order whatever order the chunks finish in.
 */
export async function fetchAnnouncements(args: {
  fromBlock: bigint; toBlock: bigint;
  getLogs: (from: bigint, to: bigint) => Promise<AnnouncementLog[]>;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal; concurrency?: number; chunk?: bigint; retries?: number;
}): Promise<AnnouncementLog[]> {
  const { fromBlock, toBlock, getLogs, signal } = args;
  const chunk = args.chunk ?? LOG_CHUNK_BLOCKS, retries = args.retries ?? 3;
  const ranges: [bigint, bigint][] = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) ranges.push([start, start + chunk - 1n < toBlock ? start + chunk - 1n : toBlock]);
  const results: AnnouncementLog[][] = new Array(ranges.length);
  let next = 0, done = 0;
  args.onProgress?.(0, ranges.length);
  const worker = async () => {
    while (next < ranges.length) {
      const index = next++;
      for (let attempt = 0; ; attempt++) {
        if (signal?.aborted) throw new DOMException('Scan stopped.', 'AbortError');
        try { results[index] = await getLogs(...ranges[index]); break; }
        catch (error) {
          if (attempt >= retries) throw error;
          // Public endpoints rate-limit bursts; back off before retrying this chunk.
          await new Promise(r => setTimeout(r, 400 * 2 ** attempt));
        }
      }
      args.onProgress?.(++done, ranges.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(args.concurrency ?? 4, ranges.length) }, worker));
  return results.flat();
}

/** Base produces a block every 2 seconds; good enough to turn a date into a start block. */
export function blockAtDate(latest: bigint, date: Date, now = Date.now()) {
  const blocksAgo = BigInt(Math.max(0, Math.ceil((now - date.getTime()) / 2000)));
  return latest > blocksAgo ? latest - blocksAgo : 0n;
}
