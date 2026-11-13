# API

Every method a buyer, a seller, a stranger or the court calls, with its arguments and revert strings.

## HTTP: a Recourse seller (x402 v2, `auth-capture`)

`GET /api/<service>?q=<request>`

| Call | Answer |
|---|---|
| no `PAYMENT-SIGNATURE` header | `402`, header `PAYMENT-REQUIRED`: base64 JSON `{ x402Version: 2, resource, accepts: [requirements] }` |
| `PAYMENT-SIGNATURE`: base64 JSON payload | `200` with `{ service, request, response, paymentHash, authorizeTx, deliverTx, disputeWindowSeconds }` and header `PAYMENT-RESPONSE`; or `402` with an `error` if the payment does not match the service or the request, or the escrow refused it |

`requirements` (one entry of `accepts`):

```json
{
  "scheme": "auth-capture", "network": "eip155:4221", "amount": "250000", "asset": "<TestUSDC>", "payTo": "<seller>",
  "maxTimeoutSeconds": 120,
  "extra": {
    "name": "Test USDC", "version": "2", "authCaptureEscrow": "<escrow>", "captureAuthorizer": "<RecourseOperator>",
    "operatorType": "custom", "receiverAuthorizer": "0x0", "policy": "0x0", "paymentFlow": "escrow",
    "captureDeadline": 0, "refundDeadline": 0, "minFeeBps": 0, "maxFeeBps": 0, "feeRecipient": "0x0", "assetTransferMethod": "eip3009",
    "recourse": { "listingId": 0, "court": "<court>", "disputeWindowSeconds": 300, "deliverWithinSeconds": 300 }
  }
}
```

Payload: `{ x402Version: 2, resource, accepted: <requirements>, payload: { authorization, signature, salt }, extensions: { recourse: { request, requestNonce } } }`.
`authorization` is EIP-3009 `ReceiveWithAuthorization` to the ERC-3009 collector; its nonce is the escrow's payment
hash with the payer zeroed. `salt = (listingId << 224) | uint224(keccak256(abi.encode(keccak256(request), requestNonce)))`.
`lib/x402.mjs` builds all of it; `lib/buyer.mjs` is a complete buyer in 15 lines.

## RecourseOperator (GenLayer Chain)

| Method | Who | Does | Reverts |
|---|---|---|---|
| `list(token, price, deliverWithin, window, title, offer)` | a seller | adds a listing; returns its id | `price`, `deliver-within` (30 s to 1 day), `window` (60 s to 7 days), `title` (1 to 80 bytes), `offer` (1 to 1000) |
| `close(listingId)` | that listing's seller | stops new payments; held ones keep their terms | `only-seller` |
| `authorize(PaymentInfo, amount, collector, collectorData)` | anybody | holds the payment in the escrow | `operator`, `no-listing`, `listing-closed`, `not-this-listing`, `price-mismatch`, `no-fees`, `capture-deadline-too-soon`, then the escrow's own errors |
| `deliver(hash, request, nonce, response)` | the payment's seller, once | records the request and the response | `not-held`, `only-seller`, `delivery-late`, `request-length`, `response-length`, `request-mismatch` |
| `capture(hash)` | anybody, after the window | pays the seller | `not-delivered`, `window-open` |
| `dispute(hash)` | the payer, inside the window | hands the payment to the court | `not-delivered`, `only-payer`, `window-closed` |
| `rule(hash, delivered, reason)` | the court | captures (`true`) or voids (`false`) | `only-court`, `not-disputed` |
| `refund(hash)` | the payment's seller | voids it, at any time before capture | `only-seller`, `not-open` |
| `voidUndelivered(hash)` | anybody, after the delivery deadline | voids a payment never delivered | `not-held`, `delivery-not-late` |
| `setCourt(court)` | the deployer, once | names the court | `only-deployer`, `court-set` |

All revert strings are prefixed `Recourse:`.

Reads: `listingCount()`, `listingFacts(id)` (seller, token, price, deliverWithin, window, active), `listingTitle(id)`,
`listingOffer(id)`, `paymentCount()`, `paymentHashes(i)`, `facts(hash)` (status, listingId, payer, seller, amount,
deliveredAt, disputedAt, captureDeadline), `ruling(hash)` (ruled, delivered, reason), `offerOf(hash)`, `requestOf(hash)`,
`responseOf(hash)`, `paymentInfo(hash)`, `saltFor(listingId, request, nonce)`, `requestCommitment(request, nonce)`.

Status: `0` None, `1` Held, `2` Delivered, `3` Disputed, `4` Captured, `5` Voided. A payment the buyer reclaimed in the
escrow after its capture deadline stays `Held` or `Delivered` here; the escrow's `paymentState(hash)` shows it empty.

Events: `Listed`, `ListingClosed`, `Authorized`, `Delivered`, `Disputed`, `Captured`, `Voided`, `Ruled`, `CourtSet`.

## Recourse court (GenLayer Bradbury, Intelligent Contract)

| Method | Kind | Does |
|---|---|---|
| `rule(payment_hash)` | write, anybody | reads the case from the operator, has a round rule `DELIVERED` or `NOT_DELIVERED`, records it, and sends `rule()` to the operator when final. Fund the message: see `SKILL.md` |
| `resend(payment_hash)` | write, anybody | repeats a recorded ruling with no model, if it has not reached the operator |
| `case(payment_hash)` | view | the case as JSON: `payment`, `verdict`, `why`, `listing`, `service`, `payer`, `seller`, `amount`, `request`, `response`, `ruled_at`, `by`, `reason` |
| `page(start, count)` | view | rulings, newest first, at most 50 |
| `operator_address()` | view | the operator it rules on |

`rule` answers `{ ok: false, error }` and changes nothing for a malformed hash, a payment already ruled, a payment not
under dispute, or a round with no readable verdict. `reason` is `sha256("recourse|" + hash + "|" + verdict)`, the same
bytes the operator stores.
