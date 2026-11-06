import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, totalAmount } from '../src/csv';
import { generateKeys } from '../src/stealth';

const a = generateKeys('basesep').metaAddress, b = generateKeys('base').metaAddress;
const header = 'name,stealth_meta_address,amount';

test('accepts BOM, CRLF, exact decimals, escaped quotes, commas and multiline names', () => {
  const result = parseCsv(`﻿${header}\r\n"Ada, ""lead""\r\nمرحبا",${a},0001.230000\r\nSam,${b.toUpperCase().replace('ST:BASE:0X', 'st:base:0x')},0.000001\r\n`);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].name, 'Ada, "lead"\nمرحبا');
  assert.equal(result.rows[0].amount, '1.23');
  assert.equal(result.rows[1].line, 4);
  assert.equal(result.rows[1].metaAddress, b, 'meta-addresses are normalised to lower case');
  assert.equal(totalAmount(result.rows), '1.230001');
});

test('sums without floating point rounding', () => {
  const { rows } = parseCsv(`${header}\nA,${a},0.1\nB,${b},0.2`);
  assert.equal(totalAmount(rows), '0.3');
});

test('reports physical line numbers and rejects the complete invalid file', () => {
  const result = parseCsv(`${header}\n"two\nlines",${a},1\nBad,not-a-meta-address,-2\nSam,${b},0.1`);
  assert.equal(result.rows.length, 0);
  assert.equal(result.errors.length, 2);
  assert.ok(result.errors.every(e => e.line === 4));
});

for (const amount of ['0', '-1', '+1', '1e3', 'NaN', 'Infinity', '.1', '1.', '1.0000001', '1000000000000', '1,000']) {
  test(`rejects unsafe amount ${amount}`, () => {
    const result = parseCsv(`${header}\nAda,${a},"${amount}"`);
    assert.ok(result.errors.some(e => e.line === 2));
    assert.equal(result.rows.length, 0);
  });
}

test('accepts the smallest and largest supported amounts', () => {
  const { rows, errors } = parseCsv(`${header}\nA,${a},0.000001\nB,${b},999999999999.999999`);
  assert.equal(errors.length, 0);
  assert.equal(rows[0].atomic, '1');
  assert.equal(rows[1].atomic, '999999999999999999');
});

test('validates headers, columns, empty files and quote boundaries', () => {
  for (const text of ['', header, `recipient,amount,note\nA,${a},1`, `${header}\nA,${a}`, `${header}\nA,${a},1,extra`, `${header}\n"unclosed,${a},1`, `${header}\n"closed"garbage,${a},1`, `${header}\nnot"quoted,${a},1`]) {
    assert.ok(parseCsv(text).errors.length > 0, text);
  }
});

test('rejects bad meta-addresses, blank or long names, oversized files and too many rows', () => {
  for (const meta of ['0x' + a.slice(10), a.replace('st:', 'sx:'), a.slice(0, -1), a + '00', '0x00000000000000000000000000000000000000aa'])
    assert.ok(parseCsv(`${header}\nA,${meta},1`).errors.length, meta);
  assert.ok(parseCsv(`${header}\n ,${a},1`).errors.length);
  assert.ok(parseCsv(`${header}\n${'x'.repeat(121)},${a},1`).errors.length);
  assert.ok(parseCsv('x'.repeat(262145)).errors.length);
  assert.ok(parseCsv(header + '\n' + `A,${a},1\n`.repeat(501)).errors.some(e => e.line === 502));
});

test('treats markup as plain name text', () => {
  const result = parseCsv(`${header}\n<script>alert(1)</script>,${a},1`);
  assert.equal(result.errors.length, 0);
  assert.equal(result.rows[0].name, '<script>alert(1)</script>');
});
