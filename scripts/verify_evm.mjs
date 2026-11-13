// Independent check that every EVM contract Recourse relies on runs exactly the source in this repository, and that
// the escrow and its collector are Coinbase's own code as Coinbase deployed it.
//
// 1. GenLayer Chain: each contract in deployment.json is compiled here (solc 0.8.28, viaIR, 100,000 runs, cancun, the
//    settings of commerce-payments' deploy profile), its code is read from the chain and compared byte for byte.
//    Immutable values are set at deployment, so their slots are taken from the chain and printed.
// 2. Base: Coinbase's canonical AuthCaptureEscrow and ERC3009PaymentCollector (vendor/commerce-payments README), read
//    from Base and Base Sepolia, against the same compilation. Coinbase compiled from its own checkout, so the CBOR
//    metadata at the end, which hashes source file paths, may differ: MATCH* means every executable byte is the same.
//
//   node scripts/verify_evm.mjs
import { JsonRpcProvider } from 'ethers';
import { execSync } from 'child_process';
import fs from 'fs'; import path from 'path';
import { compile, ROOT } from './compile.mjs';

const dep = JSON.parse(fs.readFileSync(path.join(ROOT, 'deployment.json'), 'utf8'));
const chain = new JsonRpcProvider('https://rpc.testnet-chain.genlayer.com', 4221, { staticNetwork: true });
const strip = (hex) => hex.slice(0, hex.length - (parseInt(hex.slice(-4), 16) + 2) * 2);
let all = true;

function compare(name, live) {
  const c = compile(name);
  const filled = c.deployed.split('');
  const fixed = [];
  for (const spots of Object.values(c.refs)) for (const { start, length } of spots) {
    for (let i = start * 2; i < (start + length) * 2; i++) filled[i] = live[i];
    fixed.push('0x' + live.slice(start * 2, (start + length) * 2).slice(-40));
  }
  const exact = filled.join('') === live;
  const code = live.length > 0 && strip(filled.join('')) === strip(live);
  return { exact, code, immutables: [...new Set(fixed)] };
}

const commit = execSync('git rev-parse HEAD', { cwd: path.join(ROOT, 'vendor', 'commerce-payments') }).toString().trim();
console.log('commerce-payments at', commit.slice(0, 12), '| solc 0.8.28, viaIR, 100,000 runs, cancun');
console.log('\nGenLayer Chain (4221)');
for (const [key, name] of [['auth_capture_escrow', 'AuthCaptureEscrow'], ['erc3009_collector', 'ERC3009PaymentCollector'], ['test_usdc', 'TestUSDC'], ['operator', 'RecourseOperator']]) {
  const live = (await chain.getCode(dep[key].address)).slice(2).toLowerCase();
  const r = compare(name, live);
  all = all && r.exact;
  console.log(`${r.exact ? 'MATCH    ' : 'DIFFERENT'} ${name.padEnd(24)} ${dep[key].address}  ${r.immutables.length ? 'immutables ' + r.immutables.slice(0, 3).join(', ') : ''}`);
}

// Coinbase's own deployments (same address on both networks).
const COINBASE = { AuthCaptureEscrow: '0xf96815976523E00e65Be8f34cA5e64b4f41EB19c', ERC3009PaymentCollector: '0x8612dfdc421f80336cd14E8EF9cb1E765dB5ab88' };
for (const [label, rpc, id] of [['Base Sepolia (84532)', process.env.BASE_SEPOLIA_RPC || 'https://base-sepolia-rpc.publicnode.com', 84532], ['Base (8453)', process.env.BASE_RPC || 'https://base-rpc.publicnode.com', 8453]]) {
  console.log('\n' + label + ', Coinbase\'s own deployment');
  const p = new JsonRpcProvider(rpc, id, { staticNetwork: true });
  for (const [name, address] of Object.entries(COINBASE)) {
    let live;
    try { live = (await p.getCode(address)).slice(2).toLowerCase(); } catch (e) { console.log(`UNREACHED ${name.padEnd(24)} ${address}  ${e.shortMessage || e.message}`); continue; }
    const r = compare(name, live);
    all = all && r.code;
    console.log(`${r.exact ? 'MATCH    ' : r.code ? 'MATCH*   ' : 'DIFFERENT'} ${name.padEnd(24)} ${address}${!r.exact && r.code ? '  * every executable byte; only the metadata hash of file paths differs' : ''}`);
  }
}
console.log('\n' + (all ? 'every contract is the source in this repository, and the escrow is Coinbase\'s code' : 'at least one contract differs'));
process.exit(all ? 0 : 1);
