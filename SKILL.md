---
name: x402-recourse
description: Pay for an x402 service with a way back. Recourse makes Internet Court the custom operator of x402's auth-capture scheme, so the payment waits in Coinbase's escrow, the seller is paid when the dispute window closes, and a disputed payment is ruled by GenLayer validators from the seller's own offer and recorded response, and settled by the court itself. Use when an agent buys from, or sells to, another agent over x402 and the buyer needs recourse for a bad delivery.
---

# Recourse: buyer recourse for x402

x402's `exact` scheme moves money once. Its `auth-capture` scheme holds the money first, in Coinbase's
`AuthCaptureEscrow`, and lets the payment's operator capture it or void it. The spec's `"custom"` operator type allows
arbitration. Recourse is that operator, and Internet Court is the arbitrator.

```text
buyer  GET /api/service?q=...                       -> 402, auth-capture requirements naming the RecourseOperator
buyer  signs one EIP-3009 authorization             -> request committed into the salt, no gas
seller relays it: RecourseOperator.authorize        -> money held in Coinbase's AuthCaptureEscrow
seller runs the service, deliver(hash, request, nonce, response) on chain
       no dispute in the window                     -> anybody: capture(hash), the seller is paid
       buyer: dispute(hash)                         -> anybody: court.rule(hash) on GenLayer
       court, when final, calls rule() itself       -> DELIVERED captures to the seller, NOT_DELIVERED voids to the buyer
```

## Deployed on GenLayer Bradbury (chain 4221)

| Contract | Address | Source |
|---|---|---|
| Recourse court (Intelligent Contract) | `0x2F9c9CbaCd282240D7AF1389815BAd6ac0c60b87` | `contracts/recourse.py` |
| RecourseOperator | `0x53bF40B3253535CfD71919dd23d73327C0149dD3` | `evm/RecourseOperator.sol` |
| AuthCaptureEscrow | `0x14b6E956558ffc07E818e999497d018b38a5500F` | `base/commerce-payments`, unmodified |
| ERC3009PaymentCollector | `0x0ae002c21d9c3616B0eCefF9a07Aa3B0f1C696bD` | same |
| Test USDC (EIP-3009, anyone may mint) | `0x1A85dd374273a21cB0e19a9083Af520C61F96145` | `evm/TestUSDC.sol` |

RPC for GenLayer writes: `https://rpc-bradbury.genlayer.com`. RPC for EVM calls: `https://rpc.testnet-chain.genlayer.com`.

## Buy

```js
import { x402Fetch } from './lib/buyer.mjs';
const { body } = await x402Fetch('https://<sellers>/api/weather-now', 'Ankara', wallet, deployment);
// body.response, body.paymentHash; the dispute window is body.disputeWindowSeconds from delivery
```

## Sell

1. `RecourseOperator.list(token, price, deliverWithin, window, title, offer)`. The offer is the standard the court will
   apply: say plainly what a paid call returns.
2. Answer unpaid calls with `paymentRequired(...)` from `lib/x402.mjs`, then relay the payment with `authorize`, run the
   service, and call `deliver(hash, request, requestNonce, response)`. `lib/seller.mjs` does all of it.
3. After the window, anybody (you too) calls `capture(hash)`.

## Dispute and rule

1. The buyer calls `dispute(hash)` inside the window.
2. Anybody asks the court, funding the message that carries the ruling to the operator:
   ```js
   const gasLimit = 400000n, maxGasPrice = 1000000000n, budget = gasLimit * maxGasPrice;
   const feeParams = AbiCoder.defaultAbiCoder().encode(['uint256','uint256'], [gasLimit, maxGasPrice]);
   const messageAllocations = [{ messageType: 0, onAcceptance: false, recipient: OPERATOR, budget, feeParams }];
   const e = await client.estimateTransactionFees({ totalMessageFees: budget, messageAllocations });
   await client.writeContract({ address: COURT, functionName: 'rule', args: [hash],
     fees: { distribution: e.distribution, feeValue: e.feeValue, messageAllocations } });
   ```
3. Read `court.case(hash)` for the verdict and reasoning, `operator.facts(hash)` for where the money went. If a ruling
   was recorded but did not land, `court.resend(hash)` repeats it.

## What the court guarantees

- It judges the seller's own offer, the request the buyer signed and the response the seller recorded. Nobody can hand
  it other text.
- Only it can decide a disputed payment, once. An undisputed payment needs nobody.
- Instructions to the judges, in the request or in the response, are ignored in both directions.
- The money stays in Coinbase's escrow and goes only to the listed seller or back to the buyer. If the court never rules,
  the buyer reclaims it from the escrow after the capture deadline.

## Decision payload

| Field | Where | Meaning |
|---|---|---|
| `verdict` | `court.case(hash).verdict` | `DELIVERED` or `NOT_DELIVERED`, agreed by the round |
| `why` | same | the leading judge's words, not agreed by the round |
| `ruled`, `delivered`, `reason` | `operator.ruling(hash)` | `reason` is sha256 of `recourse|<hash>|<verdict>` |
| status | `operator.facts(hash)[0]` | 4 Captured, 5 Voided |

## Limits

- The court judges whether the response is what the offer promises, not whether it is true of the world.
- Payments live on GenLayer Chain, where the court can call the operator itself. Base payments would need a carrier.
