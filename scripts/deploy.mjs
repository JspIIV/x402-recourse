// Deploys Recourse on GenLayer Bradbury:
//   GenLayer Chain (4221): Coinbase's AuthCaptureEscrow and ERC3009PaymentCollector (commerce-payments, unmodified),
//                          the test dollar, and the RecourseOperator;
//   GenLayer (Intelligent Contract): the Recourse court, then wired into the operator once.
//
//   PCHG=... node scripts/deploy.mjs
import { Wallet, JsonRpcProvider, ContractFactory, Contract } from 'ethers';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { client, fees, EXPLORER } from './net.mjs';
import { compile, ROOT } from './compile.mjs';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'; // the same constructor argument as Coinbase's deployment
const KS = path.join(os.homedir(), '.genlayer', 'keystores');
const w = await Wallet.fromEncryptedJson(fs.readFileSync(path.join(KS, 'pchg.json'), 'utf8'), process.env.PCHG || '');
const evm = w.connect(new JsonRpcProvider('https://rpc.testnet-chain.genlayer.com', 4221));
const OUT = path.join(ROOT, 'deployment.json');
const dep = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { network: 'genlayer testnet bradbury phase 2', chain_id: 4221 };
const save = () => fs.writeFileSync(OUT, JSON.stringify(dep, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deploy(key, name, args = []) {
  if (dep[key]) return dep[key].address;
  const c = compile(name);
  fs.mkdirSync(path.join(ROOT, 'evm', 'abi'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'evm', 'abi', name + '.json'), JSON.stringify(c.abi, null, 2));
  const contract = await new ContractFactory(c.abi, c.bytecode, evm).deploy(...args);
  await contract.waitForDeployment();
  dep[key] = { address: await contract.getAddress(), tx: contract.deploymentTransaction().hash };
  dep.compiler = c.version;
  save();
  console.log('deployed', key.padEnd(18), dep[key].address);
  return dep[key].address;
}

console.log('deployer', w.address);
const escrow = await deploy('auth_capture_escrow', 'AuthCaptureEscrow');
await deploy('erc3009_collector', 'ERC3009PaymentCollector', [escrow, MULTICALL3]);
await deploy('test_usdc', 'TestUSDC');
const operator = await deploy('operator', 'RecourseOperator', [escrow]);

if (!dep.court) {
  const c = client(w.privateKey);
  const code = fs.readFileSync(path.join(ROOT, 'contracts', 'recourse.py'), 'utf8');
  const hash = await c.deployContract({ code, args: [operator], fees: await fees(c) });
  console.log('court tx', hash);
  for (let i = 0; i < 60; i++) {
    await sleep(10000);
    const tx = await c.getTransaction({ hash });
    if (['ACCEPTED', 'FINALIZED'].includes(tx.statusName)) {
      if (tx.txExecutionResultName !== 'FINISHED_WITH_RETURN') { console.error('deploy failed', tx.txExecutionResultName); process.exit(1); }
      dep.court = { address: tx.txDataDecoded?.contractAddress || tx.recipient, tx: hash, deployed_at: new Date().toISOString() };
      save();
      break;
    }
  }
}
if (!dep.wired) {
  const op = new Contract(operator, compile('RecourseOperator').abi, evm);
  await (await op.setCourt(dep.court.address)).wait();
  dep.wired = true; save();
}
console.log('RECOURSE court', dep.court?.address, EXPLORER + '/address/' + dep.court?.address, '| operator', operator);
process.exit(0);
