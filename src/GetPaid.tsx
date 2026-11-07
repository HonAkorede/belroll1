import { useEffect, useState } from 'react';
import { getBlockNumber } from 'wagmi/actions';
import { Icon } from './icons';
import { CHAIN_ID, NETWORK } from './config';
import { wagmiConfig } from './chain';
import { backupJson, forgetKeys, loadKeys, saveKeys, type KeyBundle } from './keys';
import { generateKeys } from './stealth';

function downloadBackup(keys: KeyBundle) {
  const url = URL.createObjectURL(new Blob([backupJson(keys)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = `nightroll-stealth-keys-${keys.metaAddress.slice(-8)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Recipient page. Keys live in memory, the downloaded backup and, only if asked, this browser's storage. */
export function GetPaidPage() {
  const [keys, setKeys] = useState<KeyBundle | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [remembered, setRemembered] = useState(() => { try { return !!loadKeys(localStorage); } catch { return false; } });
  const [copied, setCopied] = useState('');
  useEffect(() => {
    if (!keys || saved) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    addEventListener('beforeunload', beforeUnload);
    return () => removeEventListener('beforeunload', beforeUnload);
  }, [keys, saved]);

  async function generate() {
    const fresh: KeyBundle = generateKeys(NETWORK.shortName);
    // Remembering is per key set: ticking the box again replaces any earlier keys.
    setKeys(fresh); setDownloaded(false); setSaved(false); setRemembered(false); setCopied('');
    // Payments can only arrive after the keys exist, so scanning can start here.
    try { const startBlock = await getBlockNumber(wagmiConfig, { chainId: CHAIN_ID }); setKeys(current => current === fresh ? { ...fresh, startBlock } : current); }
    catch { /* The backup still works; scanning will ask for a start date instead. */ }
  }
  function remember(on: boolean) {
    if (!keys) return;
    try { if (on) saveKeys(localStorage, keys); else forgetKeys(localStorage); setRemembered(on); }
    catch { setCopied('This browser blocked local storage. Use the backup file on the Receive page.'); }
  }
  async function copy() {
    if (!keys) return;
    try { await navigator.clipboard.writeText(keys.metaAddress); setCopied('Meta-address copied'); }
    catch { setCopied('Select the meta-address above and copy it manually.'); }
  }

  return <main id="main" tabIndex={-1} className="receipt-main get-paid">
    <a className="back-link" href="#/">← Back to payroll</a>
    <div className="page-heading"><div><h1>Get paid privately</h1><p>Create a stealth meta-address and share it with whoever pays you. Each payment lands at a new one-time address that only you can find.</p></div></div>
    {remembered && !keys && <div className="notice success" role="status"><Icon name="check"/><div>This browser already remembers a set of keys. Open <a href="#/receive">Receive</a> to find payments, or generate new keys below.</div></div>}
    <section className="upload-panel" aria-labelledby="keys-title">
      <div className="section-heading"><div><h2 id="keys-title">1. Generate your keys</h2><p>Created in this browser. Nightroll never sees them.</p></div>
        <button className="button primary" onClick={() => void generate()} disabled={!!keys && !saved}><Icon name="lock" size={16}/>{keys ? 'Generate new keys' : 'Generate keys'}</button></div>
      {keys && <div className="get-paid-body">
        <div className="notice warning" role="alert"><Icon name="info"/><div><strong>Save your key backup now.</strong> It is the only way to reach payments sent to you. If you lose it, the funds are gone. Never paste these keys into a chat, form or website.</div></div>
        <button className="button secondary" onClick={() => { downloadBackup(keys); setDownloaded(true); }}><Icon name="download" size={16}/>Download key backup</button>
        <label className="checkbox-line"><input type="checkbox" checked={saved} disabled={!downloaded} onChange={event => setSaved(event.target.checked)}/><span>I saved the backup file somewhere safe and private.</span></label>
      </div>}
    </section>
    {keys && saved && <section className="upload-panel" aria-labelledby="meta-title">
      <div className="section-heading"><div><h2 id="meta-title">2. Share your meta-address</h2><p>Send this to your employer for the <code>stealth_meta_address</code> column. It is safe to share.</p></div></div>
      <div className="get-paid-body">
        <p className="full-address mono meta-address" dir="ltr">{keys.metaAddress}</p>
        <button className="button primary" onClick={copy}><Icon name="copy" size={16}/>Copy meta-address</button>
        <label className="checkbox-line"><input type="checkbox" checked={remembered} onChange={event => remember(event.target.checked)}/><span>Remember these keys in this browser for the Receive page<span className="field-hint">Anyone who can use this browser profile could take your payments. Only on a device you trust.</span></span></label>
        <p role="status" className="copy-status">{copied}</p>
      </div>
    </section>}
    <div className="review-notice get-paid-notes"><Icon name="info" size={16}/><p>Payments arrive as {NETWORK.label} USDC, plus ETH for gas if the payer adds a top-up. Find and withdraw them on the <a href="#/receive">Receive</a> page with your backup file or remembered keys.</p></div>
  </main>;
}
