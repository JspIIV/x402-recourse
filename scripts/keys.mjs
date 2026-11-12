// The local test keystores, unlocked with passwords from the environment. Never committed, never sent anywhere.
import { Wallet } from 'ethers';
import fs from 'fs'; import os from 'os'; import path from 'path';
const KS = path.join(os.homedir(), '.genlayer', 'keystores');
export async function key(name, pw) { return Wallet.fromEncryptedJson(fs.readFileSync(path.join(KS, name + '.json'), 'utf8'), pw); }
/// Seller keys for the local server: weather-now is ppub, weather-budget is pchg.
export async function sellerEnv() {
  return { SELLER_WEATHER_KEY: (await key('ppub', process.env.PPUB)).privateKey, SELLER_BUDGET_KEY: (await key('pchg', process.env.PCHG)).privateKey };
}
