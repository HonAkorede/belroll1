import { createPublicClient, createWalletClient, erc20Abi, http, type Address, type Chain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { estimateL1Fee } from 'viem/op-stack';
import { NETWORK, RECEIPT_TIMEOUT_MS } from './config';

const chain = NETWORK.chain as Chain;
const publicClient = createPublicClient({ chain, transport: http(NETWORK.rpcUrl) });

export const ETH_TRANSFER_GAS = 21_000n;

/**
 * ETH that can leave an address after paying for the transfer itself: the L2 fee at the
 * max fee per gas, plus Base's L1 data fee with a 50% margin. Zero when nothing is left.
 */
export function sweepAmount(balance: bigint, maxFeePerGas: bigint, l1Fee: bigint) {
  const cost = ETH_TRANSFER_GAS * maxFeePerGas + (l1Fee * 3n) / 2n;
  return balance > cost ? balance - cost : 0n;
}

export async function balancesOf(address: Address) {
  const [usdc, eth] = await Promise.all([
    publicClient.readContract({ address: NETWORK.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
    publicClient.getBalance({ address }),
  ]);
  return { usdc, eth };
}

/**
 * Moves everything from one stealth address to `to`, signed locally with the stealth key.
 * The key never leaves this page and is never given to a wallet extension.
 */
export async function withdraw(args: { privateKey: Hex; to: Address; sweepEth: boolean; onStep?: (step: 'usdc' | 'eth') => void }) {
  const account = privateKeyToAccount(args.privateKey);
  const wallet = createWalletClient({ account, chain, transport: http(NETWORK.rpcUrl) });
  const result: { usdcTx?: Hex; ethTx?: Hex } = {};
  const { usdc } = await balancesOf(account.address);
  if (usdc > 0n) {
    args.onStep?.('usdc');
    result.usdcTx = await wallet.writeContract({ address: NETWORK.usdc, abi: erc20Abi, functionName: 'transfer', args: [args.to, usdc], chain });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: result.usdcTx, timeout: RECEIPT_TIMEOUT_MS });
    if (receipt.status !== 'success') throw new Error('The USDC withdrawal reverted. The funds are still at the one-time address.');
  }
  if (args.sweepEth) {
    const eth = await publicClient.getBalance({ address: account.address });
    const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
    const l1Fee = await estimateL1Fee(publicClient, { account, chain, to: args.to, value: eth });
    const value = sweepAmount(eth, maxFeePerGas, l1Fee);
    if (value > 0n) {
      args.onStep?.('eth');
      result.ethTx = await wallet.sendTransaction({ to: args.to, value, gas: ETH_TRANSFER_GAS, maxFeePerGas, maxPriorityFeePerGas, chain });
      await publicClient.waitForTransactionReceipt({ hash: result.ethTx, timeout: RECEIPT_TIMEOUT_MS });
    }
  }
  return result;
}
