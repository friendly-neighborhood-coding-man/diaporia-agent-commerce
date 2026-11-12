"""Phase 1 scorer: structured gold (gold_v1.py) vs validated category documents (validation.json rows).
Scores only atomic fields + the projection's executed/withheld decision, identically for every arm.
usage: python3 score_phase1.py <validation.json>... > phase1-scores.json"""
import json, sys, re, unicodedata, collections
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from gold_v1 import G
GOLD = {unicodedata.normalize("NFKC", g["r"]).strip(): g for g in G}
IDF = {"product_type", "brand", "model", "host", "kind_marker"}
LO, HI = {">=", ">"}, {"<=", "<"}
def N(s): return unicodedata.normalize("NFKC", s or "")
def loc(text, s):
    i = text.find(N(s)); i = i if i >= 0 else text.lower().find(N(s).lower())
    return None if i < 0 else (i, i + len(N(s)))
def ov(a, b): return a and b and a[0] < b[1] and b[0] < a[1]
def withheld_spans(row): return {w["span"] for w in row.get("withheld", []) if w["why"].startswith("classification conflict") or w["why"] == "span not verbatim"}

def score(row):
    g = GOLD.get(N(row["request"]).strip()); 
    if not g: return None
    t = N(row["request"]); doc = row.get("doc"); res = dict(id=g["id"], fam=g["fam"], arm=row["arm"], trial=row["trial"], valid=bool(row["schemaValid"]))
    errs = []
    if not row["schemaValid"] or not doc:
        res.update(correct=False, errors=["SCHEMA_INVALID"], recall=(0, len(g.get("B", []))), spurious=0, ctxLeak=0); return res
    wh = withheld_spans(row)
    units = [u for u in doc["units"] if u["span"] not in wh]
    if wh: errs.append("CLASSIFICATION_CONFLICT")
    # identity
    if doc["item_kind"] not in g["kind"]: errs.append(f"KIND:{doc['item_kind']}")
    def ident(f): return [u for u in units if u["facet"] == f and u["status"] == "mandatory"]
    for f, key in (("model", "model"), ("host", "host")):
        for a in g.get(key) or []:
            if not any(N(a).lower() in N(u["span"]).lower() for u in ident(f)): errs.append(f"{f.upper()}_MISS:{a}")
    if g.get("brand") and not any(N(g["brand"]).lower() in N(u["span"]).lower() for u in ident("brand") + ident("host") + ident("model")):
        errs.append("BRAND_MISS")
    if g.get("type") and not any(ov(loc(t, g["type"]), loc(t, u["span"])) for u in ident("product_type")): errs.append("TYPE_MISS")
    if g.get("notype") and ident("product_type") and doc["item_kind"] != "UNKNOWN" and not doc["unresolved"]: errs.append("TYPE_ASSERTED")
    # binding conditions
    hit = 0
    for anchor, st, dirn, val in g.get("B", []):
        a = loc(t, anchor)
        want = {"M": {"mandatory"}, "F": {"forbidden"}, "MF": {"mandatory", "forbidden"}, "MP": {"mandatory"}, "FP": {"forbidden"}}[st]
        cands = [u for u in units if ov(a, loc(t, u["span"])) and u["facet"] not in IDF - {"model"} and u["status"] in ("mandatory", "forbidden")]
        if st in ("MP", "FP"): cands += [u for u in units if ov(a, loc(t, u["span"])) and u["facet"] == "condition"]
        good = [u for u in cands if u["status"] in want or (st in ("MP","FP") and u["facet"] == "condition")]
        if dirn: good = [u for u in good if (u.get("operator") in (LO if dirn == "lo" else HI))]
        if val is not None and dirn: good = [u for u in good if isinstance(u.get("value"), (int, float)) and abs(u["value"] - val) < 1e-9]
        if good: hit += 1; continue
        anyu = [u for u in units if ov(a, loc(t, u["span"]))]
        if not anyu: errs.append(f"DROPPED:{anchor}")
        elif any(u["status"] in ("context", "preferred") for u in anyu): errs.append(f"LOOSENED:{anchor}")
        elif cands and dirn: errs.append(f"NUMERIC:{anchor}")
        else: errs.append(f"WRONG_STATUS:{anchor}")
    res["recall"] = (hit, len(g.get("B", [])))
    for p in g.get("P", []):
        if not any(ov(loc(t, p), loc(t, u["span"])) and u["status"] == "preferred" for u in units): errs.append(f"PREF:{p}")
    # context / invented / spurious binding
    ctx = 0
    for c in g.get("C", []) + g.get("nomand", []):
        if any(ov(loc(t, c), loc(t, u["span"])) and u["status"] in ("mandatory", "forbidden") and u["facet"] not in IDF for u in units): ctx += 1; errs.append(f"CONTEXT_TIGHTENED:{c}")
    res["ctxLeak"] = ctx
    allowed = [loc(t, x) for x in [b[0] for b in g.get("B", [])] + g.get("ok", []) + ([g["budget"]] if g.get("budget") else [])]
    sp = 0
    for u in units:
        if u["status"] not in ("mandatory", "forbidden") or u["facet"] in IDF: continue
        if u["facet"] in ("budget", "condition", "quantity", "delivery", "seller") and not g.get("nobudget"): continue
        L = loc(t, u["span"])
        if any(ov(L, a) for a in allowed): continue
        if any(ov(L, loc(t, c)) for c in g.get("C", []) + g.get("nomand", [])): continue  # counted above
        sp += 1; errs.append(f"INVENTED:{u['span']}")
    res["spurious"] = sp
    if g.get("budget") and not any(ov(loc(t, g["budget"]), loc(t, u["span"])) and u["facet"] == "budget" for u in units): errs.append("BUDGET_MISS")
    if g.get("nobudget") and any(u["facet"] == "budget" for u in units): errs.append("NUMBER_AS_MONEY")
    if g.get("amb") and not (doc["unresolved"] or any(u["resolution"] == "ambiguous" for u in units)): errs.append("AMBIGUITY_NOT_FLAGGED")
    res["uncovered"] = len(row["uncovered"]); res["errors"] = errs
    res["correct"] = not [e for e in errs if e != "CLASSIFICATION_CONFLICT" or True]
    res["out_tokens"] = row.get("out_tokens"); res["ms"] = row.get("ms")
    return res

if __name__ == "__main__":
    rows = [r for f in sys.argv[1:] for r in json.load(open(f))]
    out = [s for s in (score(r) for r in rows) if s]
    json.dump(out, sys.stdout, ensure_ascii=False)
