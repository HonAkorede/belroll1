import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { formatUnits, type Hex } from 'viem';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { Icon, Logo } from './icons';
import { CHAIN_ID, MAX_CSV_BYTES, NETWORK, NETWORKS, USDC_DECIMALS } from './config';
import { createChainClient, explorerAddress, explorerTx } from './chain';
import { HEADER, parseCsv, totalAmount, type CsvError, type CsvRow } from './csv';
import { createPaymentSender, PaymentJournal, paymentError, preparePayments, remainingAtomic, sendSequentially, type PaymentRow } from './payments';
import { readReceipt, receiptFragment, type Receipt } from './receipt';
import { GetPaidPage } from './GetPaid';

const defaultReference = () => `Payroll ${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
const usdc = (atomic: bigint) => formatUnits(atomic, USDC_DECIMALS);
const fundsLabel = NETWORK.testnet ? 'test funds' : 'real funds';
const PRIVACY_NOTE = 'Recipients are hidden, but amounts and the treasury wallet are public.';
type Review = Awaited<ReturnType<typeof preparePayments>>;
function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => { const change = () => { setHash(location.hash); if (location.hash.startsWith('#/')) window.scrollTo(0, 0); }; addEventListener('hashchange', change); return () => removeEventListener('hashchange', change); }, []);
  return hash;
}

function Status({ row }: { row: PaymentRow }) {
  const labels = { ready: 'Ready', pending: 'Approve in wallet', transferred: 'Paid · announcing', sent: 'Sent', failed: 'Failed', unresolved: 'Outcome unknown' };
  return <span className={`status status-${row.status}`}><span className="status-dot" />{labels[row.status]}</span>;
}

function TxLink({ label, hash }: { label: string; hash: Hex }) {
  return <><span className="tx-label">{label}</span><a className="tx-hash mono" dir="ltr" href={explorerTx(hash)} target="_blank" rel="noreferrer">{hash}</a></>;
}

function ReceiptPage({ receipt }: { receipt: Receipt | null }) {
  const [copied, setCopied] = useState('');
  async function copyLink() {
    try { await navigator.clipboard.writeText(location.href); setCopied('Link copied'); }
    catch { setCopied('Copy the full link from your browser address bar.'); }
  }
  if (!receipt) return <main id="main" tabIndex={-1} className="receipt-main"><a className="back-link" href="#/">← Back to payroll</a><h1>This receipt cannot be read</h1><p>The link is incomplete or invalid. Ask for the full receipt link, including everything after #.</p></main>;
  const network = NETWORKS[receipt.network];
  return <main id="main" tabIndex={-1} className="receipt-main">
    <a className="back-link no-print" href="#/">← Back to payroll</a>
    <div className="receipt-heading"><div className="receipt-seal"><Icon name="check" size={28}/></div><h1>Payment receipt</h1><p>A record of a private USDC payment on {network.label}.</p></div>
    <div className="receipt-amount">{receipt.amount} <span>USDC</span></div>
    <dl className="receipt-data">
      <div><dt>Paid to</dt><dd dir="auto">{receipt.name}</dd></div>
      <div><dt>One-time stealth address</dt><dd className="mono" dir="ltr"><a href={`${network.explorer}/address/${receipt.stealthAddress}`} target="_blank" rel="noreferrer">{receipt.stealthAddress}</a></dd></div>
      <div><dt>USDC transfer</dt><dd className="mono" dir="ltr"><a href={`${network.explorer}/tx/${receipt.transferTx}`} target="_blank" rel="noreferrer">{receipt.transferTx}</a></dd></div>
      <div><dt>ERC-5564 announcement</dt><dd className="mono" dir="ltr"><a href={`${network.explorer}/tx/${receipt.announceTx}`} target="_blank" rel="noreferrer">{receipt.announceTx}</a></dd></div>
      <div><dt>Date</dt><dd><time dateTime={receipt.date}>{new Date(receipt.date).toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' })}</time></dd></div>
      <div><dt>Network</dt><dd>{network.label}{network.testnet ? ' · Test funds' : ''}</dd></div>
    </dl>
    <p className="receipt-disclaimer">This receipt is supplied by its link; check the transactions on the block explorer. The link connects this name to the one-time address, so share it only with the person paid.</p>
    <div className="receipt-actions no-print"><button className="button primary" onClick={() => window.print()}><Icon name="print"/>Print / Save as PDF</button><button className="button secondary" onClick={copyLink}><Icon name="copy"/>Copy link</button></div>
    <p role="status" className="copy-status no-print">{copied}</p>
    <p className="receipt-footer"><Icon name="lock" size={14}/> Receipt data stays in the URL fragment.</p>
  </main>;
}

function WalletStrip({ disabled }: { disabled: boolean }) {
  const { address, chainId, status } = useAccount();
  const { connectors, connect, isPending, error: connectError } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchError } = useSwitchChain();
  const connected = status === 'connected' && !!address;
  const onNetwork = connected && chainId === CHAIN_ID;
  // EIP-6963 wallets announce themselves; keep the generic injected fallback only when none did.
  const named = connectors.filter(c => c.id !== 'injected');
  const choices = named.length ? named : connectors;
  const error = connectError ?? switchError;
  return <>
    <section className={`wallet-strip ${onNetwork ? 'is-connected' : ''}`} aria-labelledby="wallet-title">
      <div className="wallet-symbol"><Icon name="wallet" size={22}/></div><div className="wallet-copy"><h2 id="wallet-title">{onNetwork ? 'Treasury wallet connected' : connected ? `Switch to ${NETWORK.label}` : 'Connect your treasury wallet'}</h2>{connected ? <><span className="wallet-network">{onNetwork ? NETWORK.label : 'Wrong network'}</span><span className="wallet-short mono">{address.slice(0, 8)}…{address.slice(-6)}</span><details className="wallet-address"><summary>View full wallet address</summary><p className="mono" dir="ltr">{address}</p></details></> : <p>Connect the wallet that holds the payroll USDC and a little ETH for gas.</p>}</div>
      {connected ? <div className="wallet-actions">{!onNetwork && <button className="button primary" disabled={disabled || switching} onClick={() => switchChain({ chainId: CHAIN_ID })}>{switching ? 'Switching…' : `Switch to ${NETWORK.label}`}</button>}<button className="button secondary compact" disabled={disabled} onClick={() => disconnect()}>Disconnect</button></div>
        : <div className="wallet-actions">{choices.map(c => <button key={c.uid} className="button primary" onClick={() => connect({ connector: c, chainId: CHAIN_ID })} disabled={isPending || disabled}><Icon name="wallet"/>{isPending ? 'Connecting…' : choices.length > 1 ? c.name : 'Connect wallet'}{!isPending && <Icon name="arrow" size={16}/>}</button>)}</div>}
    </section>
    {!connected && !choices.length && <div className="notice warning" role="alert"><Icon name="info"/><div>No browser wallet was found. Install MetaMask, Coinbase Wallet or Rabby, then reload this page.</div></div>}
    {error && <div className="notice warning" role="alert"><Icon name="info"/><div>{paymentError(error)}</div></div>}
  </>;
}

export default function App() {
  const hash = useHash();
  const { address, chainId } = useAccount();
  const chain = useMemo(() => createChainClient(), []);
  const [csvRows, setCsvRows] = useState<CsvRow[]>([]);
  const [csvErrors, setCsvErrors] = useState<CsvError[]>([]);
  const [fileName, setFileName] = useState('');
  const [fileBusy, setFileBusy] = useState(false);
  const [reference, setReference] = useState(defaultReference);
  const [review, setReview] = useState<Review | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [pauseRequested, setPauseRequested] = useState(false);
  const [runMessage, setRunMessage] = useState('');
  const [error, setError] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const csvErrorBox = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const pause = useRef(false);
  const busy = useRef(false);
  const fileLoading = useRef(false);
  const onNetwork = !!address && chainId === CHAIN_ID;
  const paid = review?.rows.filter(r => r.status === 'sent').length ?? 0;
  const complete = !!review && paid === review.rows.length;
  const total = totalAmount(csvRows);
  const remaining = review ? remainingAtomic(review.rows) : 0n;
  const shortfall = !!review && review.balance < remaining;
  const canSend = onNetwork && !!review && agreed && !shortfall && !sending && !reviewing && !complete;
  const step = review ? (attempted || paid ? 3 : 2) : 1;
  const disabledInputs = sending || reviewing || attempted;

  // Any account or network change invalidates a review and stops a run between rows.
  useEffect(() => {
    generation.current++; pause.current = true; setAgreed(false);
    setReview(current => { if (current) setError('The wallet account or network changed. Review the payroll again before continuing.'); return null; });
  }, [address, chainId]);

  useEffect(() => {
    if (!sending) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    addEventListener('beforeunload', beforeUnload);
    return () => removeEventListener('beforeunload', beforeUnload);
  }, [sending]);

  const guardFor = (version: number) => () => {
    if (generation.current !== version) throw new Error('The wallet changed. Reconnect and review the payroll before continuing.');
  };

  function resetReview() { setReview(null); setAgreed(false); setError(''); setRunMessage(''); }

  async function loadFile(file?: File) {
    if (!file || disabledInputs || fileLoading.current) return;
    fileLoading.current = true;
    setFileBusy(true); resetReview(); setCsvErrors([]); setCsvRows([]); setFileName(file.name);
    try {
      if (file.size > MAX_CSV_BYTES) { setCsvErrors([{ line: 1, message: 'Choose a CSV smaller than 256 KB.' }]); return; }
      const result = parseCsv(await file.text());
      setCsvRows(result.rows); setCsvErrors(result.errors);
      if (result.errors.length) requestAnimationFrame(() => csvErrorBox.current?.focus());
    } catch { setCsvErrors([{ line: 1, message: 'This file could not be read. Save it as a UTF-8 CSV and choose it again.' }]); }
    finally { fileLoading.current = false; setFileBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  }

  async function reviewPayments() {
    if (!address || !onNetwork || !csvRows.length || reviewing || sending) return;
    setReviewing(true); setError(''); setRunMessage('');
    const version = generation.current;
    try {
      const result = await preparePayments({ chain, owner: address, reference, rows: csvRows, journal: new PaymentJournal(localStorage), guard: guardFor(version) });
      guardFor(version)(); setReview(result); setAgreed(false);
      if (result.rows.some(r => r.status !== 'ready')) setAttempted(true);
      requestAnimationFrame(() => reviewHeading.current?.focus());
    } catch (e) { setError(paymentError(e)); }
    finally { setReviewing(false); }
  }

  const updateRow = (row: PaymentRow) => setReview(current => current ? { ...current, rows: current.rows.map(r => r.key === row.key ? row : r) } : current);

  async function sendRun() {
    if (!canSend || !address || !review || busy.current) return;
    busy.current = true; pause.current = false; setPauseRequested(false); setError(''); setRunMessage('');
    const version = generation.current;
    try {
      if (!navigator.locks) throw new Error('This browser cannot safely lock a payroll run. Use a current desktop browser with Web Locks support.');
      await navigator.locks.request('belroll-payment-run', { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('Another Belroll tab is sending payments. Wait for it to finish, then review this run again.');
        guardFor(version)();
        const balance = await chain.usdcBalance(address);
        if (balance < remainingAtomic(review.rows)) { setReview(current => current && { ...current, balance }); throw new Error(`The treasury holds ${usdc(balance)} USDC, less than the ${usdc(remainingAtomic(review.rows))} USDC left to send.`); }
        const journal = new PaymentJournal(localStorage);
        journal.bindRun(review.runKey, review.fingerprint);
        setSending(true); setAttempted(true);
        const sendPayment = createPaymentSender({ chain, owner: address, journal, guard: guardFor(version), onUpdate: updateRow });
        const results = await sendSequentially(review.rows, sendPayment, () => pause.current);
        const stopped = results.find(r => r.status !== 'sent');
        if (stopped) setError(`Payroll stopped at line ${stopped.line}. ${stopped.error ?? 'Check your wallet activity before resuming.'}`);
        else if (pause.current) setRunMessage('Payroll paused. Any approved payment has finished; remaining rows have not been requested.');
        else setRunMessage('Every payment was sent and announced. Open a receipt beside each payment.');
      });
    } catch (e) { setError(paymentError(e)); }
    finally { setSending(false); busy.current = false; }
  }

  function release(row: PaymentRow) {
    if (!confirm(`Only continue if your wallet shows no pending or completed USDC transfer for line ${row.line}. A wrong answer here can pay ${row.name} twice. Retry this payment?`)) return;
    try { new PaymentJournal(localStorage).release(row.key); updateRow({ ...row, status: 'failed', error: 'Marked as not sent. Resume to retry this payment.' }); }
    catch (e) { setError(paymentError(e)); }
  }

  function drop(event: DragEvent) { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length !== 1) { setCsvErrors([{ line: 1, message: 'Choose one CSV file at a time.' }]); return; } void loadFile(event.dataTransfer.files[0]); }

  function receiptFor(row: PaymentRow) {
    return receiptFragment({ version: 2, name: row.name, stealthAddress: row.stealthAddress, amount: row.amount, transferTx: row.transferTx!, announceTx: row.announceTx!, date: row.sentAt!, network: NETWORK === NETWORKS.base ? 'base' : 'base-sepolia', asset: 'USDC' });
  }

  function newPayroll() {
    if (sending) return;
    setCsvRows([]); setFileName(''); setCsvErrors([]); setAttempted(false); setReference(''); resetReview();
  }

  const receiptRoute = hash.startsWith('#/receipt/');
  const getPaidRoute = hash === '#/get-paid';
  return <div className={`app-shell ${receiptRoute ? 'receipt-shell' : ''}`}>
    <a className="skip-link" href="#main" onClick={event => { event.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to {receiptRoute ? 'receipt' : getPaidRoute ? 'Get paid' : 'payroll'}</a>
    <aside className="sidebar no-print">
      <Logo/>
      <div className="workspace-label"><span className="workspace-mark"><Icon name="grid" size={16}/></span><span>Payroll workspace</span></div>
      <nav aria-label="Main navigation"><a href="#/" className={!receiptRoute && !getPaidRoute ? 'nav-item active' : 'nav-item'}><Icon name="plus"/>New payroll</a><a href="#/get-paid" className={getPaidRoute ? 'nav-item active' : 'nav-item'}><Icon name="lock"/>Get paid</a><a href={receiptRoute || getPaidRoute ? '#/' : '#how-it-works'} className="nav-item"><Icon name="file"/>How it works<Icon name="chevron" size={14}/></a></nav>
      <div className="sidebar-bottom"><div className="local-mark"><Icon name="lock" size={18}/></div><strong>Hidden recipients.</strong><p>Each payment goes to a one-time stealth address.</p><a href={receiptRoute || getPaidRoute ? '#/' : '#about'} className="sidebar-about">About Belroll <Icon name="external" size={14}/></a></div>
    </aside>
    <div className="app-body">
      <header className="topbar no-print"><div className="mobile-brand"><Logo/></div><div className="breadcrumb"><span>Workspace</span><Icon name="chevron" size={14}/><span>{receiptRoute ? 'Receipt' : getPaidRoute ? 'Get paid' : 'New payroll'}</span></div><div className="topbar-end"><a className="mobile-get-paid" href={getPaidRoute ? '#/' : '#/get-paid'}>{getPaidRoute ? 'Payroll' : 'Get paid'}</a><span className="testnet-badge"><span/>{NETWORK.testnet ? 'TESTNET' : 'MAINNET'}</span><span className="prototype-label">Prototype</span></div></header>
      {receiptRoute ? <ReceiptPage key={hash} receipt={readReceipt(hash)}/> : getPaidRoute ? <GetPaidPage/> : <main id="main" tabIndex={-1} className="workspace">
        <div className="page-heading"><div><h1>Payroll. With hidden recipients.</h1><p>Pay your team in USDC on {NETWORK.label}. Every payment lands at a fresh stealth address.</p></div><span className="private-label"><Icon name="lock" size={14}/>ERC-5564 stealth payments</span></div>
        <div className="notice warning privacy-banner" role="note"><Icon name="info"/><div><strong>{PRIVACY_NOTE}</strong> Anyone can see the treasury wallet sending these USDC amounts; they cannot see who receives them.</div></div>
        <ol className="steps" aria-label="Payroll progress">{['Upload CSV', 'Review payments', 'Send & receipts'].map((label, i) => <li key={label} className={step === i + 1 ? 'current' : step > i + 1 ? 'done' : ''} aria-current={step === i + 1 ? 'step' : undefined}><span className="step-number">{step > i + 1 ? <Icon name="check" size={14}/> : i + 1}</span><span>{label}</span>{i < 2 && <span className="step-line"/>}</li>)}</ol>
        <WalletStrip disabled={sending}/>
        <div className="workspace-grid"><div className="payroll-column">
          <section className="upload-panel" aria-labelledby="upload-title"><div className="section-heading"><div><h2 id="upload-title">{review ? 'Payroll file' : 'Upload your payroll'}</h2><p>One CSV. One payment per row.</p></div><a className="text-link sample-link" href="./sample-payroll.csv" download="belroll-sample.csv"><Icon name="download" size={16}/><span>Download sample CSV</span></a></div>
            <input className="visually-hidden" id="csv-file" type="file" accept=".csv,text/csv" ref={fileInput} tabIndex={-1} disabled={disabledInputs} aria-label="Payroll CSV file" onChange={event => void loadFile(event.target.files?.[0])}/>
            {fileName && csvRows.length ? <div className="loaded-file"><span className="file-symbol"><Icon name="file" size={24}/></span><div><strong dir="auto">{fileName}</strong><p>{csvRows.length} {csvRows.length === 1 ? 'payment' : 'payments'} · CSV validated</p></div>{!disabledInputs && <button className="button secondary compact" onClick={() => fileInput.current?.click()}>Replace CSV</button>}<Icon name="check" className="success-ink"/></div> : <div className={`dropzone ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!disabledInputs) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
              <div className="file-illustration" aria-hidden="true"><span className="file-back"/><div className="file-front"><Icon name="file" size={32}/><span className="csv-label">.csv</span></div></div>
              <h3>{fileBusy ? 'Reading your CSV…' : 'Drop your payroll CSV here'}</h3><p>or choose a file from your device</p><button className="button secondary" onClick={() => fileInput.current?.click()} disabled={disabledInputs || fileBusy}><Icon name="upload" size={16}/>Choose CSV</button><span className="file-limit">Up to 500 payments · 256 KB max</span>
            </div>}
            {csvErrors.length > 0 && <div className="csv-errors notice danger" role="alert" tabIndex={-1} ref={csvErrorBox}><strong>Fix {csvErrors.length} {csvErrors.length === 1 ? 'issue' : 'issues'} and upload again</strong><ul>{csvErrors.map((item, i) => <li key={i}><strong>Line {item.line}:</strong> {item.message}</li>)}</ul><p>No rows were accepted. Nothing was sent.</p></div>}
            <div className="csv-format"><Icon name="info" size={16}/><p>Required columns: <code>{HEADER}</code><br/><span>Recipients create their meta-address on the <a href="#/get-paid">Get paid</a> page. Amounts are in USDC, up to 6 decimals.</span></p></div>
            {csvRows.length > 0 && <div className="run-settings"><div className="field"><label htmlFor="run-reference">Pay run reference</label><input id="run-reference" name="reference" autoComplete="off" maxLength={120} value={reference} disabled={disabledInputs} onChange={event => { setReference(event.target.value); resetReview(); }}/><p>Keep this reference and the same CSV to resume. Use a new reference only for a separate payroll.</p></div><p className="asset-note">Sends {NETWORK.label} USDC. Each row is a USDC transfer to a one-time address plus an ERC-5564 announcement so the recipient can find it.</p></div>}
            {csvRows.length > 0 && !review && <div className="review-next"><p>{onNetwork ? 'Create one-time addresses and check every payment before sending.' : `Connect a wallet on ${NETWORK.label} to continue.`}</p><button className="button primary" onClick={reviewPayments} disabled={!onNetwork || reviewing || !reference.trim()}>{reviewing ? 'Preparing payments…' : 'Review payments'}<Icon name="arrow" size={16}/></button></div>}
          </section>
          {review && <section className="review-panel" aria-labelledby="review-title"><div className="section-heading"><div><h2 id="review-title" tabIndex={-1} ref={reviewHeading}>{complete ? 'Payroll sent' : 'Review payments'}</h2><p>{complete ? `${paid} payments sent and announced.` : 'Check the name and amount for every recipient.'}</p></div>{!attempted && <button className="button secondary compact" onClick={resetReview} disabled={sending}>Edit payroll</button>}</div>
            <div className="review-totals"><span>{review.rows.length} {review.rows.length === 1 ? 'payment' : 'payments'}</span><span>Total <strong>{total} USDC</strong><span className="fee-caption"> + gas in ETH</span></span><span>Treasury balance <strong>{usdc(review.balance)} USDC</strong></span></div>
            <div className="review-notice"><Icon name="info" size={16}/><p>{PRIVACY_NOTE} Each one-time address is new and is derived in this browser from the recipient’s meta-address.</p></div>
            <table className="payment-table" role="table"><caption className="visually-hidden">Every payroll payment, its one-time address, amount and send status</caption><thead><tr role="row"><th scope="col">Recipient</th><th scope="col">Amount</th><th scope="col">One-time address</th><th scope="col">Status</th></tr></thead><tbody>{review.rows.map((row, i) => <tr key={row.key} role="row"><td className="recipient-cell" role="cell"><div className="recipient-name"><span className="row-number">{String(i + 1).padStart(2, '0')}</span><strong dir="auto">{row.name}</strong></div><details className="payment-key"><summary>Meta-address</summary><code>{row.metaAddress}</code></details></td><td role="cell" className="amount-cell"><span className="mobile-label">Amount</span><strong>{row.amount}</strong><span> USDC</span></td><td role="cell" className="note-cell"><span className="mobile-label">One-time address</span>{row.transferTx ? <a className="full-address mono" dir="ltr" href={explorerAddress(row.stealthAddress)} target="_blank" rel="noreferrer">{row.stealthAddress}</a> : <span className="full-address mono" dir="ltr">{row.stealthAddress}</span>}</td><td role="cell" className="status-cell"><Status row={row}/>{row.status === 'pending' && <span className="status-hint">Review in your wallet</span>}{row.transferTx && <TxLink label="USDC transfer" hash={row.transferTx}/>}{row.announceTx && row.announceTx !== row.transferTx && <TxLink label="Announcement" hash={row.announceTx}/>}{row.status === 'sent' && row.transferTx && <a className="receipt-link" href={receiptFor(row)} target="_blank" rel="noreferrer"><Icon name="receipt" size={14}/>View receipt</a>}{row.error && <p className="row-error">{row.error}</p>}{row.status === 'unresolved' && !row.transferTx && !sending && <button className="text-button" onClick={() => release(row)}>Not sent, retry</button>}</td></tr>)}</tbody></table>
            <div className="send-footer">{complete ? <div className="completion"><span className="completion-mark"><Icon name="check"/></span><div><strong>Payroll complete</strong><p>{paid} of {review.rows.length} sent. Receipts are ready.</p></div><button className="button secondary" onClick={newPayroll}>Start new payroll</button></div> : <><p className="send-explainer"><Icon name="lock" size={16}/>Each payment needs wallet approval: one batch, or a transfer then an announcement. Sending stops at the first failure.</p><p className="send-total">Remaining to send: <strong>{usdc(remaining)} USDC</strong> + gas</p>{shortfall && <div className="notice danger" role="alert"><Icon name="info"/><div>The treasury holds {usdc(review.balance)} USDC, less than the {usdc(remaining)} USDC left to send. Add USDC{NETWORK.testnet ? ' from the Circle faucet' : ''}, then review again.</div></div>}<label className="checkbox-line confirm-line"><input type="checkbox" checked={agreed} disabled={sending || !onNetwork} onChange={event => setAgreed(event.target.checked)}/><span>I checked every name and amount. These are {fundsLabel}.</span></label><div className="send-action-row"><span>{paid} of {review.rows.length} payments sent</span>{sending ? <button className="button secondary" disabled={pauseRequested} onClick={() => { pause.current = true; setPauseRequested(true); }}><Icon name="pause"/>{pauseRequested ? 'Pausing after this payment…' : 'Pause after this payment'}</button> : <button className="button primary" disabled={!canSend} onClick={sendRun}>{attempted ? 'Resume remaining payments' : 'Confirm and send'}<Icon name="arrow" size={16}/></button>}</div></>}</div>
          </section>}
          {error && <div className="notice danger" role="alert"><Icon name="info"/><div>{error}</div></div>}
          {runMessage && <div className="notice success" role="status"><Icon name="check"/><span>{runMessage}</span></div>}
          <section id="how-it-works" className="how-it-works" aria-labelledby="how-title"><h2 id="how-title">A clear path to payday</h2><div className="how-grid"><div><span className="how-number">01</span><h3>Collect meta-addresses</h3><p>Each recipient creates one on the Get paid page and sends it to you.</p></div><div><span className="how-number">02</span><h3>Upload and review</h3><p>Belroll derives a fresh one-time address for every row in your browser.</p></div><div><span className="how-number">03</span><h3>Pay and announce</h3><p>USDC goes to each one-time address, with an announcement only the recipient can match.</p></div></div></section>
        </div><aside className="run-summary" aria-labelledby="summary-title"><div className="summary-heading"><Icon name="receipt" size={18}/><h2 id="summary-title">Run summary</h2></div><div className="summary-total"><span>Total payroll</span><div><strong>{csvRows.length ? total : '0.00'}</strong><span>USDC</span></div><span>Excludes gas</span></div><dl className="summary-details"><div><dt>Payments</dt><dd>{csvRows.length}</dd></div>{review && <div><dt>Sent</dt><dd>{paid} of {review.rows.length}</dd></div>}<div><dt>Network</dt><dd><span className="network-dot"/>{NETWORK.label}</dd></div><div><dt>Asset</dt><dd>USDC</dd></div></dl><div className="summary-note"><Icon name="info" size={16}/><p>Gas is paid in ETH from the treasury wallet and shown in your wallet before you approve.</p></div><div className="privacy-note"><Icon name="lock" size={18}/><div><strong>What stays private</strong><p>{PRIVACY_NOTE}</p></div></div></aside></div>
        <details id="about" className="about-box"><summary><Icon name="info" size={18}/><span>About Belroll</span><Icon name="chevron" size={16}/></summary><div><p>Belroll runs on {NETWORK.label} with {fundsLabel}. It is a client-side payroll prototype, not a production payroll service.</p><p>{PRIVACY_NOTE} Every payment goes to a new ERC-5564 stealth address derived from the recipient’s meta-address, and an announcement lets only that recipient find it. Patterns can still leak: paying many exact amounts at once, or a recipient later moving funds to a known wallet, can link payments to people.</p><p>Your CSV and names stay in this browser. A small local journal stores payment keys, one-time addresses, transaction hashes and the block where each attempt started, so this browser can resume a run and search the chain before ever sending a payment twice. Clearing storage or using another device loses this protection.</p><p>Receipt links contain readable payment details in their URL fragment, including the name and one-time address. Anyone you share a link with can read those details.</p><p>One-time addresses receive USDC but no ETH for gas. Finding and withdrawing payments is not part of this prototype yet.</p></div></details>
        <footer className="workspace-footer"><span><span className="footer-dot"/>Your CSV stays in your browser</span><span>Built for {NETWORK.label} <Icon name="lock" size={13}/></span></footer>
      </main>}
    </div>
  </div>;
}
