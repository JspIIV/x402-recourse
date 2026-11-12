// A Recourse seller: an x402 resource server for the auth-capture scheme, and its own facilitator. It answers 402 with
// requirements naming the RecourseOperator, relays the buyer's signed authorization to the operator (which holds the
// money in Coinbase's escrow), runs the service, and records the request and the response on chain with deliver().
// Runs the same in the local server (server/local.mjs) and as a Vercel function (api/[seller].mjs).
import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import { paymentRequired, paymentInfoOf, piTuple, escrowHash, recourseSalt, b64, unb64, NETWORK } from './x402.mjs';
import OPERATOR_ABI from '../evm/abi/RecourseOperator.json' with { type: 'json' };
import DEPLOYMENT from '../deployment.json' with { type: 'json' };

export const CHAIN_RPC = 'https://rpc.testnet-chain.genlayer.com';

// The services. Both sellers make the same offer; one keeps it.
export const SERVICES = {
  'weather-now': {
    title: 'Weather now',
    offer: 'Returns the current air temperature in degrees Celsius and the wind speed in km/h for the city named in the request, read live from Open-Meteo at the time of the call, with the place it resolved the city to.',
    price: 250000n, deliverWithin: 300, window: 300, keyEnv: 'SELLER_WEATHER_KEY',
    async run(request) {
      const city = String(request).trim().slice(0, 80);
      const g = await (await fetch('https://geocoding-api.open-meteo.com/v1/search?count=1&name=' + encodeURIComponent(city))).json();
      const place = g?.results?.[0];
      if (!place) return `No place called "${city}" was found on Open-Meteo, so no weather can be given.`;
      const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,wind_speed_10m`)).json();
      const c = w.current;
      return `${place.name}, ${place.country}: ${c.temperature_2m} °C, wind ${c.wind_speed_10m} km/h (Open-Meteo, ${c.time} UTC).`;
    },
  },
  'weather-budget': {
    title: 'Weather now, budget',
    offer: 'Returns the current air temperature in degrees Celsius and the wind speed in km/h for the city named in the request, read live from Open-Meteo at the time of the call, with the place it resolved the city to.',
    price: 100000n, deliverWithin: 300, window: 300, keyEnv: 'SELLER_BUDGET_KEY',
    async run(request) {
      return `Great news for ${String(request).trim().slice(0, 40)}: every day is a good day! Stay positive and enjoy the sunshine.`;
    },
  },
};

export function sellerWallet(slug, env = process.env) {
  const key = env[SERVICES[slug].keyEnv];
  if (!key) throw new Error('missing ' + SERVICES[slug].keyEnv);
  return new Wallet(key, new JsonRpcProvider(CHAIN_RPC, 4221, { staticNetwork: true }));
}

/// One HTTP exchange. `url` is the resource URL, `query.q` the request, `headers` lower-cased.
export async function handle(slug, { url, query, headers }, env = process.env, dep = DEPLOYMENT) {
  const svc = SERVICES[slug];
  const listing = dep.listings?.[slug];
  if (!svc || !listing) return { status: 404, body: { error: 'no such service' } };
  const request = String(query.q || '').trim();
  const seller = listing.seller;
  const required = paymentRequired({ url, description: svc.title + ': ' + svc.offer, listingId: listing.id, seller, price: svc.price, dep, deliverWithin: svc.deliverWithin, window: svc.window });
  const header = headers['payment-signature'];
  if (!header) return { status: 402, headers: { 'PAYMENT-REQUIRED': b64(required) }, body: required };

  let paid;
  try { paid = unb64(header); } catch { return { status: 400, body: { error: 'PAYMENT-SIGNATURE is not base64 JSON' } }; }
  const acc = paid.accepted || {}, x = acc.extra || {}, rec = paid.extensions?.recourse || {};
  const ok = acc.scheme === 'auth-capture' && acc.network === NETWORK && acc.payTo?.toLowerCase() === seller.toLowerCase()
    && String(acc.amount) === String(svc.price) && acc.asset?.toLowerCase() === dep.test_usdc.address.toLowerCase()
    && x.captureAuthorizer?.toLowerCase() === dep.operator.address.toLowerCase() && x.authCaptureEscrow?.toLowerCase() === dep.auth_capture_escrow.address.toLowerCase()
    && Number(x.recourse?.listingId) === Number(listing.id) && typeof rec.request === 'string' && rec.request === request && /^0x[0-9a-fA-F]{64}$/.test(rec.requestNonce || '');
  if (!ok) return { status: 402, headers: { 'PAYMENT-REQUIRED': b64(required) }, body: { ...required, error: 'the payment does not match this service or this request' } };
  const salt = BigInt(paid.payload.salt);
  if (salt !== recourseSalt(listing.id, request, rec.requestNonce)) return { status: 402, body: { error: 'the salt does not commit to this listing and request' } };

  const a = paid.payload.authorization;
  const pi = paymentInfoOf(acc, a.from, a.validBefore, salt);
  const h = escrowHash(pi, dep.auth_capture_escrow.address);
  const wallet = sellerWallet(slug, env);
  const op = new Contract(dep.operator.address, OPERATOR_ABI, wallet);
  let authorizeTx;
  try {
    const tx = await op.authorize(piTuple(pi), svc.price, dep.erc3009_collector.address, paid.payload.signature);
    await tx.wait(); authorizeTx = tx.hash;
  } catch (e) {
    return { status: 402, headers: { 'PAYMENT-REQUIRED': b64(required) }, body: { ...required, error: 'the escrow refused the authorization: ' + (e.shortMessage || e.message).slice(0, 160) } };
  }
  const response = String(await svc.run(request)).slice(0, 4000);
  const dtx = await op.deliver(h, request, rec.requestNonce, response);
  await dtx.wait();
  const settled = { success: true, transaction: authorizeTx, network: NETWORK, payer: a.from, extensions: { recourse: { paymentHash: h, deliverTx: dtx.hash, disputeWindowSeconds: svc.window } } };
  return { status: 200, headers: { 'PAYMENT-RESPONSE': b64(settled) }, body: { service: svc.title, request, response, paymentHash: h, authorizeTx, deliverTx: dtx.hash, disputeWindowSeconds: svc.window } };
}
