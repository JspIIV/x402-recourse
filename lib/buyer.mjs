// A Recourse buyer: plain x402 over HTTP. GET, read the 402, sign one EIP-3009 authorization bound to this listing and
// this request, GET again with PAYMENT-SIGNATURE, and read the response and the PAYMENT-RESPONSE.
import { signPayment, unb64 } from './x402.mjs';

export async function x402Fetch(url, request, wallet, dep) {
  const u = new URL(url); u.searchParams.set('q', request);
  const first = await fetch(u);
  if (first.status !== 402) throw new Error('expected 402, got ' + first.status);
  const required = unb64(first.headers.get('PAYMENT-REQUIRED'));
  const listingId = required.accepts[0].extra.recourse.listingId;
  const paid = await signPayment({ wallet, required, listingId, request, collector: dep.erc3009_collector.address });
  const second = await fetch(u, { headers: { 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(paid)).toString('base64') } });
  const body = await second.json();
  if (second.status !== 200) throw new Error('payment refused: ' + second.status + ' ' + JSON.stringify(body).slice(0, 300));
  return { required, paid, body, settlement: unb64(second.headers.get('PAYMENT-RESPONSE')) };
}
