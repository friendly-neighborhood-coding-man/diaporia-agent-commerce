#!/usr/bin/env python3
"""Build the v1.1 fixture for arm C2: the arm's v1 fixture (unchanged) plus the brand_proposal from the brand prompt.
Usage: fixture-merge.py <v1-fixture.json {request: v1doc}> <brand-out.json [{id, brand_proposal}]> <id-to-request.json {id: request}> <out.json>
Every v1 field is copied untouched; a request without a v1 document gets none (the adapter then has nothing to merge)."""
import json, sys, unicodedata
v1, brand, ids, out = sys.argv[1:5]
key = lambda r: unicodedata.normalize("NFKC", r).strip()
fx = {key(k): v for k, v in json.load(open(v1, encoding="utf-8")).items()}
idreq = json.load(open(ids, encoding="utf-8"))
n = 0
for e in json.load(open(brand, encoding="utf-8")):
    bp = e.get("brand_proposal")
    req = idreq.get(e.get("id"))
    if not bp or req is None or key(req) not in fx or not isinstance(fx[key(req)], dict): continue
    fx[key(req)] = {**fx[key(req)], "brand_proposal": bp}; n += 1
json.dump(fx, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{n} brand proposals merged into {len(fx)} v1 documents")
