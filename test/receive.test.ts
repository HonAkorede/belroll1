import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAddress } from 'viem/accounts';
import type { Hex } from 'viem';
import { NETWORK } from '../src/config';
import { backupJson, KEYS_STORAGE, loadKeys, parseKeys, saveKeys } from '../src/keys';
import { blockAtDate, fetchAnnouncements, matchAnnouncements, parseMetadata, type AnnouncementLog } from '../src/scan';
import { announcementMetadata, generateKeys, generateStealthPayment } from '../src/stealth';
import { sweepAmount } from '../src/withdraw';

const mine = generateKeys('basesep'), theirs = generateKeys('basesep');
let block = 0n;
function announce(meta: string, amount = 1_000_000n): AnnouncementLog {
  const p = generateStealthPayment(meta);
  return { stealthAddress: p.stealthAddress, ephemeralPublicKey: p.ephemeralPublicKey, metadata: announcementMetadata(p.viewTag, NETWORK.usdc, amount), txHash: `0x${(++block).toString(16).padStart(64, '0')}` as Hex, blockNumber: block };
}

test('finds only the announcements addressed to these keys and derives each spending key', () => {
  const logs = [announce(mine.metaAddress, 12_500_000n), ...Array.from({ length: 40 }, () => announce(theirs.metaAddress)), announce(mine.metaAddress, 7_250_000n)];
  const found = matchAnnouncements(mine, logs);
  assert.equal(found.length, 2);
  for (const payment of found) assert.equal(privateKeyToAddress(payment.privateKey), payment.stealthAddress);
  assert.deepEqual(found.map(p => p.announcedAmount), [12_500_000n, 7_250_000n]);
  assert.ok(found.every(p => p.announcedToken === NETWORK.usdc));
});

test('ignores duplicate, malformed and forged announcements', () => {
  const real = announce(mine.metaAddress);
  // Right view tag and ephemeral key, but pointing at someone else's address.
  const forged = { ...real, stealthAddress: announce(theirs.metaAddress).stealthAddress };
  const broken = { ...real, ephemeralPublicKey: '0x04' as Hex };
  const empty = { ...real, metadata: '0x' as Hex };
  assert.equal(matchAnnouncements(mine, [real, { ...real, txHash: `0x${'f'.repeat(64)}` as Hex }, forged, broken, empty]).length, 1);
});

test('reads token metadata only when it follows the transfer layout', () => {
  assert.deepEqual(parseMetadata(announcementMetadata('0x12', NETWORK.usdc, 5n)), { token: NETWORK.usdc, amount: 5n });
  assert.deepEqual(parseMetadata('0x12'), {});
  assert.deepEqual(parseMetadata(('0x12deadbeef' + '0'.repeat(104)) as Hex), {});
});

test('scans in 200-block chunks, retries failures, keeps block order and reports progress', async () => {
  const calls: [bigint, bigint][] = []; let failures = 2; const progress: number[] = [];
  const logs = await fetchAnnouncements({
    fromBlock: 1000n, toBlock: 1999n, retries: 3, concurrency: 3, onProgress: done => progress.push(done),
    getLogs: async (from, to) => {
      calls.push([from, to]);
      if (from === 1200n && failures-- > 0) throw new Error('rate limited');
      await new Promise(r => setTimeout(r, Number(2000n - from) / 100));
      return [{ ...announce(mine.metaAddress), blockNumber: from }];
    },
  });
  assert.deepEqual(logs.map(l => l.blockNumber), [1000n, 1200n, 1400n, 1600n, 1800n]);
  assert.ok(calls.every(([from, to]) => to - from === 199n));
  assert.equal(calls.length, 7);
  assert.equal(progress.at(-1), 5);
});

test('a scan can be stopped and gives up after its retries', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchAnnouncements({ fromBlock: 0n, toBlock: 999n, signal: controller.signal, getLogs: async () => [] }), /stopped/);
  await assert.rejects(fetchAnnouncements({ fromBlock: 0n, toBlock: 10n, retries: 1, getLogs: async () => { throw new Error('down'); } }), /down/);
});

test('estimates a start block from a date at two seconds per block', () => {
  const now = Date.parse('2026-11-07T00:00:00Z');
  assert.equal(blockAtDate(1_000_000n, new Date(now - 86400_000), now), 1_000_000n - 43_200n);
  assert.equal(blockAtDate(10n, new Date(0), now), 0n);
});

test('loads keys from a backup, a pasted pair or this browser, and rejects damaged backups', () => {
  const bundle = { ...mine, startBlock: 123n };
  assert.deepEqual(parseKeys(backupJson(bundle)), { ...mine, metaAddress: mine.metaAddress, startBlock: 123n });
  assert.equal(parseKeys(`${mine.spendingPrivateKey}\n${mine.viewingPrivateKey}`).metaAddress, mine.metaAddress);
  assert.equal(parseKeys(`${mine.spendingPrivateKey}, ${mine.viewingPrivateKey}`).startBlock, undefined);
  const tampered = JSON.parse(backupJson(bundle)); tampered.metaAddress = theirs.metaAddress;
  assert.throws(() => parseKeys(JSON.stringify(tampered)), /do not match/);
  const otherChain = JSON.parse(backupJson(bundle)); otherChain.chainId = 1;
  assert.equal(parseKeys(JSON.stringify(otherChain)).startBlock, undefined, 'a start block from another chain is ignored');
  // Backups written before the rename have no startBlock and app: 'Belroll'.
  assert.equal(parseKeys(JSON.stringify({ app: 'Belroll', spendingPrivateKey: mine.spendingPrivateKey, viewingPrivateKey: mine.viewingPrivateKey, metaAddress: mine.metaAddress })).metaAddress, mine.metaAddress);
  for (const bad of ['', '{', '0x12 0x34', mine.spendingPrivateKey, `0x${'0'.repeat(64)} ${mine.viewingPrivateKey}`]) assert.throws(() => parseKeys(bad), Error, bad);
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } };
  assert.equal(loadKeys(storage), null);
  saveKeys(storage, bundle);
  assert.equal(loadKeys(storage)?.startBlock, 123n);
  store.set(KEYS_STORAGE, '{broken');
  assert.equal(loadKeys(storage), null);
});

test('an ETH sweep leaves enough for L2 gas and a margin over the L1 fee', () => {
  assert.equal(sweepAmount(1_000_000n, 10n, 1000n), 1_000_000n - 210_000n - 1500n);
  assert.equal(sweepAmount(100n, 10n, 1000n), 0n);
});
