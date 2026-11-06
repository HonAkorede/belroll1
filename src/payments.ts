import type { Address, Hex } from 'viem';
import { CHAIN_ID, JOURNAL_KEY, NETWORK, RECOVERY_WINDOW_MS } from './config';
import type { CsvRow } from './csv';
import { announcementMetadata, generateStealthPayment, type StealthPayment } from './stealth';

export type PaymentStatus = 'ready' | 'pending' | 'transferred' | 'sent' | 'failed' | 'unresolved';
export interface PaymentRow extends CsvRow, StealthPayment {
  key: string;
  payloadHash: string;
  status: PaymentStatus;
  error?: string;
  transferTx?: Hex;
  announceTx?: Hex;
  sentAt?: string;
}
type JournalState = 'pending' | 'transferred' | 'sent' | 'failed' | 'unresolved';
interface Entry extends StealthPayment {
  payloadHash: string;
  state: JournalState;
  attemptedAt: number;
  fromBlock: string;
  transferTx?: Hex;
  announceTx?: Hex;
  sentAt?: string;
}
interface JournalData {
  version: 2;
  runs: Record<string, string>;
  entries: Record<string, Entry>;
}
export type JournalStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Everything the payroll needs from the wallet and the chain. Implemented with wagmi in chain.ts. */
export interface ChainClient {
  getChainId(): Promise<number | undefined>;
  getAccount(): Promise<Address | undefined>;
  getBlockNumber(): Promise<bigint>;
  usdcBalance(owner: Address): Promise<bigint>;
  supportsBatch(): Promise<boolean>;
  /** Resolves with the transaction hash once the wallet has signed and broadcast. */
  sendTransfer(to: Address, amount: bigint): Promise<Hex>;
  sendAnnounce(payment: StealthPayment, metadata: Hex): Promise<Hex>;
  /** Transfer and announce atomically (EIP-5792). Resolves once included. */
  sendBatch(to: Address, amount: bigint, payment: StealthPayment, metadata: Hex): Promise<{ hash: Hex; ok: boolean }>;
  /** True when the transaction succeeded, false when it reverted. Throws on timeout. */
  confirm(hash: Hex): Promise<boolean>;
  findTransfer(from: Address, to: Address, amount: bigint, fromBlock: bigint): Promise<Hex | null>;
  findAnnouncement(stealthAddress: Address, fromBlock: bigint): Promise<Hex | null>;
}

const hash64 = /^[a-f0-9]{64}$/, txHash = /^0x[a-f0-9]{64}$/i;
const validEntry = (key: string, e: Entry) => /^belroll_[a-f0-9]{64}$/.test(key) && !!e
  && ['pending', 'transferred', 'sent', 'failed', 'unresolved'].includes(e.state) && hash64.test(e.payloadHash)
  && Number.isFinite(e.attemptedAt) && /^\d+$/.test(e.fromBlock) && /^0x[a-f0-9]{40}$/i.test(e.stealthAddress)
  && /^0x0[23][a-f0-9]{64}$/.test(e.ephemeralPublicKey) && /^0x[a-f0-9]{2}$/.test(e.viewTag)
  && [e.transferTx, e.announceTx].every(h => h === undefined || txHash.test(h))
  && (e.state !== 'sent' || (!!e.transferTx && !!e.announceTx && !!e.sentAt && Number.isFinite(Date.parse(e.sentAt))));

export class PaymentJournal {
  constructor(private storage: JournalStorage) {}
  private read(): JournalData {
    try {
      const raw = this.storage.getItem(JOURNAL_KEY);
      if (raw === null) return { version: 2, runs: {}, entries: {} };
      const d = JSON.parse(raw) as JournalData;
      if (d.version !== 2 || !d.runs || !d.entries || typeof d.runs !== 'object' || typeof d.entries !== 'object' || Array.isArray(d.runs) || Array.isArray(d.entries)) throw new Error();
      for (const [key, entry] of Object.entries(d.entries)) if (!validEntry(key, entry)) throw new Error();
      if (Object.entries(d.runs).some(([k, v]) => !hash64.test(k) || typeof v !== 'string' || !hash64.test(v))) throw new Error();
      return d;
    } catch { throw new Error('The local payment journal cannot be read. Sending is blocked. Keep this browser data and reconcile payments on BaseScan before starting another run.'); }
  }
  private write(data: JournalData) {
    try {
      const serialized = JSON.stringify(data);
      this.storage.setItem(JOURNAL_KEY, serialized);
      if (this.storage.getItem(JOURNAL_KEY) !== serialized) throw new Error();
    } catch { throw new Error('The payment journal could not be saved. Sending has stopped. Allow local browser storage before continuing; check your wallet for any payment already approved.'); }
  }
  get(key: string): Entry | undefined { return this.read().entries[key]; }
  assertRun(runKey: string, fingerprint: string) {
    const saved = this.read().runs[runKey];
    if (saved && saved !== fingerprint) throw new Error('This pay run reference already has a different CSV. Restore the original CSV to resume. Use a new reference only for a separate payroll.');
  }
  bindRun(runKey: string, fingerprint: string) {
    this.assertRun(runKey, fingerprint);
    const d = this.read(); d.runs[runKey] = fingerprint; this.write(d);
  }
  put(key: string, entry: Entry) {
    const d = this.read(); d.entries[key] = entry; this.write(d);
  }
  /** The user confirmed in their wallet that an unresolved transfer never happened. */
  release(key: string) {
    const entry = this.get(key);
    if (!entry || entry.state !== 'unresolved' || entry.transferTx) throw new Error('Only an unresolved payment with no transaction hash can be retried.');
    this.put(key, { ...entry, state: 'failed' });
  }
}

export async function digest(data: unknown): Promise<string> {
  const buffer = new TextEncoder().encode(JSON.stringify(data));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), b => b.toString(16).padStart(2, '0')).join('');
}

export async function assertWallet(chain: Pick<ChainClient, 'getChainId' | 'getAccount'>, owner: Address, guard = () => {}) {
  guard();
  if (await chain.getChainId() !== CHAIN_ID) throw new Error(`Switch your wallet to ${NETWORK.label}, then continue. Other networks are blocked.`);
  const account = await chain.getAccount();
  if (account?.toLowerCase() !== owner.toLowerCase()) throw new Error('The wallet account changed. Reconnect and review this payroll again.');
  guard();
}

export async function preparePayments(args: {
  chain: ChainClient; owner: Address; reference: string; rows: CsvRow[];
  journal: PaymentJournal; guard?: () => void;
}) {
  const { chain, owner, rows, journal } = args;
  await assertWallet(chain, owner, args.guard);
  const reference = args.reference.trim();
  if (!reference || reference.length > 120) throw new Error('Enter a pay run reference of 1 to 120 characters. Keep it unchanged when resuming.');
  const runKey = await digest([CHAIN_ID, owner.toLowerCase(), reference]);
  const fingerprint = await digest(rows.map(({ name, metaAddress, atomic }) => [name, metaAddress, atomic]));
  journal.assertRun(runKey, fingerprint);
  const prepared: PaymentRow[] = [];
  for (const row of rows) {
    args.guard?.();
    const key = 'belroll_' + await digest([runKey, prepared.length]);
    const payloadHash = await digest([row.metaAddress, row.atomic, NETWORK.usdc, CHAIN_ID]);
    const entry = journal.get(key);
    if (entry && entry.payloadHash !== payloadHash) throw new Error(`Line ${row.line}: the recipient or amount changed after an attempt. Sending is blocked. Reconcile this payment on BaseScan.`);
    // Reuse the one-time address of any earlier attempt so a resume can never pay a second address.
    const stealth: StealthPayment = entry
      ? { stealthAddress: entry.stealthAddress, ephemeralPublicKey: entry.ephemeralPublicKey, viewTag: entry.viewTag }
      : generateStealthPayment(row.metaAddress);
    prepared.push({ ...row, ...stealth, key, payloadHash,
      status: entry?.state === 'pending' ? 'unresolved' : entry?.state ?? 'ready',
      transferTx: entry?.transferTx, announceTx: entry?.announceTx, sentAt: entry?.sentAt });
  }
  const balance = await chain.usdcBalance(owner);
  await assertWallet(chain, owner, args.guard);
  return { rows: prepared, runKey, fingerprint, balance };
}

export function remainingAtomic(rows: PaymentRow[]) {
  return rows.filter(r => r.status !== 'sent' && r.status !== 'transferred').reduce((total, r) => total + BigInt(r.atomic), 0n);
}

function causes(error: unknown): { code?: unknown; name?: unknown; shortMessage?: unknown }[] {
  const list = [];
  for (let e = error, depth = 0; e && typeof e === 'object' && depth < 8; e = (e as { cause?: unknown }).cause, depth++) list.push(e as object);
  return list;
}
export const isRejection = (error: unknown) => causes(error).some(e => e.code === 4001 || e.name === 'UserRejectedRequestError');

export function paymentError(error: unknown): string {
  const chain = causes(error);
  if (isRejection(error)) return 'Declined in wallet. No further payments were requested. Resume when you are ready.';
  if (chain.some(e => e.name === 'ChainMismatchError' || e.code === 4902)) return `Switch your wallet to ${NETWORK.label}, then resume.`;
  if (chain.some(e => e.name === 'InsufficientFundsError')) return `This wallet needs ${NETWORK.label} ETH for gas. Add some, then resume.`;
  if (chain.some(e => e.name === 'WaitForTransactionReceiptTimeoutError' || e.name === 'WaitForCallsStatusTimeoutError')) return 'The transaction has not confirmed yet. Keep this browser open and resume to check it again.';
  if (error instanceof Error && !('shortMessage' in error)) return error.message;
  const short = chain.find(e => typeof e.shortMessage === 'string')?.shortMessage as string | undefined;
  return short ? `The wallet could not complete this request: ${short}` : 'The wallet could not complete this request. Check your wallet activity before resuming.';
}

/** All sending goes through this factory's single sendPayment(row) function.
 * Each row is a USDC transfer to its one-time address, then an ERC-5564 announcement.
 * The journal is written before every wallet request, and earlier attempts are
 * looked up on-chain before anything is sent again.
 */
export function createPaymentSender(args: {
  chain: ChainClient; owner: Address; journal: PaymentJournal;
  onUpdate: (row: PaymentRow) => void; guard?: () => void; now?: () => number;
}) {
  const { chain, owner, journal, onUpdate } = args;
  const now = args.now ?? Date.now;
  return async function sendPayment(row: PaymentRow): Promise<PaymentRow> {
    await assertWallet(chain, owner, args.guard);
    const previous = journal.get(row.key);
    if (previous && previous.payloadHash !== row.payloadHash) throw new Error('Payment details changed. Sending is blocked to protect this run.');
    if (previous && previous.stealthAddress !== row.stealthAddress) throw new Error('The one-time address changed. Sending is blocked to protect this run.');
    if (previous?.state === 'sent') {
      const sent = { ...row, status: 'sent' as const, transferTx: previous.transferTx, announceTx: previous.announceTx, sentAt: previous.sentAt, error: undefined };
      onUpdate(sent); return sent;
    }
    const retrying = previous && previous.state !== 'failed';
    if (retrying && now() - previous.attemptedAt >= RECOVERY_WINDOW_MS)
      throw new Error(`Line ${row.line}: automatic recovery has expired. Do not resend or create a new reference for this payment. Check ${row.stealthAddress} on BaseScan.`);
    const amount = BigInt(row.atomic);
    const metadata = announcementMetadata(row.viewTag, NETWORK.usdc, amount);
    const fromBlock = retrying ? BigInt(previous.fromBlock) : await chain.getBlockNumber();
    let entry: Entry = retrying ? previous : {
      payloadHash: row.payloadHash, stealthAddress: row.stealthAddress, ephemeralPublicKey: row.ephemeralPublicKey, viewTag: row.viewTag,
      state: 'pending', attemptedAt: now(), fromBlock: fromBlock.toString(),
    };
    let current: PaymentRow = { ...row, status: entry.state === 'transferred' ? 'transferred' : 'pending', error: undefined };
    const save = (patch: Partial<Entry>, status?: PaymentStatus, extra: Partial<PaymentRow> = {}) => {
      entry = { ...entry, ...patch }; journal.put(row.key, entry);
      if (status) { current = { ...current, status, ...extra }; onUpdate(current); }
    };
    const finish = (announceTx: Hex) => {
      const sentAt = new Date(now()).toISOString();
      save({ state: 'sent', announceTx, sentAt }, 'sent', { announceTx, transferTx: entry.transferTx, sentAt });
    };

    try {
      // Phase 1: the USDC transfer. Never send it twice.
      if (entry.state !== 'transferred') {
        let landed = retrying ? await chain.findTransfer(owner, row.stealthAddress, amount, fromBlock) : null;
        if (!landed && retrying && entry.transferTx) {
          if (await chain.confirm(entry.transferTx)) landed = entry.transferTx;
          else save({ state: 'failed', transferTx: undefined });
        } else if (!landed && retrying) {
          save({ state: 'unresolved' });
          throw new Error(`Line ${row.line}: no USDC transfer to this one-time address was found on-chain. Check your wallet activity. If nothing is pending there, choose “Not sent, retry”.`);
        }
        if (landed) save({ state: 'transferred', transferTx: landed }, 'transferred', { transferTx: landed });
        else {
          args.guard?.();
          // This durable write MUST finish before a wallet request can happen.
          save({ state: 'pending', attemptedAt: entry.state === 'failed' ? now() : entry.attemptedAt }, 'pending');
          if (await chain.supportsBatch()) {
            const { hash, ok } = await chain.sendBatch(row.stealthAddress, amount, row, metadata);
            if (!ok) { save({ state: 'failed' }, 'failed', { error: 'The batch reverted. Nothing was paid. Check your USDC balance, then resume.' }); return current; }
            save({ state: 'transferred', transferTx: hash }, 'transferred', { transferTx: hash });
            finish(hash); return current;
          }
          const hash = await chain.sendTransfer(row.stealthAddress, amount);
          save({ transferTx: hash });
          if (!await chain.confirm(hash)) { save({ state: 'failed', transferTx: undefined }, 'failed', { error: 'The USDC transfer reverted. Nothing was paid. Check your USDC balance, then resume.' }); return current; }
          save({ state: 'transferred' }, 'transferred', { transferTx: hash });
        }
      }
      // Phase 2: the announcement. A duplicate is harmless, but look first anyway.
      args.guard?.();
      const announced = retrying ? await chain.findAnnouncement(row.stealthAddress, fromBlock) : null;
      if (announced) { finish(announced); return current; }
      const hash = await chain.sendAnnounce(row, metadata);
      if (!await chain.confirm(hash)) throw new Error('The announcement reverted. The USDC has arrived; resume to announce again.');
      finish(hash);
    } catch (error) {
      const message = paymentError(error);
      if (entry.state === 'transferred') current = { ...current, status: 'transferred', error: `The USDC has arrived, but the announcement was not published. ${message}` };
      else {
        const state = isRejection(error) ? 'failed' : 'unresolved';
        current = { ...current, status: state, error: message };
        // A wallet error is not proof that nothing was broadcast. Recovery searches the chain first.
        try { journal.put(row.key, { ...entry, state }); } catch { /* The pre-send pending record remains. Stop the run. */ }
      }
    }
    onUpdate(current);
    return current;
  };
}

export async function sendSequentially(rows: PaymentRow[], sendPayment: (row: PaymentRow) => Promise<PaymentRow>, shouldPause = () => false) {
  const results: PaymentRow[] = [];
  for (const row of rows) {
    if (shouldPause()) break;
    if (row.status === 'sent') { results.push(row); continue; }
    const result = await sendPayment(row);
    results.push(result);
    if (result.status !== 'sent') break;
  }
  return results;
}
