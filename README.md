# Recourse

**A way back for x402 payments. Internet Court is the custom operator of x402's `auth-capture` scheme: the buyer's
money waits in Coinbase's own escrow, the seller is paid when the dispute window closes, and a disputed payment is
ruled by GenLayer validators from the seller's own offer and recorded response, then settled by the court itself.**

Internet Court · GenLayer · x402.

AI agents already pay each other over x402. With the `exact` scheme, money moves once and cannot come back: a seller that
returns filler keeps the payment. x402's `auth-capture` scheme fixes half of that. The payment is held first, in Coinbase's
`AuthCaptureEscrow` (`base/commerce-payments`, audited), and its operator later captures it to the seller or voids it to
the buyer. But in every operator type the spec defines, the seller's side decides. The buyer's only way out is
`reclaim` after the capture deadline, which a seller defeats by capturing first.

The spec leaves a door open on purpose: a `"custom"` operator may add "arbitration" without changing the escrow, the
facilitator or the scheme. Recourse is that operator, and Internet Court is its arbitrator.

- **Live page:** https://x402-recourse.vercel.app (page and sellers), mirrored at https://jspiiv.github.io/x402-recourse/
- **Skill:** [`SKILL.md`](SKILL.md), how an agent buys, sells, disputes and asks the court
- **The court (GenLayer Bradbury):** [`0x2F9c9CbaCd282240D7AF1389815BAd6ac0c60b87`](https://scan.bradbury.genlayer.com/address/0x2F9c9CbaCd282240D7AF1389815BAd6ac0c60b87)

```text
buyer  ──GET /api/weather-now?q=Ankara──────────────▶ seller: 402, auth-capture terms naming the RecourseOperator
buyer  ──one EIP-3009 signature (no gas); the request is committed into the payment's salt
seller ──authorize──▶ RecourseOperator ──▶ Coinbase AuthCaptureEscrow holds the money
seller ──deliver(hash, request, nonce, response)──▶ recorded on chain, the window opens
       no dispute:  anybody ──capture──▶ the seller is paid
       dispute:     buyer ──dispute──▶ anybody ──rule(hash)──▶ Recourse court (GenLayer): validators read
                    the offer, the request and the response ──▶ DELIVERED or NOT_DELIVERED, final
                    court's Ghost ──rule()──▶ operator ──capture or void──▶ escrow pays the seller or the buyer
```

## The parts

| Contract | Where | What |
|---|---|---|
| `AuthCaptureEscrow`, `ERC3009PaymentCollector` | GenLayer Chain (4221) | Coinbase's [`base/commerce-payments`](https://github.com/base/commerce-payments), **unmodified**, in `vendor/commerce-payments`, built with its deploy profile (solc 0.8.28, viaIR, 100,000 runs) |
| [`RecourseOperator`](evm/RecourseOperator.sol) | GenLayer Chain | the custom operator: listings with each seller's offer, permissionless `authorize`, the request commitment, delivery, the window, disputes, and `rule()` for the court alone |
| [`Recourse`](contracts/recourse.py) | GenLayer Bradbury | the court: an Intelligent Contract that reads a disputed case from the operator and settles it itself |
| [`TestUSDC`](evm/TestUSDC.sol) | GenLayer Chain | a test dollar with EIP-3009 `receiveWithAuthorization`, so Coinbase's collector works unchanged |
| [sellers](lib/seller.mjs) | HTTP (Vercel functions in `api/`, or `server/local.mjs`) | two x402 resource servers that make the same offer; one keeps it |

Addresses are in [`deployment.json`](deployment.json) and [`SKILL.md`](SKILL.md).

## Why it holds

- **The money never touches Recourse.** It sits in Coinbase's escrow, which pays only the receiver or returns to the
  payer, both signed by the buyer. The operator chooses between those two; it cannot redirect, resize or add a fee.
- **The court judges the parties' own words.** The offer is the seller's, written when it listed. The request is the
  buyer's, committed into the payment's salt by the buyer's signature, so the seller cannot record a different one. The
  response is the seller's, written once, before its deadline.
- **Silence pays.** An honest seller needs nobody's approval: with no dispute, anybody captures after the window.
- **Only the court decides a dispute, once.** `rule()` accepts the court's address alone, named once, and only on a
  disputed payment.
- **Neither side can talk the judges round.** The request and the response are framed as untrusted, in both directions.
- **Nothing can trap the money.** A payment never delivered is voided by anybody after the delivery deadline. The operator
  refuses payments that leave the court less than an hour, and if a ruling never lands, the escrow's own `reclaim`
  returns the money to the buyer after the capture deadline.
- **No relayer, no owner.** The court calls the operator itself when its verdict is final. There is no pause, no
  upgrade and no admin.
- **Coinbase's code, as Coinbase ships it.** The escrow and the collector match Coinbase's own deployments on Base and
  Base Sepolia in every executable byte.

## Proven on Bradbury

<!-- PROOF -->

## Tests and checks

`python tests/recourse_rules.py`: 27 checks through the real court against a stub of the runtime and the operator,
covering refusals, both verdicts and what each sends, hostile text in both directions, clipping, rounds that do not
settle, and `resend`.

`node scripts/verify.mjs` checks, with no keys, that the court's deployed source is `contracts/recourse.py` byte for
byte, that every court round in the proof is final with the recorded verdict, that every EVM transaction succeeded, and
that each payment ended where the proof says.

`node scripts/verify_evm.mjs` recompiles the escrow, the collector, the test dollar and the operator and compares each
byte for byte with GenLayer Chain: all four match. It also reads Coinbase's own `AuthCaptureEscrow` and
`ERC3009PaymentCollector` on Base and on Base Sepolia,
[`0xf968...B19c`](https://basescan.org/address/0xf96815976523E00e65Be8f34cA5e64b4f41EB19c#code) and
[`0x8612...ab88`](https://basescan.org/address/0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88#code), identical to the vendored
source in every executable byte; only the metadata hash of file paths differs.

[`SECURITY.md`](SECURITY.md) maps every trust surface to the line that enforces it and the check that proves it, and
[`docs/API.md`](docs/API.md) lists every endpoint, method, argument and revert string.

## Reproduce

```bash
git clone --recurse-submodules https://github.com/JspIIV/x402-recourse && cd x402-recourse
npm install
python tests/recourse_rules.py
node scripts/verify.mjs && node scripts/verify_evm.mjs
```

Run the sellers and the page locally with two funded GenLayer Chain keys: `SELLER_WEATHER_KEY=0x... SELLER_BUDGET_KEY=0x...
node server/local.mjs`, then open http://localhost:8402. On Vercel, import the repository and set the same two variables.
Buying needs MetaMask and a little GEN on GenLayer Bradbury (testnet-faucet.genlayer.foundation); test dollars are free.

## Where it stops, plainly

- The court rules whether the response is what the offer promises for that request. It does not check the answer
  against the world: a plausible wrong temperature, in the promised form, would pass. Checking against the source the
  offer names is a milestone.
- A buyer that misses the window has no recourse but the seller's `refund`. Windows run from one minute to seven days;
  the demo uses five minutes so a reviewer can watch the whole lifecycle.
- Everything runs on GenLayer Chain, where the court calls the operator directly. A payment held on Base would need a
  carrier to deliver the ruling, and that carrier would decide where money goes, so Recourse does not offer one.
- Test dollars only.

## Next

- Rulings written to ERC-8004 as validation results for the seller's identity (as in Rerun).
- Buyer agents paying from their owner's MetaMask smart account under a delegation (as in Overrule).
- Partial refunds: `capture` part, `void` the rest, when the court finds a response partly delivered.

## Licence

MIT. `vendor/commerce-payments` stays under its own MIT licence.
