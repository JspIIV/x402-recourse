// Independent check of the proof, with no keys. Anyone can run it from a fresh clone:
//
//   node scripts/verify.mjs
//
// It trusts nothing this repository says about the outcome. It asks GenLayer for the court's deployed source and
// compares it with contracts/recourse.py byte for byte; asks GenLayer for the status of every court round in
// results/proof.json; asks GenLayer Chain for the receipt of every EVM transaction there; and reads each payment's
// final state from the operator, to compare with what the proof says happened to it.
import crypto from 'crypto'; import fs from 'fs'; import path from 'path'; import url from 'url';
import { JsonRpcProvider, Contract } from 'ethers';
import { reader, EXPLORER } from './net.mjs';

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const proof = JSON.parse(fs.readFileSync(path.join(ROOT, 'results', 'proof.json'), 'utf8'));
const dep = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployment.json'), 'utf8'));
const OP_ABI = JSON.parse(fs.readFileSync(path.join(ROOT, 'evm', 'abi', 'RecourseOperator.json'), 'utf8'));
const c = reader();
const chain = new JsonRpcProvider('https://rpc.testnet-chain.genlayer.com', 4221, { staticNetwork: true });
const op = new Contract(dep.operator.address, OP_ABI, chain);
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const STATUS = ['None', 'Held', 'Delivered', 'Disputed', 'Captured', 'Voided'];
let ok = true;

// 1. the court's source
const local = fs.readFileSync(path.join(ROOT, 'contracts', 'recourse.py'), 'utf8').replace(/\r\n/g, '\n');
const raw = await c.getContractCode(dep.court.address);
const onChain = (typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')).replace(/\r\n/g, '\n');
const same = onChain === local;
ok = ok && same;
console.log('court', dep.court.address, EXPLORER + '/address/' + dep.court.address);
console.log('  source local sha256', sha(local));
console.log('  source chain sha256', sha(onChain), same ? 'MATCH' : 'DIFFERENT');

// 2. the court's rounds
console.log('\ncourt rounds (GenLayer Bradbury)');
for (const [tag, p] of Object.entries(proof.payments)) {
  if (!p.rule_tx) continue;
  const tx = await c.getTransaction({ hash: p.rule_tx });
  const kase = JSON.parse(await c.readContract({ address: dep.court.address, functionName: 'case', args: [p.hash] }));
  const good = tx.statusName === 'FINALIZED' && kase.verdict === p.verdict;
  ok = ok && good;
  console.log(`  ${good ? 'OK ' : 'BAD'} ${tag} ${tx.statusName.padEnd(10)} ${String(kase.verdict).padEnd(14)} ${p.rule_tx}`);
}

// 3. every EVM transaction, and each payment's end state
const WANT = { A: 'Captured', B: 'Voided', C: 'Captured', D: 'Voided', E: 'Held' }; // E is reclaimed in the escrow, not through the operator
console.log('\npayments (GenLayer Chain)');
for (const [tag, p] of Object.entries(proof.payments)) {
  const txs = ['authorize_tx', 'deliver_tx', 'capture_tx', 'void_tx', 'reclaim_tx'].filter((k) => p[k]);
  const receipts = await Promise.all(txs.map((k) => chain.getTransactionReceipt(p[k])));
  const mined = receipts.every((r) => r && r.status === 1);
  const st = STATUS[Number((await op.facts(p.hash))[0])];
  const good = mined && st === WANT[tag];
  ok = ok && good;
  console.log(`  ${good ? 'OK ' : 'BAD'} ${tag} ${st.padEnd(9)} ${txs.map((k, i) => k.replace('_tx', '') + (receipts[i]?.status === 1 ? '' : '(!)')).join(' ')}`);
}
console.log('\n' + (ok ? 'everything in results/proof.json is what the chains say' : 'something differs from the chains'));
fs.writeFileSync(path.join(ROOT, 'results', 'finality.json'), JSON.stringify({ checked_at: new Date().toISOString(), court: dep.court.address, source_sha256: sha(local), source_matches_chain: same, all_ok: ok }, null, 2));
process.exit(ok ? 0 : 1);
