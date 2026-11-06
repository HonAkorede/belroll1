import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, concat, getAddress, hexToBytes, keccak256, pad, toHex, type Address, type Hex } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';

/** ERC-5564 scheme 1: secp256k1 with view tags. */
export const SCHEME_ID = 1n;
// ERC-20 transfer(address,uint256) selector, used in announcement metadata.
const TRANSFER_SELECTOR = '0xa9059cbb';
const N = secp256k1.CURVE.n;

export interface StealthKeys {
  spendingPrivateKey: Hex;
  viewingPrivateKey: Hex;
  metaAddress: string;
}
export interface StealthPayment {
  stealthAddress: Address;
  ephemeralPublicKey: Hex;
  viewTag: Hex;
}

const compressed = (s: string) => /^0[23][a-f0-9]{64}$/i.test(s);

/** Accepts `st:<chain>:0x<spending><viewing>` (66 compressed bytes). Returns null when invalid. */
export function parseMetaAddress(input: string): { spendingPublicKey: Hex; viewingPublicKey: Hex } | null {
  const match = /^st:([a-z0-9-]{1,32}):0x([a-f0-9]{132})$/i.exec(input.trim());
  if (!match) return null;
  const spending = match[2].slice(0, 66), viewing = match[2].slice(66);
  if (!compressed(spending) || !compressed(viewing)) return null;
  try {
    secp256k1.ProjectivePoint.fromHex(spending).assertValidity();
    secp256k1.ProjectivePoint.fromHex(viewing).assertValidity();
  } catch { return null; }
  return { spendingPublicKey: `0x${spending.toLowerCase()}`, viewingPublicKey: `0x${viewing.toLowerCase()}` };
}

export function formatMetaAddress(chain: string, spendingPublicKey: Hex, viewingPublicKey: Hex) {
  return `st:${chain}:${concat([spendingPublicKey, viewingPublicKey])}`;
}

export function generateKeys(chain: string): StealthKeys {
  const spending = secp256k1.utils.randomPrivateKey(), viewing = secp256k1.utils.randomPrivateKey();
  return {
    spendingPrivateKey: bytesToHex(spending),
    viewingPrivateKey: bytesToHex(viewing),
    metaAddress: formatMetaAddress(chain, bytesToHex(secp256k1.getPublicKey(spending, true)), bytesToHex(secp256k1.getPublicKey(viewing, true))),
  };
}

// keccak256 of the compressed ECDH point, reduced into the scalar field.
function hashedSecret(privateKey: Uint8Array | Hex, publicKey: Hex) {
  const hash = keccak256(secp256k1.getSharedSecret(typeof privateKey === 'string' ? hexToBytes(privateKey) : privateKey, hexToBytes(publicKey), true));
  return { hash, scalar: BigInt(hash) % N };
}

function stealthAddressFrom(spendingPublicKey: Hex, scalar: bigint): Address {
  const point = secp256k1.ProjectivePoint.fromHex(spendingPublicKey.slice(2)).add(secp256k1.ProjectivePoint.BASE.multiply(scalar));
  return getAddress(publicKeyToAddress(bytesToHex(point.toRawBytes(false))));
}

/** Sender side: derive a one-time address. A fresh ephemeral key is used and then discarded. */
export function generateStealthPayment(metaAddress: string, ephemeralPrivateKey = secp256k1.utils.randomPrivateKey()): StealthPayment {
  const keys = parseMetaAddress(metaAddress);
  if (!keys) throw new Error('Invalid stealth meta-address.');
  const { hash, scalar } = hashedSecret(ephemeralPrivateKey, keys.viewingPublicKey);
  return {
    stealthAddress: stealthAddressFrom(keys.spendingPublicKey, scalar),
    ephemeralPublicKey: bytesToHex(secp256k1.getPublicKey(ephemeralPrivateKey, true)),
    viewTag: `0x${hash.slice(2, 4)}`,
  };
}

/** Recipient side: the private key that controls a stealth address. */
export function stealthPrivateKey(keys: Pick<StealthKeys, 'spendingPrivateKey' | 'viewingPrivateKey'>, ephemeralPublicKey: Hex): Hex {
  const { scalar } = hashedSecret(keys.viewingPrivateKey, ephemeralPublicKey);
  return toHex((BigInt(keys.spendingPrivateKey) + scalar) % N, { size: 32 });
}

/** Announcement metadata: view tag, then transfer selector, token address and amount. */
export function announcementMetadata(viewTag: Hex, token: Address, amount: bigint): Hex {
  return concat([viewTag, TRANSFER_SELECTOR, token, pad(toHex(amount), { size: 32 })]).toLowerCase() as Hex;
}
