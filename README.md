# Belroll

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

Open `#/get-paid`, generate keys, download the key backup, confirm you saved it, then copy the `st:basesep:0x…` meta-address and send it to the payer. Keys are generated in the browser and kept only in memory and the backup file. Losing the backup means losing access to payments. Never paste the keys anywhere.

Finding and withdrawing payments (scanning announcements and deriving each one-time key) is not built yet. The backup holds everything an ERC-5564 scheme 1 scanner needs. One-time addresses receive USDC but no ETH for gas.

## Run a payroll

1. Connect the treasury wallet (any injected wallet: MetaMask, Coinbase Wallet, Rabby…) and switch to Base Sepolia. It needs testnet USDC (Circle faucet) and a little Base Sepolia ETH for gas.
2. Upload a UTF-8 CSV. Parsing happens in the browser; any invalid row rejects the whole file with line numbers.
3. Set a **pay run reference** and choose **Review payments**. Belroll derives a one-time stealth address for every row and shows the treasury's USDC balance.
4. Tick the confirmation and choose **Confirm and send**. For each row the wallet either signs one atomic EIP-5792 batch (when it reports `atomic: supported`) or two transactions: the USDC transfer, then `announce(1, stealthAddress, ephemeralPubKey, metadata)`. Rows run one at a time and stop at the first failure. **Pause after this payment** is available while sending.
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

Before any wallet request, a journal in `localStorage` (`belroll.journal.v2`) records the row's key, payload hash, one-time address, ephemeral public key, view tag and the starting block. It never stores names, meta-addresses or amounts in plaintext. Reviewing the same CSV and reference again reuses each attempted row's one-time address, so a resume can never pay a second address.

EVM wallets have no idempotency keys, so recovery uses the chain:

- A declined request marks the row failed; resuming retries it to the same address.
- A known transaction hash is confirmed before anything is resent. A revert marks the row failed.
- An unknown outcome searches USDC `Transfer` logs from the treasury to the one-time address. If nothing is found, sending stays blocked until you check your wallet and choose **Not sent, retry**.
- If the transfer landed but the announcement did not, resuming only announces (after checking for an existing `Announcement` log).
- Automatic recovery is refused 12 hours after an attempt. Check the address on BaseScan instead.

The public Base Sepolia RPC limits `eth_getLogs` to 200-block spans, so recovery scans in 200-block chunks. Web Locks block parallel runs across tabs. Changing account or network invalidates the review.

## Validation performed

- `npm run typecheck` and `npm run build`: pass.
- `npm test`: 39 unit tests pass, covering CSV parsing, stealth derivation and recipient key recovery, announcement metadata, sequential sends, batching, rejection, lost outcomes, timeouts, reverts, declined announcements, journal corruption, wrong network or account, recovery expiry, pause and receipts.
- The chain reads (block number, USDC balance, chunked `Transfer` and `Announcement` log scans) were run against `sepolia.base.org`.
- The production build was opened in a browser: payroll page, CSV upload and Get paid key generation render without errors.
- **Not yet verified:** a real wallet send on Base Sepolia, the EIP-5792 batch path in a real wallet, and the key backup download.

The earlier Playwright/axe production-export suite was written for the Beldex wallet bridge and has been removed.

## Source map

| Path | Responsibility |
| --- | --- |
| `src/App.tsx` | Wallet connection, file flow, review table, sequential run lock, receipt route |
| `src/GetPaid.tsx` | Recipient key generation, backup download, meta-address copy |
| `src/stealth.ts` | ERC-5564 scheme 1 derivation and announcement metadata |
| `src/chain.ts` | wagmi config and the `ChainClient` (USDC, announcer, batching, log scans) |
| `src/payments.ts` | Journal, review preparation, `sendPayment(row)` and recovery |
| `src/csv.ts` | Strict CSV parsing and exact USDC decimals |
| `src/receipt.ts` | Fragment-encoded receipts |
| `src/config.ts` | Network flag, addresses, limits |

Runtime license notices are in `public/third-party-notices.txt`, copied to `dist/`. Design guidance attributions are retained in `docs/design-guide-LICENSE.txt`; tokens and layout rules are in `DESIGN.md`.
