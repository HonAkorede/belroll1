import type { Hex } from 'viem';
import { ANNOUNCER_ADDRESS, CHAIN_ID, NETWORK } from './config';
import { keysFromPrivateKeys, type StealthKeys } from './stealth';

/** A recipient's keys plus the block they were created at, so scanning can start there. */
export interface KeyBundle extends StealthKeys {
  startBlock?: bigint;
}
export type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const KEYS_STORAGE = 'nightroll.keys.v1';

export function backupJson(keys: KeyBundle) {
  return JSON.stringify({
    app: 'Nightroll', format: 'erc5564-scheme-1-keys', network: NETWORK.label, chainId: CHAIN_ID,
    metaAddress: keys.metaAddress, spendingPrivateKey: keys.spendingPrivateKey, viewingPrivateKey: keys.viewingPrivateKey,
    startBlock: keys.startBlock?.toString(), announcer: ANNOUNCER_ADDRESS, createdAt: new Date().toISOString(),
    warning: 'Anyone with the spending key can take your payments. Never paste these keys into a chat, form or website you do not trust.',
  }, null, 2);
}

/**
 * Accepts a backup file's JSON (Nightroll or the earlier Belroll format) or two private keys,
 * spending first, separated by whitespace or a comma. The meta-address is always re-derived.
 */
export function parseKeys(input: string): KeyBundle {
  const text = input.trim();
  if (text.startsWith('{')) {
    let data: Record<string, unknown>;
    try { data = JSON.parse(text); } catch { throw new Error('This backup is not valid JSON. Paste the whole file, including the braces.'); }
    if (typeof data.spendingPrivateKey !== 'string' || typeof data.viewingPrivateKey !== 'string') throw new Error('This backup has no spendingPrivateKey and viewingPrivateKey.');
    const keys = keysFromPrivateKeys(NETWORK.shortName, data.spendingPrivateKey as Hex, data.viewingPrivateKey as Hex);
    if (typeof data.metaAddress === 'string' && data.metaAddress.split(':').pop()?.toLowerCase() !== keys.metaAddress.split(':').pop())
      throw new Error('The keys in this backup do not match its meta-address. The file may be damaged.');
    // A start block only means something on the chain it was read from.
    const startBlock = data.chainId === CHAIN_ID && typeof data.startBlock === 'string' && /^\d+$/.test(data.startBlock) ? BigInt(data.startBlock) : undefined;
    return { ...keys, startBlock };
  }
  const parts = text.split(/[\s,]+/).filter(Boolean);
  if (parts.length !== 2) throw new Error('Paste the backup file, or exactly two private keys: spending first, then viewing.');
  return keysFromPrivateKeys(NETWORK.shortName, parts[0] as Hex, parts[1] as Hex);
}

export function saveKeys(storage: KeyStorage, keys: KeyBundle) {
  storage.setItem(KEYS_STORAGE, backupJson(keys));
}
export function loadKeys(storage: KeyStorage): KeyBundle | null {
  try { const raw = storage.getItem(KEYS_STORAGE); return raw ? parseKeys(raw) : null; }
  catch { return null; }
}
export function forgetKeys(storage: KeyStorage) { storage.removeItem(KEYS_STORAGE); }
