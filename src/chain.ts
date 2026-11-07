import { createConfig, http, type Config } from 'wagmi';
import { injected } from 'wagmi/connectors';
import { getAccount, getBalance, getBlockNumber, getCapabilities, getPublicClient, readContract, sendCalls, sendTransaction, waitForCallsStatus, waitForTransactionReceipt, writeContract } from 'wagmi/actions';
import { encodeFunctionData, erc20Abi, parseAbi, parseAbiItem, type Address, type Chain, type Hex } from 'viem';
import { ANNOUNCER_ADDRESS, CHAIN_ID, LOG_CHUNK_BLOCKS, NETWORK, RECEIPT_TIMEOUT_MS } from './config';
import type { ChainClient } from './payments';
import { SCHEME_ID, type StealthPayment } from './stealth';

export const announcementEvent = parseAbiItem('event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)');
export const announcerAbi = parseAbi(['function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)']);
const transferEvent = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');

// Injected wallets only; EIP-6963 discovery lists each installed wallet separately.
export const wagmiConfig = createConfig({
  chains: [NETWORK.chain as Chain],
  connectors: [injected()],
  transports: { [CHAIN_ID]: http(NETWORK.rpcUrl) },
}) as Config;

const announceCall = (payment: StealthPayment, metadata: Hex) =>
  ({ address: ANNOUNCER_ADDRESS, abi: announcerAbi, functionName: 'announce', args: [SCHEME_ID, payment.stealthAddress, payment.ephemeralPublicKey, metadata] }) as const;

/** Scans [fromBlock, latest] in chunks that public RPC endpoints accept. */
async function scan<T>(fromBlock: bigint, find: (from: bigint, to: bigint) => Promise<T | null>) {
  const latest = await getBlockNumber(wagmiConfig, { chainId: CHAIN_ID });
  for (let start = fromBlock; start <= latest; start += LOG_CHUNK_BLOCKS) {
    const end = start + LOG_CHUNK_BLOCKS - 1n < latest ? start + LOG_CHUNK_BLOCKS - 1n : latest;
    const found = await find(start, end);
    if (found) return found;
  }
  return null;
}

export function createChainClient(config: Config = wagmiConfig): ChainClient {
  const client = () => getPublicClient(config, { chainId: CHAIN_ID })!;
  const account = () => getAccount(config).address;
  return {
    async getChainId() { return getAccount(config).connector?.getChainId(); },
    async getAccount() { return account(); },
    getBlockNumber: () => getBlockNumber(config, { chainId: CHAIN_ID }),
    usdcBalance: owner => readContract(config, { chainId: CHAIN_ID, address: NETWORK.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
    ethBalance: async owner => (await getBalance(config, { chainId: CHAIN_ID, address: owner })).value,
    async supportsBatch() {
      try {
        const capabilities = await getCapabilities(config, { account: account(), chainId: CHAIN_ID });
        // 'ready' would ask the user to upgrade their account first; only use batching where it already works.
        return capabilities?.atomic?.status === 'supported';
      } catch { return false; }
    },
    sendTransfer: (to, amount) => writeContract(config, { chainId: CHAIN_ID, address: NETWORK.usdc, abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
    sendAnnounce: (payment, metadata) => writeContract(config, { chainId: CHAIN_ID, ...announceCall(payment, metadata) }),
    sendEth: (to, value) => sendTransaction(config, { chainId: CHAIN_ID, to, value }),
    async sendBatch(to, amount, payment, metadata, topUp) {
      const { id } = await sendCalls(config, {
        chainId: CHAIN_ID, forceAtomic: true,
        calls: [
          { to: NETWORK.usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }) },
          { to: ANNOUNCER_ADDRESS, value: 0n, data: encodeFunctionData(announceCall(payment, metadata)) },
          ...(topUp ? [{ to, value: topUp, data: '0x' as Hex }] : []),
        ],
      });
      const result = await waitForCallsStatus(config, { id, timeout: RECEIPT_TIMEOUT_MS });
      const receipts = result.receipts ?? [];
      const hash = receipts[0]?.transactionHash;
      if (!hash) throw new Error('The wallet did not return a transaction for this batch. Check your wallet activity, then resume.');
      return { hash, ok: result.status === 'success' && receipts.every(r => r.status === 'success') };
    },
    async confirm(hash) {
      const receipt = await waitForTransactionReceipt(config, { chainId: CHAIN_ID, hash, timeout: RECEIPT_TIMEOUT_MS });
      return receipt.status === 'success';
    },
    findTransfer: (from, to, amount, fromBlock) => scan(fromBlock, async (start, end) => {
      const logs = await client().getLogs({ address: NETWORK.usdc, event: transferEvent, args: { from, to }, fromBlock: start, toBlock: end });
      return logs.find(log => log.args.value === amount)?.transactionHash ?? null;
    }),
    findAnnouncement: (stealthAddress, fromBlock) => scan(fromBlock, async (start, end) => {
      const logs = await client().getLogs({ address: ANNOUNCER_ADDRESS, event: announcementEvent, args: { schemeId: SCHEME_ID, stealthAddress }, fromBlock: start, toBlock: end });
      return logs[0]?.transactionHash ?? null;
    }),
  };
}

export const explorerTx = (hash: Hex) => `${NETWORK.explorer}/tx/${hash}`;
export const explorerAddress = (address: Address) => `${NETWORK.explorer}/address/${address}`;
