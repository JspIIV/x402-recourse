# Recourse: buyer recourse for x402, with Internet Court as the operator

Working name. A platform where AI agents sell services over x402 and buy them from each other, and where a payment
that did not get what it paid for can be taken back by Internet Court.

## The gap

x402's `exact` scheme moves money once and cannot give it back. x402's own `auth-capture` scheme
(`specs/schemes/auth-capture`, EVM binding on Coinbase's audited `base/commerce-payments` contracts) adds a lifecycle:
`authorize` holds the buyer's funds, then `capture` pays the seller or `void` returns them. But in every operator type
the spec defines, the **seller's side decides** capture or void. The buyer's only recourse is `reclaim` after the
capture deadline, which a seller defeats by capturing first.

The spec leaves the door open on purpose: a `"custom"` operator is a contract that "MAY impose additional rules: time
locks, freeze windows, role-gated capture or void, **arbitration**", "without changing the escrow, the facilitator, or
the scheme". Internet Court's own repository has x402 connectors for payment and delegation, and nothing for disputes.
Recourse is that arbitration operator.

## What is reused, unmodified

| Part | Source | Why it matters |
|---|---|---|
| `AuthCaptureEscrow`, `ERC3009PaymentCollector` | `base/commerce-payments` (MIT, audited by Cantina and Spearbit), vendored at a pinned commit | the escrow x402's auth-capture scheme names; we deploy the same code on GenLayer Chain and match it byte for byte against Coinbase's canonical deployment on Base Sepolia (`0xf96815976523E00e65Be8f34cA5e64b4f41EB19c`) |
| Uniswap Permit2 | already at its canonical address on GenLayer Chain | the scheme's second funding path |
| x402 wire format | `coinbase/x402` v2 specs: 402 `PaymentRequirements` with `extra.operatorType = "custom"`, `captureAuthorizer` = our operator; offer and receipt extension for signed offers | buyers and sellers speak plain x402 |
| ERC-8004 registries | from Rerun | seller identity, and the court's rulings written as validation results (milestone) |
| MetaMask Delegation Framework | from Overrule | a buyer agent paying from its owner's smart account under a mandate (milestone) |

## New parts

**`RecourseOperator.sol`** on GenLayer Chain, the `PaymentInfo.operator` of every Recourse payment:
- `authorize(...)`, permissionless, forwards to the escrow, as the spec requires of a custom operator.
- A service registry: a seller lists a service with its price and **the promise**, a plain-words description of what a
  paid call returns. The listing is the seller's own on-chain words, so nobody else can define what was promised.
- `deliver(paymentHash, response)`: the seller records what it returned for that payment. Only the payment's receiver
  can, and only once. The court therefore judges the seller's own record, never text the buyer supplies.
- A dispute window per listing. `capture` is open to anybody once the window passes with no dispute, so an honest
  seller is paid without asking anybody.
- `dispute(paymentHash)`: only the payer, only inside the window, only after delivery or after a delivery deadline.
- `rule(paymentHash, delivered, reason)`: only the court. `DELIVERED` captures to the seller, `NOT_DELIVERED` voids to
  the buyer. Once. Sent only when the GenLayer verdict is final.
- The seller can always void (refund) voluntarily. The buyer can always `reclaim` after the capture deadline, as the
  escrow guarantees.

**`RecourseCourt`**, an Intelligent Contract on GenLayer Bradbury: reads the listing's promise, the buyer's request
and the seller's recorded response from the operator, has validators rule whether the response is what the promise
says a paid call returns, and calls `rule()` on the operator itself through its Ghost on GenLayer Chain. No relayer.
Text from either side that addresses the judges is framed as untrusted, in both directions.

**Sellers**: x402 resource servers that answer 402 with auth-capture requirements naming the operator, relay the
buyer's authorization, run the service, and record the response. Two demo sellers, one honest and one that returns
something other than what it promised, using only free public data (no API keys).

**Buyers**: an agent with its own key in the page, paying with plain x402 `fetch`, and a dispute button.

**The page**: a marketplace of sellers with their promises, prices and court record; a buyer console; open disputes and
rulings; free attack simulations against the live contracts; proof and contracts.

## Trust, stated plainly

- Funds sit in Coinbase's audited escrow, not in our contract. The operator can only capture to the listed seller or
  void to the payer; it cannot redirect money.
- Nobody but the court decides a disputed payment, and only from the seller's own promise and the seller's own
  recorded response.
- An undisputed payment needs nobody: anybody captures it after the window.
- The court is on GenLayer and the escrow on GenLayer Chain, so the court enforces its own verdict. Payments on Base
  would need a carrier to carry `capture` or `void`, and that carrier would decide where money goes, so the core does
  not offer a Base mode.

## Scope of the first submission (week of 23 November)

1. Vendor and deploy `commerce-payments` on GenLayer Chain; match the bytecode against Base Sepolia.
2. A test dollar with EIP-3009 `receiveWithAuthorization`, so the canonical ERC-3009 collector works unchanged.
3. `RecourseOperator` with its own Solidity checks, `RecourseCourt` with unit checks through a stub.
4. Two sellers and a buyer, end to end over real HTTP 402.
5. An on-chain proof: an honest call captured after the window; a bad call disputed and voided by the court; a buyer
   falsely disputing a good call and losing; hostile text both ways; only the court rules; reclaim after the deadline.
6. The marketplace page, live, with a wallet path and free attack simulations, in its own design.

## Milestones after that

- The court's rulings written to the seller's ERC-8004 record, and the marketplace ranking sellers by it.
- Buyers paying from a MetaMask smart account under an ERC-7710 delegation with a plain-words mandate.
- Partial refunds: the court rules an amount, not only a side (the escrow already supports partial capture).
- More sellers, including other people's x402 services listed under Recourse.

## Open decision

The demo sellers need to answer HTTP 402 from a real server; GitHub Pages cannot. A free Cloudflare Workers (or
Vercel) account, opened by the owner of this project, is enough. Until then the sellers run locally for development
and for the proof.
