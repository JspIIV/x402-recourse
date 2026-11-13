"""Builds docs/index.html (served by Vercel with the sellers, and by GitHub Pages) and docs/x402.mjs.

    python docs/build_page.py [sellers-url]

The page carries the deployed addresses, the listings and the proof's results (results/proof.json), so it reads the
chain directly and needs no server of its own. x402.mjs is lib/x402.mjs, the same code the sellers and the proof use,
with its one import pointed at a browser build of ethers.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")
read = lambda *p: open(os.path.join(*p), encoding="utf-8").read()
css = read(HERE, "design.css")
body = read(HERE, "page_body.html")
script = read(HERE, "page_script.html")
dep = json.loads(read(ROOT, "deployment.json"))
proof = json.loads(read(ROOT, "results", "proof.json"))
sellers = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("SELLERS_URL", "")).rstrip("/")

keep = {k: dep[k]["address"] for k in ("operator", "auth_capture_escrow", "erc3009_collector", "test_usdc", "court")}
keep["listings"] = {slug: {"id": l["id"], "seller": l["seller"]} for slug, l in dep["listings"].items()}
gl_txs = {p.get("rule_tx") for p in proof["payments"].values() if p.get("rule_tx")}
page_proof = {
    "accounts": proof["accounts"], "passed": proof.get("passed"), "total": proof.get("total"), "finished": proof.get("finished"),
    "payments": {t: {k: p[k] for k in ("hash", "payment_info", "signature") if k in p} for t, p in proof["payments"].items()},
    "checks": [{"name": c["name"], "ok": c["ok"], "note": c.get("note", ""), "tx": c.get("tx"), "gl": c.get("tx") in gl_txs} for c in proof["checks"]],
}
script = script.replace("__DEP__", json.dumps(keep)).replace("__PROOF__", json.dumps(page_proof)).replace("__SELLERS__", sellers)

head = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Recourse: a way back for x402 payments</title>
<meta name="description" content="An open source GenLayer testnet demo: x402 auth-capture payments held in Coinbase's escrow, with Internet Court as the operator that settles a disputed payment." />
<link rel="icon" href="logo.svg" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
""" + css + """
</style>
</head>
"""
open(os.path.join(HERE, "index.html"), "w", encoding="utf-8", newline="\n").write(head + body + script)
lib = read(ROOT, "lib", "x402.mjs").replace("from 'ethers';", "from 'https://esm.sh/ethers@6.13.4';")
open(os.path.join(HERE, "x402.mjs"), "w", encoding="utf-8", newline="\n").write(lib)
print("docs/index.html and docs/x402.mjs written", "(sellers: " + (sellers or "same origin") + ")")
