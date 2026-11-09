import { useEffect, useRef, useState } from 'react';
import { formatEther, formatUnits, getAddress, isAddress, type Address, type Hex } from 'viem';
import { getBlockNumber, getPublicClient } from 'wagmi/actions';
import { Icon } from './icons';
import { ANNOUNCER_ADDRESS, CHAIN_ID, NETWORK, USDC_DECIMALS } from './config';
import { announcementEvent, explorerAddress, explorerTx, wagmiConfig } from './chain';
import { loadKeys, parseKeys, type KeyBundle } from './keys';
import { paymentError } from './payments';
import { blockAtDate, fetchAnnouncements, matchAnnouncements, type FoundPayment } from './scan';
import { SCHEME_ID } from './stealth';
import { balancesOf, withdraw } from './withdraw';

interface Row extends FoundPayment {
  usdc?: bigint;
  eth?: bigint;
  state: 'idle' | 'withdrawing' | 'done' | 'error';
  message?: string;
  usdcTx?: Hex;
  ethTx?: Hex;
}
const usdc = (atomic: bigint) => formatUnits(atomic, USDC_DECIMALS);
const weekAgo = () => new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);

function remembered() { try { return loadKeys(localStorage); } catch { return null; } }

/** Recipient page: find payments sent to your meta-address and move them to a wallet. */
export function ReceivePage() {
  const [keys, setKeys] = useState<KeyBundle | null>(null);
  const [saved] = useState(remembered);
  const [keyError, setKeyError] = useState('');
  const [since, setSince] = useState(weekAgo);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [destination, setDestination] = useState('');
  const [sweepEth, setSweepEth] = useState(true);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const validDestination = isAddress(destination.trim(), { strict: false });

  // Stealth keys are dropped when leaving the page.
  useEffect(() => () => abort.current?.abort(), []);

  function adopt(bundle: KeyBundle) { setKeys(bundle); setKeyError(''); setRows(null); setScanError(''); }
  function loadText(text: string) {
    try { adopt(parseKeys(text)); } catch (e) { setKeyError(e instanceof Error ? e.message : 'These keys could not be read.'); }
  }
  async function loadFile(file?: File) {
    if (!file) return;
    if (file.size > 16_384) { setKeyError('That file is too large to be a key backup.'); return; }
    loadText(await file.text());
    if (fileInput.current) fileInput.current.value = '';
  }
  function unload() { abort.current?.abort(); setKeys(null); setRows(null); setProgress(null); }

  async function scan() {
    if (!keys || scanning) return;
    setScanning(true); setScanError(''); setRows(null);
    const controller = new AbortController(); abort.current = controller;
    try {
      const client = getPublicClient(wagmiConfig, { chainId: CHAIN_ID })!;
      const latest = await getBlockNumber(wagmiConfig, { chainId: CHAIN_ID });
      const fromBlock = keys.startBlock ?? blockAtDate(latest, new Date(since));
      const logs = await fetchAnnouncements({
        fromBlock, toBlock: latest, signal: controller.signal, onProgress: (done, total) => setProgress([done, total]),
        getLogs: async (from, to) => (await client.getLogs({ address: ANNOUNCER_ADDRESS, event: announcementEvent, args: { schemeId: SCHEME_ID }, fromBlock: from, toBlock: to }))
          .map(log => ({ stealthAddress: log.args.stealthAddress!, ephemeralPublicKey: log.args.ephemeralPubKey!, metadata: log.args.metadata!, txHash: log.transactionHash, blockNumber: log.blockNumber })),
      });
      const found: Row[] = matchAnnouncements(keys, logs).map(p => ({ ...p, state: 'idle' }));
      setRows(found);
      await refresh(found);
    } catch (e) {
      setScanError(e instanceof DOMException && e.name === 'AbortError' ? 'Scan stopped. Payments found so far are not shown; scan again to finish.' : `The scan could not finish: ${paymentError(e)} Try again in a minute; public RPC endpoints limit bursts.`);
    } finally { setScanning(false); abort.current = null; }
  }

  async function refresh(list: Row[]) {
    const balances = await Promise.all(list.map(r => balancesOf(r.stealthAddress).catch(() => null)));
    setRows(current => current?.map((r, i) => balances[i] ? { ...r, ...balances[i] } : r) ?? null);
  }

  const update = (address: Address, patch: Partial<Row>) => setRows(current => current?.map(r => r.stealthAddress === address ? { ...r, ...patch } : r) ?? null);

  async function withdrawRow(row: Row) {
    if (!validDestination) return;
    const to = getAddress(destination.trim());
    update(row.stealthAddress, { state: 'withdrawing', message: 'Sending USDC…' });
    try {
      const result = await withdraw({ privateKey: row.privateKey, to, sweepEth, onStep: step => update(row.stealthAddress, { message: step === 'usdc' ? 'Sending USDC…' : 'Returning leftover ETH…' }) });
      const balances = await balancesOf(row.stealthAddress);
      update(row.stealthAddress, { ...balances, ...result, state: 'done', message: result.usdcTx || result.ethTx ? 'Withdrawn' : 'Nothing to withdraw' });
    } catch (e) {
      const noGas = /insufficient funds|exceeds the balance/i.test(String((e as { details?: unknown })?.details ?? (e as Error)?.message ?? ''));
      update(row.stealthAddress, { state: 'error', message: noGas ? `This one-time address has no ETH for gas. Ask the payer to use the gas top-up, or send a little ${NETWORK.label} ETH to it.` : paymentError(e) });
    }
  }
  async function withdrawAll() {
    if (!rows || busy) return;
    setBusy(true);
    try { for (const row of rows) if ((row.usdc ?? 0n) > 0n && row.state !== 'done') await withdrawRow(row); }
    finally { setBusy(false); }
  }

  const totalUsdc = rows?.reduce((t, r) => t + (r.usdc ?? 0n), 0n) ?? 0n;
  return <main id="main" tabIndex={-1} className="receipt-main get-paid receive">
    <a className="back-link" href="#/">← Back to payroll</a>
    <div className="page-heading"><div><h1>Receive payments</h1><p>Load your stealth keys, find the payments sent to your meta-address and move them to a wallet you choose.</p></div></div>

    <section className="upload-panel" aria-labelledby="load-title">
      <div className="section-heading"><div><h2 id="load-title">1. Load your Nightroll key backup</h2><p>It stays in this page’s memory and is never sent anywhere.</p></div>{keys && <button className="button secondary compact" onClick={unload}>Unload keys</button>}</div>
      <div className="get-paid-body">
        {keys ? <><p className="field-hint">Loaded meta-address</p><p className="full-address mono meta-address" dir="ltr">{keys.metaAddress}</p></> : <>
          {saved && <button className="button primary" onClick={() => adopt(saved)}><Icon name="lock" size={16}/>Use keys remembered in this browser</button>}
          <input className="visually-hidden" type="file" accept=".json,application/json" ref={fileInput} tabIndex={-1} aria-label="Key backup file" onChange={event => void loadFile(event.target.files?.[0])}/>
          <button className="button secondary" onClick={() => fileInput.current?.click()}><Icon name="upload" size={16}/>Open key backup file</button>
          <p className="field-hint">Use the backup file you downloaded on the Get paid page. Nightroll never asks for your wallet’s recovery phrase.</p>
        </>}
        {keyError && <div className="notice danger" role="alert"><Icon name="info"/><div>{keyError}</div></div>}
      </div>
    </section>

    {keys && <section className="upload-panel" aria-labelledby="scan-title">
      <div className="section-heading"><div><h2 id="scan-title">2. Find your payments</h2><p>Reads ERC-5564 announcements on {NETWORK.label} and keeps the ones only your keys can match.</p></div></div>
      <div className="get-paid-body">
        {keys.startBlock !== undefined ? <p className="field-hint">Scanning from block {keys.startBlock.toString()}, when these keys were created.</p>
          : <div className="field"><label htmlFor="scan-since">Look for payments since</label><input id="scan-since" type="date" value={since} max={new Date().toISOString().slice(0, 10)} disabled={scanning} onChange={event => setSince(event.target.value)}/><p>Older dates take longer: the public RPC reads 200 blocks (about 7 minutes) per request.</p></div>}
        <div className="scan-actions">{scanning ? <button className="button secondary" onClick={() => abort.current?.abort()}><Icon name="pause" size={16}/>Stop scan</button> : <button className="button primary" onClick={() => void scan()}><Icon name="arrow" size={16}/>{rows ? 'Scan again' : 'Scan for payments'}</button>}
          {progress && <span className="scan-progress" role="status">{scanning ? `Scanned ${progress[0]} of ${progress[1]} block ranges` : rows ? `${rows.length} ${rows.length === 1 ? 'payment' : 'payments'} found` : ''}</span>}</div>
        {scanError && <div className="notice warning" role="alert"><Icon name="info"/><div>{scanError}</div></div>}
      </div>
    </section>}

    {rows && rows.length > 0 && <section className="review-panel" aria-labelledby="found-title">
      <div className="section-heading"><div><h2 id="found-title">3. Withdraw</h2><p>{usdc(totalUsdc)} USDC across {rows.length} one-time {rows.length === 1 ? 'address' : 'addresses'}.</p></div><button className="button secondary compact" onClick={() => void refresh(rows)}>Refresh balances</button></div>
      <div className="get-paid-body">
        <div className="field destination-field"><label htmlFor="destination">Send to wallet address</label><input id="destination" className="mono" spellCheck={false} autoComplete="off" placeholder="0x…" value={destination} aria-invalid={!!destination && !validDestination} onChange={event => setDestination(event.target.value)}/><p>{destination && !validDestination ? 'Enter a full 0x address.' : `Must be an address you control on ${NETWORK.label}.`}</p></div>
        <label className="checkbox-line"><input type="checkbox" checked={sweepEth} onChange={event => setSweepEth(event.target.checked)}/><span>Also send leftover ETH to this address<span className="field-hint">Whatever remains after gas. A tiny amount may stay behind.</span></span></label>
        <div className="review-notice get-paid-notes"><Icon name="info" size={16}/><p>Withdrawing links each one-time address to the wallet you send to, on-chain. Sending several payments to the same wallet also links them to each other.</p></div>
      </div>
      <table className="payment-table" role="table"><caption className="visually-hidden">Payments found for these keys, their balances and withdrawal status</caption><thead><tr role="row"><th scope="col">One-time address</th><th scope="col">Announced</th><th scope="col">Balance</th><th scope="col">Withdraw</th></tr></thead><tbody>
        {rows.map((row, i) => <tr key={row.stealthAddress} role="row">
          <td className="recipient-cell" role="cell"><div className="recipient-name"><span className="row-number">{String(i + 1).padStart(2, '0')}</span><a className="full-address mono" dir="ltr" href={explorerAddress(row.stealthAddress)} target="_blank" rel="noreferrer">{row.stealthAddress}</a></div><a className="tx-hash" href={explorerTx(row.txHash)} target="_blank" rel="noreferrer">Announcement in block {row.blockNumber.toString()}</a></td>
          <td role="cell" className="amount-cell"><span className="mobile-label">Announced</span>{row.announcedAmount !== undefined && row.announcedToken === NETWORK.usdc ? <><strong>{usdc(row.announcedAmount)}</strong><span> USDC</span></> : <span>Unknown asset</span>}</td>
          <td role="cell" className="amount-cell"><span className="mobile-label">Balance</span>{row.usdc === undefined ? <span>Loading…</span> : <><strong>{usdc(row.usdc)}</strong><span> USDC</span><span className="status-hint">{formatEther(row.eth ?? 0n)} ETH for gas</span></>}</td>
          <td role="cell" className="status-cell">{row.state === 'withdrawing' ? <span className="status status-pending"><span className="status-dot"/>{row.message}</span>
            : <button className="button secondary compact" disabled={!validDestination || busy || (row.usdc ?? 0n) === 0n && (!sweepEth || (row.eth ?? 0n) === 0n)} onClick={() => void withdrawRow(row)}>Withdraw</button>}
            {row.state === 'done' && <span className="status status-sent"><span className="status-dot"/>{row.message}</span>}
            {row.usdcTx && <><span className="tx-label">USDC withdrawal</span><a className="tx-hash mono" dir="ltr" href={explorerTx(row.usdcTx)} target="_blank" rel="noreferrer">{row.usdcTx}</a></>}
            {row.ethTx && <><span className="tx-label">ETH returned</span><a className="tx-hash mono" dir="ltr" href={explorerTx(row.ethTx)} target="_blank" rel="noreferrer">{row.ethTx}</a></>}
            {row.state === 'error' && <p className="row-error">{row.message}</p>}</td>
        </tr>)}
      </tbody></table>
      <div className="send-footer"><div className="send-action-row"><span>{rows.filter(r => r.state === 'done').length} of {rows.length} withdrawn</span><button className="button primary" disabled={!validDestination || busy || totalUsdc === 0n} onClick={() => void withdrawAll()}>{busy ? 'Withdrawing…' : 'Withdraw all USDC'}<Icon name="arrow" size={16}/></button></div></div>
    </section>}
    {rows && rows.length === 0 && <div className="notice warning" role="status"><Icon name="info"/><div>No payments to these keys were found{keys?.startBlock === undefined ? ' since that date' : ''}. Check that the payer used this meta-address on {NETWORK.label}.</div></div>}
  </main>;
}
