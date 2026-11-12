// The two sellers on a local HTTP server, exactly as the Vercel functions run them.
//   PPUB=... PCHG=... node server/local.mjs     then GET http://localhost:8402/api/weather-now?q=Berlin
import http from 'http';
import { handle } from '../lib/seller.mjs';
import { sellerEnv } from '../scripts/keys.mjs';
const env = { ...process.env, ...(await sellerEnv()) };
const PORT = Number(process.env.PORT || 8402);
http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'PAYMENT-SIGNATURE, content-type', 'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const m = u.pathname.match(/^\/api\/([a-z-]+)$/);
  if (!m) { res.writeHead(404, cors); return res.end(); }
  try {
    const r = await handle(m[1], { url: `http://localhost:${PORT}${u.pathname}`, query: Object.fromEntries(u.searchParams), headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v])) }, env);
    res.writeHead(r.status, { 'content-type': 'application/json', ...cors, ...(r.headers || {}) });
    res.end(JSON.stringify(r.body));
  } catch (e) { res.writeHead(500, { 'content-type': 'application/json', ...cors }); res.end(JSON.stringify({ error: String(e.message || e).slice(0, 300) })); }
}).listen(PORT, () => console.log('sellers on http://localhost:' + PORT + '/api/weather-now and /api/weather-budget'));
