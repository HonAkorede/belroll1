# Nightroll

A static, client-side payroll prototype that pays USDC on **Base Sepolia** to **ERC-5564 stealth addresses**. Upload a CSV of recipients' stealth meta-addresses, review every payment, then approve each one in your wallet. Each row goes to a fresh one-time address that only its recipient can find. The entry point is `dist/index.html`.

**Recipients are hidden, but amounts and the treasury wallet are public.**

## Install, build and preview

Use Node.js 22 or newer and npm:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run preview
```

Serve the contents of `dist/` from any static host. There is no backend. Vite uses `base: './'` and routes use the URL fragment (`#/get-paid`, `#/receipt/...`), so a subpath works.

### Network flag

The build targets Base Sepolia by default. Mainnet is opt-in at build time:

```sh
VITE_NETWORK=base npm run build
```

`src/config.ts` holds the chain, RPC URL, USDC address and explorer for each network. The page's Content-Security-Policy in `index.html` only allows `sepolia.base.org` and `mainnet.base.org`; add any other RPC origin there if you change it.

## Contracts

The canonical ERC-5564 and ERC-6538 deployments already exist on Base Sepolia and Base (checked with `eth_getCode`), so no deployment is needed:

| Contract | Address |
| --- | --- |
| ERC-5564 Announcer | `0x55649E01B5Df198D18D95b5cc5051630cfD45564` |
| ERC-6538 Registry (not used yet) | `0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538` |
| USDC, Base Sepolia | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| USDC, Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |

## Get paid (recipients)

Open `#/get-paid`, generate keys, download the key backup, confirm you saved it, then copy the `st:basesep:0x…` meta-address and send it to the payer. Keys are generated in the browser. The backup also records the block the keys were created at, so scanning can start there. Optionally tick **Remember these keys in this browser** (stored in `localStorage` under `nightroll.keys.v1`; per site, so keys saved on localhost are not on the deployed URL). Losing the backup means losing access to payments. Never paste the keys into a chat or another site.

## Receive (recipients)

Open `#/receive`:

1. **Load keys** from this browser, the backup file, or by pasting the backup JSON or the two private keys (spending first). Backups from before the rename load too. The meta-address is always re-derived, and a backup whose keys do not match its meta-address is rejected.
2. **Scan.** Reads `Announcement` events (scheme 1) from the Announcer, from the backup's start block or a date you pick, in 200-block chunks, 4 at a time with retries. About 33 hours of Base Sepolia took 23 seconds in testing; a week takes a few minutes. Each announcement is checked by view tag, then by the full stealth address, so other apps' announcements are skipped. Matches show the announced amount, the current USDC and ETH balance, and the announcement transaction.
3. **Withdraw** to a wallet address you enter, one row at a time or **Withdraw all USDC**. Each one-time address signs its own USDC `transfer` with its derived key, locally over the RPC; no wallet extension is involved. Optionally the leftover ETH is sent too, keeping back the L2 gas and 1.5× Base's L1 data fee. Withdrawing links the one-time address to the destination on-chain, and sending several payments to one wallet links them to each other.

## Run a payroll

1. Connect the treasury wallet (any injected wallet: MetaMask, Coinbase Wallet, Rabby…) and switch to Base Sepolia. It needs testnet USDC (Circle faucet) and a little Base Sepolia ETH for gas.
2. Upload a UTF-8 CSV. Parsing happens in the browser; any invalid row rejects the whole file with line numbers.
3. Set a **pay run reference**. Optionally tick **Also send ETH for gas** and set the amount per payment (default 0.00002 ETH, at most 0.01 ETH): one-time addresses start with no ETH, so without it recipients cannot withdraw. Choose **Review payments**. Nightroll derives a one-time stealth address for every row and shows the treasury's USDC balance and the total top-up.
4. Tick the confirmation and choose **Confirm and send**. For each row the wallet either signs one atomic EIP-5792 batch (when it reports `atomic: supported`) or separate transactions: the USDC transfer, then `announce(1, stealthAddress, ephemeralPubKey, metadata)`, then the ETH top-up if enabled. Rows run one at a time and stop at the first failure. **Pause after this payment** is available while sending.
5. Open **View receipt** on any sent row. Receipts live entirely in the `#/receipt/...` fragment and link to BaseScan. A receipt connects the name to the one-time address, so share it only with the person paid.

## CSV

```csv
name,stealth_meta_address,amount
Alice Moreno,st:basesep:0x03…,12.50
"Sam Okafor, design",st:basesep:0x03…,7.25
```

The header must be exactly `name,stealth_meta_address,amount`. Names are 1–120 characters. A meta-address is `st:<chain>:0x` followed by two compressed secp256k1 public keys (spending, then viewing); both must be valid curve points. Amounts are positive USDC with at most 6 decimals, below one trillion, with no grouping commas, signs or exponents. Limits: 500 rows, 256 KB.

`public/sample-payroll.csv` uses freshly generated meta-addresses whose private keys were discarded. It shows the format only; anything sent to them is unrecoverable.

## Stealth addresses

`src/stealth.ts` implements ERC-5564 scheme 1 with `@noble/curves` (already used by viem): shared secret = compressed ECDH point of the ephemeral key and the viewing key, hashed with keccak256; the view tag is its first byte; the stealth public key is `spending + G·hash`. Announcement metadata is the view tag, the `transfer` selector, the USDC address and the 32-byte amount. The derivation matches ScopeLift's stealth-address SDK, and tests check that the recipient's derived private key controls every sender-generated address.

## Resume and double-payment protection

Before any wallet request, a journal in `localStorage` (`belroll.journal.v2`, a name kept from the project's earlier name so in-progress runs survive the rename) records the row's key, payload hash, one-time address, ephemeral public key, view tag and the starting block. It never stores names, meta-addresses or amounts in plaintext. Reviewing the same CSV and reference again reuses each attempted row's one-time address, so a resume can never pay a second address.

EVM wallets have no idempotency keys, so recovery uses the chain:

- A declined request marks the row failed; resuming retries it to the same address.
- A known transaction hash is confirmed before anything is resent. A revert marks the row failed.
- An unknown outcome searches USDC `Transfer` logs from the treasury to the one-time address. If nothing is found, sending stays blocked until you check your wallet and choose **Not sent, retry**.
- If the transfer landed but the announcement did not, resuming only announces (after checking for an existing `Announcement` log).
- If the top-up is missing, resuming sends only the top-up. ETH transfers have no logs, so it checks the one-time address's balance instead: only this run sends to that fresh address, so any ETH there means the top-up landed. The worst case is one duplicate top-up.
- The top-up amount is part of the run fingerprint; changing it mid-run is blocked like a CSV change.
- Automatic recovery is refused 12 hours after an attempt. Check the address on BaseScan instead.

The public Base Sepolia RPC limits `eth_getLogs` to 200-block spans, so recovery scans in 200-block chunks. Web Locks block parallel runs across tabs. Changing account or network invalidates the review.

## Validation performed

- `npm run typecheck` and `npm run build`: pass.
- `npm test`: 53 unit tests pass, covering CSV parsing, stealth derivation and recipient key recovery, announcement matching (including forged and other people's announcements), chunked scanning with retries and abort, key loading, the ETH sweep, sequential sends, batching, gas top-ups and their recovery, rejection, lost outcomes, timeouts, reverts, journal corruption, wrong network or account, recovery expiry, pause and receipts.
- A real payroll payment was sent on Base Sepolia from a MetaMask-style wallet. The scanner, run against `sepolia.base.org`, found and decoded its announcement.
- The production build was opened in a browser: payroll page with the top-up toggle, Get paid, and Receive (key paste and a live scan) work without errors.
- **Not yet verified:** a real withdrawal, a real top-up, the EIP-5792 batch path in a real wallet, and the key backup download.

The earlier Playwright/axe production-export suite was written for the Beldex wallet bridge and has been removed.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/App.tsx` | Wallet connection, file flow, review table, sequential run lock, receipt route |
| `src/GetPaid.tsx` | Recipient key generation, backup download, meta-address copy, remember keys |
| `src/Receive.tsx` | Load keys, scan announcements, list balances, withdraw |
| `src/keys.ts` | Backup format, key parsing and browser storage |
| `src/scan.ts` | Announcement matching and chunked log fetching |
| `src/withdraw.ts` | Local signing from stealth keys, USDC withdrawal and ETH sweep |
| `src/stealth.ts` | ERC-5564 scheme 1 derivation and announcement metadata |
| `src/chain.ts` | wagmi config and the `ChainClient` (USDC, announcer, batching, log scans) |
| `src/payments.ts` | Journal, review preparation, `sendPayment(row)` and recovery |
| `src/csv.ts` | Strict CSV parsing and exact USDC decimals |
| `src/receipt.ts` | Fragment-encoded receipts |
| `src/config.ts` | Network flag, addresses, limits |

Runtime license notices are in `public/third-party-notices.txt`, copied to `dist/`. Design guidance attributions are retained in `docs/design-guide-LICENSE.txt`; tokens and layout rules are in `DESIGN.md`.
