import { test } from 'node:test';
import assert from 'node:assert/strict';
import { receiptFragment, readReceipt, type Receipt } from '../src/receipt';

const receipt: Receipt = { version: 2, name: 'Ada, "design" 日本語 • مرحبا <script>alert(1)</script>', stealthAddress: '0x2029509a24B3381C4a5098DcB91D1f6f4beA7809', amount: '0.000001', transferTx: `0x${'a'.repeat(64)}`, announceTx: `0x${'b'.repeat(64)}`, date: '2026-11-06T10:20:00.000Z', network: 'base-sepolia', asset: 'USDC' };
test('round trips Unicode, punctuation and markup entirely inside the fragment', () => {
  const fragment = receiptFragment(receipt);
  assert.match(fragment, /^#\/receipt\/[A-Za-z0-9_-]+$/);
  assert.deepEqual(readReceipt(fragment), receipt);
  assert.equal(new URL('https://example.org/subpath/' + fragment).pathname, '/subpath/');
  assert.equal(new URL('https://example.org/subpath/' + fragment).search, '');
});
test('rejects malformed, old or unsupported receipt links without crashing', () => {
  for (const hash of ['', '#/receipt/', '#/receipt/!!!', '#/receipt/1234', '#/receipt/' + 'a'.repeat(24001),
    receiptFragment({ ...receipt, transferTx: '0xno-hash' }), receiptFragment({ ...receipt, network: 'testnet' as 'base' }),
    receiptFragment({ ...receipt, version: 1 as 2 }), receiptFragment({ ...receipt, amount: '0.0000001' })]) assert.equal(readReceipt(hash), null);
});
