// Lists the two demo services on the RecourseOperator, each from its own seller.
//   PPUB=... PCHG=... node scripts/setup.mjs
import { JsonRpcProvider, Contract } from 'ethers';
import fs from 'fs'; import path from 'path';
import { compile, ROOT } from './compile.mjs';
import { SERVICES, sellerWallet } from '../lib/seller.mjs';
import { sellerEnv } from './keys.mjs';
const OUT = path.join(ROOT, 'deployment.json');
const dep = JSON.parse(fs.readFileSync(OUT, 'utf8'));
const env = await sellerEnv();
dep.listings = dep.listings || {};
for (const [slug, s] of Object.entries(SERVICES)) {
  if (dep.listings[slug]) continue;
  const w = sellerWallet(slug, env);
  const op = new Contract(dep.operator.address, compile('RecourseOperator').abi, w);
  const id = Number(await op.listingCount());
  const tx = await op.list(dep.test_usdc.address, s.price, s.deliverWithin, s.window, s.title, s.offer);
  await tx.wait();
  dep.listings[slug] = { id, seller: w.address, tx: tx.hash };
  fs.writeFileSync(OUT, JSON.stringify(dep, null, 2));
  console.log('listed', slug, 'as', id, 'by', w.address);
}
