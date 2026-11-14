// GenLayer Chain (4221), as Recourse's sellers, scripts and page reach it.
//
// GenLayer's own node answers the EVM methods for GenLayer Chain, and the chain's public Conduit endpoint does too. The
// Conduit endpoint rate-limits by IP (error -32017), which a shared serverless IP or a busy browser hits quickly, so
// GenLayer's node goes first. A request that is refused as rate-limited was never processed, so it is retried, then
// sent to the other endpoint. Nothing else is retried: a send that timed out may have gone through.
import { JsonRpcProvider } from 'ethers';

export const CHAIN_ID = 4221;
export const CHAIN_RPCS = ['https://rpc-bradbury.genlayer.com', 'https://rpc.testnet-chain.genlayer.com'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const throttled = (e) => /-32017|rate limit|429|too many requests/i.test(String(e?.message || '') + ' ' + JSON.stringify(e?.info?.error || e?.error || {}));

export class ChainProvider extends JsonRpcProvider {
  constructor(urls = CHAIN_RPCS, options = {}) {
    super(urls[0], CHAIN_ID, { staticNetwork: true, batchMaxCount: 8, pollingInterval: 1500, ...options });
    this.backups = urls.slice(1).map((u) => new JsonRpcProvider(u, CHAIN_ID, { staticNetwork: true, batchMaxCount: 8, ...options }));
  }
  async send(method, params) {
    for (let i = 0; ; i++) {
      try { return await super.send(method, params); }
      catch (e) {
        if (!throttled(e)) throw e;
        if (i < 2) { await sleep(700 * (i + 1)); continue; }
        for (const b of this.backups) { try { return await b.send(method, params); } catch (e2) { if (!throttled(e2)) throw e2; } }
        throw e;
      }
    }
  }
}
