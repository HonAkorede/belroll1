import { useEffect, useState } from 'react';
import { Icon } from './icons';
import { ANNOUNCER_ADDRESS, CHAIN_ID, NETWORK } from './config';
import { generateKeys, type StealthKeys } from './stealth';

function downloadBackup(keys: StealthKeys) {
  const backup = {
    app: 'Belroll', format: 'erc5564-scheme-1-keys', network: NETWORK.label, chainId: CHAIN_ID,
    metaAddress: keys.metaAddress, spendingPrivateKey: keys.spendingPrivateKey, viewingPrivateKey: keys.viewingPrivateKey,
    announcer: ANNOUNCER_ADDRESS, createdAt: new Date().toISOString(),
    warning: 'Anyone with the spending key can take your payments. Never paste these keys into a chat, form or website you do not trust.',
  };
  const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url; link.download = `belroll-stealth-keys-${keys.metaAddress.slice(-8)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Recipient page. Keys exist only in this component's memory and in the downloaded backup. */
export function GetPaidPage() {
  const [keys, setKeys] = useState<StealthKeys | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState('');
  useEffect(() => {
    if (!keys || saved) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    addEventListener('beforeunload', beforeUnload);
    return () => removeEventListener('beforeunload', beforeUnload);
  }, [keys, saved]);

  function generate() { setKeys(generateKeys(NETWORK.shortName)); setDownloaded(false); setSaved(false); setCopied(''); }
  async function copy() {
    if (!keys) return;
    try { await navigator.clipboard.writeText(keys.metaAddress); setCopied('Meta-address copied'); }
    catch { setCopied('Select the meta-address above and copy it manually.'); }
  }

  return <main id="main" tabIndex={-1} className="receipt-main get-paid">
    <a className="back-link" href="#/">← Back to payroll</a>
    <div className="page-heading"><div><h1>Get paid privately</h1><p>Create a stealth meta-address and share it with whoever pays you. Each payment lands at a new one-time address that only you can find.</p></div></div>
    <section className="upload-panel" aria-labelledby="keys-title">
      <div className="section-heading"><div><h2 id="keys-title">1. Generate your keys</h2><p>Created in this browser. Belroll never sees or stores them.</p></div>
        <button className="button primary" onClick={generate} disabled={!!keys && !saved}><Icon name="lock" size={16}/>{keys ? 'Generate new keys' : 'Generate keys'}</button></div>
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
        <p role="status" className="copy-status">{copied}</p>
      </div>
    </section>}
    <div className="review-notice get-paid-notes"><Icon name="info" size={16}/><p>Payments arrive as {NETWORK.label} USDC with no ETH for gas. Finding and withdrawing payments is not in this prototype yet; your backup holds everything an ERC-5564 scanner needs.</p></div>
  </main>;
}
