import type { Address, Hex } from 'viem';
import type { NetworkKey } from './config';

export interface Receipt {
  version: 2;
  name: string;
  stealthAddress: Address;
  amount: string;
  transferTx: Hex;
  announceTx: Hex;
  date: string;
  network: NetworkKey;
  asset: 'USDC';
}

export function receiptFragment(receipt: Receipt): string {
  const bytes = new TextEncoder().encode(JSON.stringify(receipt));
  const binary = Array.from(bytes, b => String.fromCharCode(b)).join('');
  return '#/receipt/' + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function readReceipt(hash: string): Receipt | null {
  try {
    const data = hash.slice('#/receipt/'.length);
    if (!hash.startsWith('#/receipt/') || !data || data.length > 24000 || !/^[A-Za-z0-9_-]+$/.test(data)) return null;
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0))));
    if (!parsed || typeof parsed !== 'object') return null;
    const r = parsed as Receipt;
    if (r.version !== 2 || (r.network !== 'base-sepolia' && r.network !== 'base') || r.asset !== 'USDC') return null;
    for (const key of ['name', 'stealthAddress', 'amount', 'transferTx', 'announceTx', 'date'] as const)
      if (typeof r[key] !== 'string') return null;
    if (r.name.length > 120 || !/^0x[a-f0-9]{40}$/i.test(r.stealthAddress) || !/^0x[a-f0-9]{64}$/i.test(r.transferTx) || !/^0x[a-f0-9]{64}$/i.test(r.announceTx) || !/^\d+(\.\d{1,6})?$/.test(r.amount) || r.amount.length > 32 || !Number.isFinite(Date.parse(r.date))) return null;
    return r;
  } catch { return null; }
}
