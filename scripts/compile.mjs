// Compiles Coinbase's commerce-payments (vendor/commerce-payments, unmodified, MIT) and Recourse's own EVM contracts with
// exactly the settings of Coinbase's canonical Base Sepolia deployment: solc 0.8.28, viaIR, optimizer 100,000 runs,
// cancun. The compiler is the official soljson build, checked against binaries.soliditylang.org (sha256 72ef580a...).
import { createRequire } from 'module';
import fs from 'fs'; import path from 'path'; import url from 'url';

const require = createRequire(import.meta.url);
export const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..');
export const solc = require('solc/wrapper')(require(path.join(ROOT, 'tools', 'soljson-v0.8.28.cjs')));
const CP = path.join(ROOT, 'vendor', 'commerce-payments');
export const SETTINGS = { viaIR: true, optimizer: { enabled: true, runs: 100000 }, evmVersion: 'cancun' };
// commerce-payments' own remappings.txt, plus a prefix for its sources
const REMAP = fs.readFileSync(path.join(CP, 'remappings.txt'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => l.split('='));
export const SOURCES = {
  AuthCaptureEscrow: 'src/AuthCaptureEscrow.sol',
  ERC3009PaymentCollector: 'src/collectors/ERC3009PaymentCollector.sol',
  RecourseOperator: 'evm/RecourseOperator.sol',
  TestUSDC: 'evm/TestUSDC.sol',
};
function resolve(p) {
  if (p.startsWith('evm/')) return path.join(ROOT, p);
  if (p.startsWith('commerce-payments/')) return path.join(CP, 'src', p.slice('commerce-payments/'.length));
  for (const [from, to] of REMAP) if (p.startsWith(from)) return path.join(CP, to + p.slice(from.length));
  return path.join(CP, p);
}
export function findImport(p) {
  const f = resolve(p);
  return fs.existsSync(f) ? { contents: fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n') } : { error: 'not found: ' + p };
}
const cache = {};
export function compile(name) {
  if (cache[name]) return cache[name];
  const file = SOURCES[name];
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: 'Solidity', sources: { [file]: { content: findImport(file).contents } },
    settings: { ...SETTINGS, outputSelection: { [file]: { [name]: ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } } },
  }), { import: findImport }));
  const errs = (out.errors || []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts[file][name];
  cache[name] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object, deployed: c.evm.deployedBytecode.object.toLowerCase(), refs: c.evm.deployedBytecode.immutableReferences || {}, version: solc.version() };
  return cache[name];
}
if (process.argv[1] && process.argv[1].endsWith('compile.mjs')) {
  fs.mkdirSync(path.join(ROOT, 'evm', 'abi'), { recursive: true });
  for (const n of (process.argv[2] ? process.argv.slice(2) : Object.keys(SOURCES))) {
    const t = Date.now(); const c = compile(n);
    fs.writeFileSync(path.join(ROOT, 'evm', 'abi', n + '.json'), JSON.stringify(c.abi, null, 2));
    console.log(n.padEnd(26), (c.bytecode.length - 2) / 2, 'bytes', ((Date.now() - t) / 1000).toFixed(0) + 's', c.version);
  }
}
