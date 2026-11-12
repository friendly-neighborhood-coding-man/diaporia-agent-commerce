"""Phase 2/3 analysis (seen IW-23 + IW-25): per-arm metrics, paired case comparisons, complexity strata, interface losses.
usage: python3 analyze_phase2.py <runs.json> <out_dir>
runs.json: {"<arm>": {"23": {"result": path, "log": path|null}, "25": {...}}, ...}
Complexity strata are a fixed function of the request text (defined before any K-arm downstream run)."""
import json, sys, re, math, random, collections, os, csv
runs = json.load(open(sys.argv[1])); OUT = sys.argv[2]; os.makedirs(OUT, exist_ok=True)

MARK = re.compile(r"\b(?:no|not|without|never|only|but|except|under|over|below|above|at least|at most|up to|max|min|more than|less than|with|that|which|for|fits?|compatible)\b|\$|\d+\s*(?:lb|kg|g|cm|mm|in|inch|ft|feet|l|liters?|gal|gallons?|w|people|°c)|없|말고|이상|이하|미만|가능|용으로|인용|용\b|되는|만원", re.I)
def complexity(req):
    n = len(MARK.findall(req))
    return "simple" if n == 0 else "medium" if n == 1 else "high"
def strata(case):
    s = [complexity(case_req[case["id_full"]])]
    if case["lang"] != "en": s.append("non_english")
    tags = set(case["tags"])
    if tags & {"F3", "accessory", "korean-accessory", "compatibility-water", "compatibility-install", "fitment-with-article", "tank-size"} or any(t.startswith("compat") or t.startswith("fitment") for t in tags): s.append("accessory_compat")
    return s

def gates(r):
    g = r["gates"]
    if isinstance(g, str):
        import ast; g = ast.literal_eval(g)
    return g
def case_metrics(r):
    g = gates(r); pos = "positive-control" in r["tags"]
    prepared = pos and any(x["outcome"] == "PREPARED" and not x.get("mustRefuse") and not x.get("wrongProduct") for x in g)
    return dict(correct=bool(r["stateOk"]), unsafe=bool(r["unsafe"]), falseHold=bool(r["falseHold"]), falseInv=bool(r["falseInvestigate"]), pos=pos,
                legitPrepared=prepared, fullyCorrectPrepared=prepared and bool(r["stateOk"]),
                bypass=sum(1 for x in g if x.get("bypass")), wrongPrepared=sum(1 for x in g if x["outcome"] == "PREPARED" and x.get("wrongProduct")),
                state=r["state"], expected="/".join(r["expected"]))

case_req = {}; data = {}
for arm, sets in runs.items():
    for s, p in sets.items():
        d = json.load(open(p["result"])); sm = d["summary"]["service"]
        rows = {}
        for r in d["results"]["service"]:
            rows[r["id"]] = r
        data.setdefault(arm, {})[s] = dict(rows=rows, summary=sm, log=p.get("log"))
# requests per case id from the case files is not in results; recover from logs of any arm (first request seen per case is not keyed) -> use icases
def load_requests(s):
    src = open(f"/tmp/kcat/h{s}/icases{s}.ts", encoding="utf8").read()
    out = {}
    for m in re.finditer(r'^\s*[A-Z]+\("([a-z0-9]+)",\s*"[a-z]+",\s*\[[^\]]*\],\s*"((?:[^"\\]|\\.)*)"', src, re.M): out[m.group(1)] = json.loads('"' + m.group(2) + '"')
    return out
for s in ("23", "25"):
    for cid, rq in load_requests(s).items(): case_req[f"{s}:{cid}"] = rq

arms = list(runs)
table = {}; per_case = collections.defaultdict(dict)
for arm in arms:
    tot = collections.Counter(); byS = collections.defaultdict(collections.Counter)
    for s, D in data[arm].items():
        for cid, r in D["rows"].items():
            m = case_metrics(r); key = f"{s}:{cid}"; per_case[key][arm] = m
            c = dict(id_full=key, lang=r["lang"], tags=r["tags"])
            for k, v in m.items():
                if isinstance(v, bool) or isinstance(v, int): tot[k] += int(v)
            tot["cases"] += 1
            for st in strata(c) + ["all"]:
                byS[st]["cases"] += 1; byS[st]["correct"] += m["correct"]; byS[st]["unsafe"] += m["unsafe"]; byS[st]["pos"] += m["pos"]; byS[st]["legitPrepared"] += m["legitPrepared"]
        tot[f"bypass_summary_{s}"] = len(D["summary"].get("gateBypassCases") or []) if isinstance(D["summary"].get("gateBypassCases"), list) else D["summary"].get("paymentGateBypasses")
    table[arm] = dict(total=dict(tot), strata={k: dict(v) for k, v in byS.items()},
                      perSet={s: {k: D["summary"].get(k) for k in ("stateCorrect", "unsafeRecommendations", "legitimateCheckoutAcceptance", "paymentGateBypasses", "falseHoldRate", "falseInvestigateRate", "wrongProductPrepared", "wrongProductCompareEligible")} for s, D in data[arm].items()})

def mcnemar(a, b):  # exact two-sided on discordant pairs
    n = a + b
    if n == 0: return 1.0
    k = min(a, b); p = sum(math.comb(n, i) for i in range(0, k + 1)) / 2 ** n
    return min(1.0, 2 * p)
def paired(x, y):
    keys = [k for k in per_case if x in per_case[k] and y in per_case[k]]
    xb = sum(1 for k in keys if per_case[k][x]["correct"] and not per_case[k][y]["correct"])
    yb = sum(1 for k in keys if per_case[k][y]["correct"] and not per_case[k][x]["correct"])
    rnd = random.Random(7); diffs = []
    v = [int(per_case[k][x]["correct"]) - int(per_case[k][y]["correct"]) for k in keys]
    for _ in range(4000): diffs.append(sum(rnd.choice(v) for _ in v) / len(v))
    diffs.sort()
    return dict(n=len(keys), x_only=xb, y_only=yb, diff_pp=round(100 * sum(v) / len(v), 2), ci95_pp=[round(100 * diffs[100], 2), round(100 * diffs[3899], 2)], p_mcnemar=round(mcnemar(xb, yb), 4),
                newUnsafe=[k for k in keys if per_case[k][x]["unsafe"] and not per_case[k][y]["unsafe"]], fixedUnsafe=[k for k in keys if per_case[k][y]["unsafe"] and not per_case[k][x]["unsafe"]])
pairs = {}
for x in arms:
    for y in arms:
        if x < y or y in ("A0",) or (x != y and y == "C2"):
            if x != y: pairs[f"{x}_vs_{y}"] = paired(x, y)
json.dump(dict(table=table, pairs=pairs), open(f"{OUT}/phase2-analysis.json", "w"), indent=1)
with open(f"{OUT}/case-comparison.csv", "w", newline="") as f:
    w = csv.writer(f); w.writerow(["case", "request", "strata"] + [f"{a}:{k}" for a in arms for k in ("state", "correct", "unsafe", "legitPrepared", "bypass", "wrongPrepared")])
    for k in sorted(per_case):
        s, cid = k.split(":"); r0 = data[arms[0]][s]["rows"][cid]
        w.writerow([k, case_req.get(k, ""), "|".join(strata(dict(id_full=k, lang=r0["lang"], tags=r0["tags"])))] + [per_case[k].get(a, {}).get(x, "") for a in arms for x in ("state", "correct", "unsafe", "legitPrepared", "bypass", "wrongPrepared")])
print("arm      correct  unsafe  legitPrep  fullyOKprep  falseHold falseInv  bypass(gates)  wrongPrep")
for a in arms:
    t = table[a]["total"]; print(f"{a:6} {t['correct']:4}/{t['cases']}  {t['unsafe']:3}   {t['legitPrepared']:4}/{t['pos']}   {t['fullyCorrectPrepared']:4}   {t['falseHold']:4} {t['falseInv']:4}   {t['bypass']:3}   {t['wrongPrepared']:3}")
for k, v in pairs.items():
    if k.endswith("_vs_A0") or k.endswith("_vs_C2"): print(k, v["diff_pp"], v["ci95_pp"], v["p_mcnemar"], "new unsafe", v["newUnsafe"])
