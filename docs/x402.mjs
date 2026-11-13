// x402 v2, `auth-capture` scheme on EVM, as Recourse uses it: the wire objects, the PaymentInfo they rebuild, and the
// one signature a buyer makes. Shared by the sellers (server), the buyer agents and the proof.
//
// Spec: coinbase/x402 specs/x402-specification-v2.md, transports-v2/http.md, schemes/auth-capture/scheme_auth_capture_evm.md
import { AbiCoder, keccak256, toUtf8Bytes, hexlify, randomBytes } from 'https://esm.sh/ethers@6.13.4';

export const CHAIN_ID = 4221;
export const NETWORK = 'eip155:4221';
const abi = AbiCoder.defaultAbiCoder();
const PI_TYPE = 'tuple(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)';
export const PAYMENT_INFO_TYPEHASH = keccak256(toUtf8Bytes('PaymentInfo(address operator,address payer,address receiver,address token,uint120 maxAmount,uint48 preApprovalExpiry,uint48 authorizationExpiry,uint48 refundExpiry,uint16 minFeeBps,uint16 maxFeeBps,address feeReceiver,uint256 salt)'));
// Base64 of UTF-8 JSON, the same in Node and in a browser.
export const b64 = (o) => { const bytes = new TextEncoder().encode(JSON.stringify(o)); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); };
export const unb64 = (s) => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(String(s)), (c) => c.charCodeAt(0))));
const ZERO = '0x0000000000000000000000000000000000000000';
const hex32 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

/// The request commitment a Recourse buyer puts in the low 224 bits of the salt; the high 32 bits name the listing.
export function recourseSalt(listingId, request, requestNonce) {
  const commit = BigInt(keccak256(abi.encode(['bytes32', 'bytes32'], [keccak256(toUtf8Bytes(request)), requestNonce])));
  return (BigInt(listingId) << 224n) | (commit & ((1n << 224n) - 1n));
}

/// The 402 a seller answers with, for one listing.
export function paymentRequired({ url, description, listingId, seller, price, dep, deliverWithin, window, now = Math.floor(Date.now() / 1000) }) {
  const captureDeadline = now + Number(deliverWithin) + Number(window) + 3600 + 600; // operator's COURT_TIME plus slack
  return {
    x402Version: 2,
    error: 'PAYMENT-SIGNATURE header is required',
    resource: { url, description, mimeType: 'application/json' },
    accepts: [{
      scheme: 'auth-capture', network: NETWORK, amount: String(price), asset: dep.test_usdc.address, payTo: seller, maxTimeoutSeconds: 120,
      extra: {
        name: 'Test USDC', version: '2', authCaptureEscrow: dep.auth_capture_escrow.address,
        captureAuthorizer: dep.operator.address, operatorType: 'custom', receiverAuthorizer: ZERO, policy: ZERO, paymentFlow: 'escrow',
        captureDeadline, refundDeadline: captureDeadline + 7 * 86400, minFeeBps: 0, maxFeeBps: 0, feeRecipient: ZERO, assetTransferMethod: 'eip3009',
        recourse: { listingId: Number(listingId), court: dep.court.address, disputeWindowSeconds: Number(window), deliverWithinSeconds: Number(deliverWithin) },
      },
    }],
  };
}

/// PaymentInfo rebuilt from the requirements and the payload, field by field (the spec's PaymentInfo appendix).
export function paymentInfoOf(req, payer, validBefore, salt) {
  const x = req.extra;
  return {
    operator: x.captureAuthorizer, payer, receiver: req.payTo, token: req.asset, maxAmount: BigInt(req.amount),
    preApprovalExpiry: BigInt(validBefore), authorizationExpiry: BigInt(x.captureDeadline), refundExpiry: BigInt(x.refundDeadline),
    minFeeBps: x.minFeeBps, maxFeeBps: x.maxFeeBps, feeReceiver: x.feeRecipient, salt: BigInt(salt),
  };
}
export const piTuple = (p) => [p.operator, p.payer, p.receiver, p.token, p.maxAmount, p.preApprovalExpiry, p.authorizationExpiry, p.refundExpiry, p.minFeeBps, p.maxFeeBps, p.feeReceiver, p.salt];

/// AuthCaptureEscrow.getHash, computed locally.
export function escrowHash(p, escrow, chainId = CHAIN_ID) {
  const inner = keccak256(abi.encode(['bytes32', PI_TYPE], [PAYMENT_INFO_TYPEHASH, piTuple(p)]));
  return keccak256(abi.encode(['uint256', 'address', 'bytes32'], [chainId, escrow, inner]));
}

/// The buyer's one signature: EIP-3009 ReceiveWithAuthorization to the escrow's ERC-3009 collector, nonce bound to the
/// payment with the payer zeroed (the collector's _getHashPayerAgnostic).
export async function signPayment({ wallet, required, listingId, request, collector, now = Math.floor(Date.now() / 1000) }) {
  const req = required.accepts[0];
  const requestNonce = hexlify(randomBytes(32));
  const salt = recourseSalt(listingId, request, requestNonce);
  const validBefore = now + req.maxTimeoutSeconds;
  const agnostic = paymentInfoOf(req, ZERO, validBefore, salt);
  const nonce = escrowHash(agnostic, req.extra.authCaptureEscrow);
  const authorization = { from: wallet.address, to: collector, value: String(req.amount), validAfter: '0', validBefore: String(validBefore), nonce };
  const signature = await wallet.signTypedData(
    { name: req.extra.name, version: req.extra.version, chainId: CHAIN_ID, verifyingContract: req.asset },
    { ReceiveWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }] },
    authorization,
  );
  return {
    x402Version: 2, resource: required.resource, accepted: req,
    payload: { authorization, signature, salt: hex32(salt) },
    extensions: { recourse: { request, requestNonce } },
  };
}
