import { base, baseSepolia } from 'viem/chains';
import type { Address } from 'viem';

export const APP_NAME = 'Nightroll';

export const NETWORKS = {
  'base-sepolia': {
    chain: baseSepolia, label: 'Base Sepolia', shortName: 'basesep', testnet: true,
    rpcUrl: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org',
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address,
  },
  base: {
    chain: base, label: 'Base', shortName: 'base', testnet: false,
    rpcUrl: 'https://mainnet.base.org', explorer: 'https://basescan.org',
    usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address,
  },
} as const;
export type NetworkKey = keyof typeof NETWORKS;

/** Base Sepolia unless the build sets VITE_NETWORK=base. Mainnet is opt-in only. */
export const NETWORK_KEY: NetworkKey = import.meta.env?.VITE_NETWORK === 'base' ? 'base' : 'base-sepolia';
export const NETWORK = NETWORKS[NETWORK_KEY];
export const CHAIN_ID = NETWORK.chain.id;

// Canonical CREATE2 deployments, verified on Base Sepolia and Base (eth_getCode).
export const ANNOUNCER_ADDRESS: Address = '0x55649E01B5Df198D18D95b5cc5051630cfD45564';
export const REGISTRY_ADDRESS: Address = '0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538';

export const SEND_ASSET = 'USDC' as const;
export const USDC_DECIMALS = 6;
export const MAX_CSV_BYTES = 256 * 1024;
export const MAX_ROWS = 500;
// Unknown outcomes are searched on-chain from the block recorded before the attempt.
// Past this window, reconcile manually instead of trusting a long log search.
export const RECOVERY_WINDOW_MS = 12 * 60 * 60 * 1000;
// sepolia.base.org rejects eth_getLogs spans over 200 blocks (error -32614).
export const LOG_CHUNK_BLOCKS = 200n;
// Storage names keep the earlier project name so runs in progress survive the rename.
export const JOURNAL_KEY = 'belroll.journal.v2';
export const RECEIPT_TIMEOUT_MS = 120_000;
