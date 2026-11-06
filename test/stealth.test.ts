import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAddress } from 'viem/accounts';
import { announcementMetadata, generateKeys, generateStealthPayment, parseMetaAddress, stealthPrivateKey } from '../src/stealth';

test('the recipient derives the private key for every sender-generated stealth address', () => {
  const keys = generateKeys('basesep');
  const seen = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const payment = generateStealthPayment(keys.metaAddress);
    assert.equal(privateKeyToAddress(stealthPrivateKey(keys, payment.ephemeralPublicKey)), payment.stealthAddress);
    assert.match(payment.viewTag, /^0x[a-f0-9]{2}$/);
    seen.add(payment.stealthAddress);
  }
  assert.equal(seen.size, 20, 'each payment gets a fresh one-time address');
});

test('a deterministic ephemeral key gives a stable address, and other recipients cannot claim it', () => {
  const keys = generateKeys('basesep'), other = generateKeys('basesep');
  const ephemeral = new Uint8Array(32).fill(7);
  const a = generateStealthPayment(keys.metaAddress, ephemeral), b = generateStealthPayment(keys.metaAddress, ephemeral);
  assert.deepEqual(a, b);
  assert.notEqual(privateKeyToAddress(stealthPrivateKey(other, a.ephemeralPublicKey)), a.stealthAddress);
});

test('parses only well-formed st: meta-addresses with valid compressed points', () => {
  const { metaAddress } = generateKeys('base');
  assert.ok(parseMetaAddress(metaAddress));
  assert.ok(parseMetaAddress(metaAddress.replace('st:base:', 'st:eth:')));
  assert.equal(parseMetaAddress(metaAddress.replace('st:base:', '')), null);
  assert.equal(parseMetaAddress(metaAddress.slice(0, -2)), null);
  assert.equal(parseMetaAddress('st:base:0x04' + metaAddress.slice(12)), null);
  // x = 5 is not on secp256k1 (5^3 + 7 = 132 is a non-residue).
  assert.equal(parseMetaAddress('st:base:0x02' + '0'.repeat(63) + '5' + metaAddress.slice(-66)), null);
});

test('announcement metadata is view tag, transfer selector, token and 32-byte amount', () => {
  const token = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const metadata = announcementMetadata('0xab', token, 1_500_000n);
  assert.equal(metadata.length, 2 + 2 * (1 + 4 + 20 + 32));
  assert.ok(metadata.startsWith('0xaba9059cbb036cbd53842c5426634e7929541ec2318f3dcf7e'));
  assert.equal(BigInt('0x' + metadata.slice(-64)), 1_500_000n);
});
