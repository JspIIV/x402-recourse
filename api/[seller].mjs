// The two Recourse sellers as Vercel functions: GET /api/weather-now?q=Berlin and /api/weather-budget?q=Berlin.
// The same handler as server/local.mjs. Each seller's key is an environment variable of the project
// (SELLER_WEATHER_KEY, SELLER_BUDGET_KEY): a testnet key that pays the gas of authorize and deliver on GenLayer Chain.
import { handle } from '../lib/seller.mjs';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'PAYMENT-SIGNATURE, content-type', 'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE' };

export default async function handler(req, res) {
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') return res.status(204).end();
  const slug = String(req.query.seller || '');
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const url = `${proto}://${req.headers.host}/api/${slug}`;
  try {
    const r = await handle(slug, { url, query: { q: req.query.q }, headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v])) });
    for (const [k, v] of Object.entries(r.headers || {})) res.setHeader(k, v);
    return res.status(r.status).json(r.body);
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
}
