import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAddress } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { parseCsv } from '../src/csv';
import { createPaymentSender, PaymentJournal, paymentError, preparePayments, sendSequentially, type ChainClient, type JournalStorage, type PaymentRow } from '../src/payments';
import { CHAIN_ID, JOURNAL_KEY, NETWORK, RECOVERY_WINDOW_MS } from '../src/config';
import { generateKeys, stealthPrivateKey, type StealthPayment } from '../src/stealth';

const owner: Address = '0x00000000000000000000000000000000000000aa';
const keys = [generateKeys('basesep'), generateKeys('basesep'), generateKeys('basesep')];
const csv = `name,stealth_meta_address,amount\nAda,${keys[0].metaAddress},0.1\n"Sam, design",${keys[1].metaAddress},0.2\nTaylor,${keys[2].metaAddress},0.3`;
const rejection = Object.assign(new Error('User rejected the request.'), { code: 4001 });
const timeout = Object.assign(new Error('Timed out'), { name: 'WaitForTransactionReceiptTimeoutError', shortMessage: 'Timed out' });

class MemoryStorage implements JournalStorage {
  data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, v); }
}
type Response = Error | 'success' | 'revert' | 'unknown' | 'timeout';
class FakeChain implements ChainClient {
  chainId: number = CHAIN_ID; account: Address = owner; block = 100n; balance = 10n ** 12n; batch = false;
  requests: string[] = []; active = 0; maxActive = 0;
  transfers: { to: Address; amount: bigint; hash: Hex; ok: boolean }[] = [];
  announcements: { payment: StealthPayment; metadata: Hex; hash: Hex }[] = [];
  transferResponses: Response[] = []; announceResponses: Response[] = []; ethResponses: Response[] = [];
  eth = new Map<Address, bigint>();
  receipts = new Map<Hex, boolean | 'timeout'>();
  private nextHash() { return `0x${(this.requests.length + 1).toString(16).padStart(64, '0')}` as Hex; }
  private async respond(responses: Response[], record: (hash: Hex, ok: boolean) => void) {
    this.active++; this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise(r => setTimeout(r, 1));
    this.active--;
    const response = responses.shift() ?? 'success', hash = this.nextHash();
    if (response instanceof Error) throw response;
    record(hash, response !== 'revert');
    this.receipts.set(hash, response === 'timeout' ? 'timeout' : response !== 'revert');
    // Broadcast succeeded, but the page never learned the hash.
    if (response === 'unknown') throw new Error('connection lost');
    return hash;
  }
  async getChainId() { return this.chainId; }
  async getAccount() { return this.account; }
  async getBlockNumber() { return this.block++; }
  async usdcBalance() { return this.balance; }
  async ethBalance(owner: Address) { return this.eth.get(owner) ?? (owner === this.account ? 10n ** 18n : 0n); }
  async supportsBatch() { return this.batch; }
  async sendTransfer(to: Address, amount: bigint) {
    this.requests.push('transfer');
    return this.respond(this.transferResponses, (hash, ok) => this.transfers.push({ to, amount, hash, ok }));
  }
  async sendAnnounce(payment: StealthPayment, metadata: Hex) {
    this.requests.push('announce');
    return this.respond(this.announceResponses, (hash, ok) => { if (ok) this.announcements.push({ payment, metadata, hash }); });
  }
  async sendEth(to: Address, value: bigint) {
    this.requests.push('eth');
    return this.respond(this.ethResponses, (_hash, ok) => { if (ok) this.eth.set(to, (this.eth.get(to) ?? 0n) + value); });
  }
  async sendBatch(to: Address, amount: bigint, payment: StealthPayment, metadata: Hex, topUp: bigint) {
    this.requests.push(topUp ? 'batch+eth' : 'batch');
    const hash = await this.respond(this.transferResponses, (h, ok) => {
      this.transfers.push({ to, amount, hash: h, ok });
      if (ok) { this.announcements.push({ payment, metadata, hash: h }); if (topUp) this.eth.set(to, topUp); }
    });
    return { hash, ok: this.receipts.get(hash) === true };
  }
  async confirm(hash: Hex) {
    const receipt = this.receipts.get(hash);
    if (receipt === undefined || receipt === 'timeout') throw timeout;
    return receipt;
  }
  async findTransfer(from: Address, to: Address, amount: bigint) {
    assert.equal(from, owner);
    return this.transfers.find(t => t.ok && t.to === to && t.amount === amount && this.receipts.get(t.hash) === true)?.hash ?? null;
  }
  async findAnnouncement(stealthAddress: Address) {
    return this.announcements.find(a => a.payment.stealthAddress === stealthAddress)?.hash ?? null;
  }
}

async function setup(storage = new MemoryStorage(), topUp = 0n) {
  const chain = new FakeChain();
  const journal = new PaymentJournal(storage);
  const rows = parseCsv(csv).rows;
  const args = { chain, owner, reference: 'October payroll', rows, journal, topUp };
  const prepared = await preparePayments(args);
  journal.bindRun(prepared.runKey, prepared.fingerprint);
  const updates: PaymentRow[] = [];
  const sender = createPaymentSender({ chain, owner, journal, onUpdate: r => updates.push(r) });
  return { ...args, storage, prepared, updates, sender };
}

test('sends exact USDC units to a fresh one-time address per row, then announces each', async () => {
  const s = await setup();
  assert.equal(s.chain.requests.length, 0, 'review must not send');
  const results = await sendSequentially(s.prepared.rows, s.sender);
  assert.deepEqual(results.map(r => r.status), ['sent', 'sent', 'sent']);
  assert.deepEqual(s.chain.requests, ['transfer', 'announce', 'transfer', 'announce', 'transfer', 'announce']);
  assert.equal(s.chain.maxActive, 1);
  assert.deepEqual(s.chain.transfers.map(t => t.amount), [100000n, 200000n, 300000n]);
  assert.equal(new Set(s.chain.transfers.map(t => t.to)).size, 3);
  s.chain.transfers.forEach((t, i) => {
    assert.equal(t.to, s.prepared.rows[i].stealthAddress);
    // Only the intended recipient can derive the key for their address.
    assert.equal(privateKeyToAddress(stealthPrivateKey(keys[i], s.chain.announcements[i].payment.ephemeralPublicKey)), t.to);
    assert.ok(s.chain.announcements[i].metadata.startsWith(s.prepared.rows[i].viewTag + 'a9059cbb' + NETWORK.usdc.slice(2).toLowerCase()));
  });
  assert.deepEqual(s.updates.slice(0, 3).map(r => r.status), ['pending', 'transferred', 'sent']);
  assert.ok(results.every(r => r.transferTx && r.announceTx && r.sentAt));
});

test('uses one atomic batch per row when the wallet supports it', async () => {
  const s = await setup(); s.chain.batch = true;
  const results = await sendSequentially(s.prepared.rows, s.sender);
  assert.deepEqual(results.map(r => r.status), ['sent', 'sent', 'sent']);
  assert.deepEqual(s.chain.requests, ['batch', 'batch', 'batch']);
});

test('stops on rejection and resumes to the same address without resending a sent row', async () => {
  const s = await setup();
  s.chain.transferResponses = ['success', rejection];
  const first = await sendSequentially(s.prepared.rows, s.sender);
  assert.deepEqual(first.map(r => r.status), ['sent', 'failed']);
  const resumed = await preparePayments(s);
  assert.equal(resumed.rows[1].stealthAddress, s.prepared.rows[1].stealthAddress);
  await sendSequentially(resumed.rows, s.sender);
  assert.equal(s.chain.transfers.length, 3);
  assert.deepEqual(s.chain.transfers.map(t => t.to), resumed.rows.map(r => r.stealthAddress));
  assert.deepEqual(resumed.rows.slice(0, 2).map(r => r.stealthAddress), s.prepared.rows.slice(0, 2).map(r => r.stealthAddress));
});

test('recovers a broadcast whose outcome was lost by finding it on-chain, with no second transfer', async () => {
  const s = await setup(); s.chain.transferResponses = ['unknown'];
  const first = await sendSequentially(s.prepared.rows, s.sender);
  assert.equal(first[0].status, 'unresolved');
  const second = await sendSequentially((await preparePayments(s)).rows, s.sender);
  assert.equal(second.filter(r => r.status === 'sent').length, 3);
  assert.equal(s.chain.transfers.length, 3);
});

test('an unknown outcome with nothing on-chain blocks resending until the user releases it', async () => {
  const s = await setup(); s.chain.transferResponses = [new Error('wallet crashed')];
  await s.sender(s.prepared.rows[0]);
  const blocked = await s.sender((await preparePayments(s)).rows[0]);
  assert.equal(blocked.status, 'unresolved');
  assert.match(blocked.error!, /Not sent, retry/);
  assert.equal(s.chain.requests.filter(r => r === 'transfer').length, 1);
  s.journal.release(s.prepared.rows[0].key);
  const retried = await s.sender((await preparePayments(s)).rows[0]);
  assert.equal(retried.status, 'sent');
  assert.equal(s.chain.transfers[0].to, s.prepared.rows[0].stealthAddress);
});

test('a confirmation timeout keeps the hash and resume confirms it instead of resending', async () => {
  const s = await setup(); s.chain.transferResponses = ['timeout'];
  const first = await s.sender(s.prepared.rows[0]);
  assert.equal(first.status, 'unresolved');
  s.chain.receipts.set(s.chain.transfers[0].hash, true);
  const second = await s.sender((await preparePayments(s)).rows[0]);
  assert.equal(second.status, 'sent');
  assert.equal(s.chain.transfers.length, 1);
});

test('a reverted transfer is marked failed and can be retried safely', async () => {
  const s = await setup(); s.chain.transferResponses = ['revert'];
  assert.equal((await s.sender(s.prepared.rows[0])).status, 'failed');
  assert.equal((await s.sender((await preparePayments(s)).rows[0])).status, 'sent');
  assert.equal(s.chain.transfers.filter(t => t.ok).length, 1);
});

test('a declined announcement leaves the row transferred; resume only announces', async () => {
  const s = await setup(); s.chain.announceResponses = [rejection];
  const first = await sendSequentially(s.prepared.rows, s.sender);
  assert.equal(first[0].status, 'transferred');
  assert.match(first[0].error!, /USDC has arrived/);
  const resumed = await preparePayments(s);
  assert.equal(resumed.rows[0].status, 'transferred');
  await sendSequentially(resumed.rows, s.sender);
  assert.equal(s.chain.transfers.length, 3);
  assert.equal(s.chain.announcements.length, 3);
});

test('re-uploading the same CSV after a reload recovers sent rows; the journal holds no names or meta-addresses', async () => {
  const s = await setup(); await sendSequentially(s.prepared.rows, s.sender);
  const recovered = await preparePayments({ ...s, journal: new PaymentJournal(s.storage) });
  assert.ok(recovered.rows.every(r => r.status === 'sent' && r.transferTx && r.sentAt));
  await sendSequentially(recovered.rows, s.sender);
  assert.equal(s.chain.requests.length, 6);
  const raw = s.storage.getItem(JOURNAL_KEY)!;
  assert.ok(!raw.includes('Ada') && !raw.includes(keys[0].metaAddress.slice(10, 40)));
});

test('blocks the wrong network and a changed account before any send', async () => {
  for (const changed of ['network', 'account']) {
    const s = await setup();
    if (changed === 'network') s.chain.chainId = 1; else s.chain.account = '0x00000000000000000000000000000000000000bb';
    await assert.rejects(s.sender(s.prepared.rows[0]));
    assert.equal(s.chain.requests.length, 0);
  }
});

test('blocks an unavailable or corrupted journal without sending', async () => {
  const s = await setup();
  const denied = new PaymentJournal({ getItem: () => null, setItem: () => { throw new Error('denied'); } });
  const sender = createPaymentSender({ ...s, journal: denied, onUpdate: () => {} });
  const result = await sender(s.prepared.rows[0]);
  assert.match(result.error!, /could not be saved/);
  assert.equal(s.chain.requests.length, 0);
  s.storage.setItem(JOURNAL_KEY, '{broken');
  await assert.rejects(preparePayments(s), /cannot be read/);
});

test('blocks a changed CSV, amount or recipient for the same pay run', async () => {
  const s = await setup();
  await assert.rejects(preparePayments({ ...s, rows: [{ ...s.rows[0], atomic: '999' }, ...s.rows.slice(1)] }), /different CSV/);
  await assert.rejects(preparePayments({ ...s, rows: parseCsv(csv.replace(keys[0].metaAddress, keys[2].metaAddress)).rows }), /different CSV/);
});

test('blocks automatic recovery after the conservative window', async () => {
  const s = await setup(); s.chain.transferResponses = [new Error('wallet crashed')];
  await s.sender(s.prepared.rows[0]);
  const sender = createPaymentSender({ ...s, onUpdate: () => {}, now: () => Date.now() + RECOVERY_WINDOW_MS + 1000 });
  await assert.rejects(sender(s.prepared.rows[0]), /recovery has expired/);
  assert.equal(s.chain.requests.length, 1);
});

test('pauses between rows and keeps remaining payments untouched', async () => {
  const s = await setup(); let sent = false;
  await sendSequentially(s.prepared.rows, async r => { const result = await s.sender(r); sent = true; return result; }, () => sent);
  assert.equal(s.chain.transfers.length, 1);
});

test('a deliberate new pay run reference gets separate keys and fresh one-time addresses', async () => {
  const s = await setup(); const next = await preparePayments({ ...s, reference: 'November payroll' });
  assert.notEqual(next.rows[0].key, s.prepared.rows[0].key);
  assert.notEqual(next.rows[0].stealthAddress, s.prepared.rows[0].stealthAddress);
});

test('explains missing gas however the wallet words it', () => {
  const ethers = new Error('insufficient funds for intrinsic transaction cost (info={ "error": { "code": -32003 } }, code=INSUFFICIENT_FUNDS)');
  for (const error of [ethers, { code: -32003, message: 'insufficient funds for gas * price + value' }, Object.assign(new Error('wrapped', { cause: ethers }), { shortMessage: 'x' })])
    assert.match(paymentError(error), /no Base Sepolia ETH for gas/);
});

const gas = 20_000_000_000_000n; // 0.00002 ETH

test('a gas top-up sends ETH to each one-time address after its announcement', async () => {
  const s = await setup(undefined, gas);
  const results = await sendSequentially(s.prepared.rows, s.sender);
  assert.deepEqual(results.map(r => r.status), ['sent', 'sent', 'sent']);
  assert.deepEqual(s.chain.requests.slice(0, 3), ['transfer', 'announce', 'eth']);
  for (const row of s.prepared.rows) assert.equal(await s.chain.ethBalance(row.stealthAddress), gas);
  assert.ok(results.every(r => r.topUpTx));
  assert.deepEqual(s.updates.slice(0, 4).map(r => r.status), ['pending', 'transferred', 'announced', 'sent']);
});

test('a batch-capable wallet sends transfer, announcement and top-up in one approval', async () => {
  const s = await setup(undefined, gas); s.chain.batch = true;
  await sendSequentially(s.prepared.rows, s.sender);
  assert.deepEqual(s.chain.requests, ['batch+eth', 'batch+eth', 'batch+eth']);
});

test('a declined top-up leaves the row announced; resume sends only the ETH', async () => {
  const s = await setup(undefined, gas); s.chain.ethResponses = [rejection];
  const first = await sendSequentially(s.prepared.rows, s.sender);
  assert.equal(first[0].status, 'announced');
  assert.match(first[0].error!, /gas top-up was not sent/);
  assert.equal((await preparePayments(s)).rows[0].status, 'announced');
  await sendSequentially((await preparePayments(s)).rows, s.sender);
  assert.equal(s.chain.transfers.length, 3);
  assert.equal(s.chain.announcements.length, 3);
  assert.equal(s.chain.requests.filter(r => r === 'eth').length, 4);
});

test('a top-up whose outcome was lost is detected by the address balance, not resent', async () => {
  const s = await setup(undefined, gas); s.chain.ethResponses = ['unknown'];
  assert.equal((await s.sender(s.prepared.rows[0])).status, 'announced');
  const second = await s.sender((await preparePayments(s)).rows[0]);
  assert.equal(second.status, 'sent');
  assert.equal(s.chain.requests.filter(r => r === 'eth').length, 1);
});

test('changing the top-up after a run starts is blocked like any other CSV change', async () => {
  const s = await setup(undefined, gas);
  await s.sender(s.prepared.rows[0]);
  await assert.rejects(preparePayments({ ...s, topUp: gas * 2n }), /different CSV/);
  await assert.rejects(preparePayments({ ...s, topUp: 0n }), /different CSV/);
});
