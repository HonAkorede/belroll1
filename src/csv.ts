import { formatUnits, parseUnits } from 'viem';
import { MAX_CSV_BYTES, MAX_ROWS, USDC_DECIMALS } from './config';
import { parseMetaAddress } from './stealth';

export interface CsvRow {
  line: number;
  name: string;
  metaAddress: string;
  amount: string;
  atomic: string;
}
export interface CsvError { line: number; message: string }
export interface CsvResult { rows: CsvRow[]; errors: CsvError[] }
export const HEADER = 'name,stealth_meta_address,amount';
// One trillion USDC per row is far beyond any payroll and keeps display values bounded.
const MAX_ATOMIC = 10n ** 18n - 1n;

export function parseCsv(input: string): CsvResult {
  const errors: CsvError[] = [];
  if (new TextEncoder().encode(input).length > MAX_CSV_BYTES)
    return { rows: [], errors: [{ line: 1, message: 'Choose a CSV smaller than 256 KB.' }] };
  const records: { fields: string[]; line: number }[] = [];
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  let fields: string[] = [], field = '', quoted = false, closed = false, line = 1, start = 1;
  const finish = () => {
    fields.push(field);
    if (fields.some(s => s.trim() !== '') || fields.length > 1) records.push({ fields, line: start });
    fields = []; field = ''; closed = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else { field += c; if (c === '\n') line++; }
    } else if (c === ',') { fields.push(field); field = ''; closed = false; }
    else if (c === '\n') { finish(); line++; start = line; }
    else if (c === '"' && field === '' && !closed) quoted = true;
    else if (c === '"' || closed) {
      errors.push({ line, message: 'Check CSV quoting. Put the entire field in double quotes and escape quotes as "".' });
      return { rows: [], errors };
    } else field += c;
  }
  if (quoted) errors.push({ line: start, message: 'Close the quoted field with a double quote.' });
  finish();
  if (errors.length) return { rows: [], errors };
  const header = records.shift();
  if (!header || header.fields.map(s => s.trim()).join(',') !== HEADER)
    return { rows: [], errors: [{ line: header?.line ?? 1, message: `Use this exact header: ${HEADER}` }] };
  if (!records.length) errors.push({ line: header.line + 1, message: 'Add at least one payment below the header.' });
  if (records.length > MAX_ROWS) errors.push({ line: records[MAX_ROWS].line, message: 'Use at most 500 payments in one CSV.' });
  const rows: CsvRow[] = [];
  for (const record of records.slice(0, MAX_ROWS)) {
    const { fields: f, line: rowLine } = record;
    if (f.length !== 3) { errors.push({ line: rowLine, message: 'Use three columns: name, stealth_meta_address and amount. Quote names containing commas.' }); continue; }
    const name = f[0].trim(), metaAddress = f[1].trim(), amount = f[2].trim();
    const before = errors.length;
    if (!name || name.length > 120) errors.push({ line: rowLine, message: 'Enter a name of 1 to 120 characters.' });
    if (!parseMetaAddress(metaAddress)) errors.push({ line: rowLine, message: 'Enter a full stealth meta-address starting with st:, such as st:basesep:0x… from the recipient’s Get paid page.' });
    let atomic = 0n;
    if (!/^\d+(\.\d{1,6})?$/.test(amount)) errors.push({ line: rowLine, message: 'Use a positive USDC amount with up to 6 decimal places, without commas or currency symbols.' });
    else {
      atomic = parseUnits(amount, USDC_DECIMALS);
      if (atomic <= 0n || atomic > MAX_ATOMIC) errors.push({ line: rowLine, message: 'Amount must be greater than zero and below one trillion USDC.' });
    }
    if (before === errors.length) rows.push({ line: rowLine, name, metaAddress: metaAddress.toLowerCase(), amount: formatUnits(atomic, USDC_DECIMALS), atomic: atomic.toString() });
  }
  return { rows: errors.length ? [] : rows, errors };
}

export function totalAmount(rows: Pick<CsvRow, 'atomic'>[]) {
  return formatUnits(rows.reduce((total, r) => total + BigInt(r.atomic), 0n), USDC_DECIMALS);
}
