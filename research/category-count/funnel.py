#!/usr/bin/env python3
"""IW funnel protocol exports (standing rule, reporting only) for every arm and seen set, derived after scoring from the
scored outputs only. Stage logic copied unchanged from the IW-25 evaluator's funnel25.py (automatic first-failing-stage
attribution, not hand-reviewed). usage: funnel.py <runs.json> <out_dir>"""
import json, re, csv, collections, sys, os
runs = json.load(open(sys.argv[1])); OUT = sys.argv[2]; os.makedirs(OUT, exist_ok=True)
def cases(s):
    src = open(f"/tmp/kcat/h{s}/icases{s}.ts", encoding="utf-8").read()
    return {m.group(2): {"helper": m.group(1), "lang": m.group(3), "request": json.loads('"' + m.group(5) + '"')} for m in re.finditer(r'\b(X|N|AC|D|AS)\("(\w+)", "(en|ko|ja)", \[([^\]]*)\], "((?:[^"\\]|\\.)*)"', src)}
STAGES = ["DISCOVERY", "IDENTITY", "REQUIREMENTS", "EVIDENCE", "ELIGIBILITY", "OFFER", "PREPARE"]
def stages(r, c):
    why = ' || '.join(r['why']); ok_g = [g for g in r['gates'] if not g['mustRefuse']]; prep = any(g['outcome'] == 'PREPARED' for g in ok_g)
    disc = (r['recallAt10'] or 0) > 0 or r['lockOk'] is True or r['topOk'] is True
    st = {}
    st["DISCOVERY"] = "PASS" if disc else ("FAIL" if 'No candidate was found' in why or r['recallAt10'] == 0 else "INDETERMINATE")
    if st["DISCOVERY"] != "PASS": return {**st, **{s: "NOT_REACHED" for s in STAGES[1:]}}, ("DISCOVERY_MISS" if st["DISCOVERY"] == "FAIL" else "OTHER")
    idok = (r['lockOk'] is True) if c['helper'] in ('X',) else (r['topOk'] is True or r['lockOk'] is True)
    idfail = (r['lockOk'] is False) or ('No listing is' in why) or ('bundle/standalone' in why) or ('accessory' in why and 'not the product' in why)
    st["IDENTITY"] = "PASS" if idok else ("FAIL" if idfail else "INDETERMINATE")
    intent = re.search(r'uninterpreted:|unrecognized:|ambiguous:|was not interpreted', why)
    ev = re.search(r'not verified for this product|not confirmed|known violation|evidence against', why)
    st["REQUIREMENTS"] = "FAIL" if intent else ("PASS" if r['state'] == 'RECOMMEND' or not why else "INDETERMINATE")
    st["EVIDENCE"] = "NOT_REACHED" if intent and st["REQUIREMENTS"] == "FAIL" and not ev else ("FAIL" if ev and not intent else ("PASS" if r['state'] == 'RECOMMEND' else "INDETERMINATE"))
    st["ELIGIBILITY"] = "PASS" if r['state'] == 'RECOMMEND' or (c['helper'] == 'AC' and r['state'] == 'INVESTIGATE') else "FAIL"
    cc = r.get('compareCheck'); st["OFFER"] = "PASS" if (cc and cc.get('lowest')) or prep else ("FAIL" if cc else "INDETERMINATE")
    st["PREPARE"] = "PASS" if prep else "FAIL"
    if prep: cause = None
    elif st["IDENTITY"] == "FAIL": cause = "IDENTITY_MISMATCH"
    elif st["REQUIREMENTS"] == "FAIL": cause = "INTENT_PARSE_ERROR"
    elif st["EVIDENCE"] == "FAIL": cause = "EVIDENCE_FALSE_NEGATIVE"
    elif r['state'] == 'HOLD': cause = "FALSE_HOLD"
    elif r['state'] == 'INVESTIGATE': cause = "FALSE_INVESTIGATE"
    elif st["OFFER"] == "FAIL": cause = "NO_ELIGIBLE_OFFER"
    else: cause = "CHECKOUT_GATE_FALSE_REJECTION"
    return st, cause
summ = {}; allrows = []; allfails = []
for arm, sets in runs.items():
    agg = {"positives": 0, "stagePass": collections.Counter(), "failedLegit": 0, "failedInDiscovery": 0, "primaryCauses": collections.Counter()}
    for s, p in sets.items():
        C = cases(s); rs = json.load(open(p["result"]))['results']['service']
        for r in rs:
            if not any(not g['mustRefuse'] for g in r['gates']): continue
            st, cause = stages(r, C[r['id']]); agg["positives"] += 1
            allrows.append({"arm": arm, "set": f"IW-{s}", "id": r['id'], "lang": r['lang'], **st, "state": r['state'], "expected": '|'.join(r['expected']), "primaryCause": cause or ''})
            for x in STAGES: agg["stagePass"][x] += st[x] == "PASS"
            if cause:
                agg["failedLegit"] += 1; agg["primaryCauses"][cause] += 1; agg["failedInDiscovery"] += cause == "DISCOVERY_MISS"
                allfails.append({"arm": arm, "set": f"IW-{s}", "id": r['id'], "request": C[r['id']]['request'], "expected": '|'.join(r['expected']), "actual": r['state'], "locked": r['locked'], "primaryCause": cause, "why": ' || '.join(r['why'])[:300], "avoidable": True})
    agg["failedAfterDiscovery"] = agg["failedLegit"] - agg["failedInDiscovery"]; summ[arm] = agg
for name, rows in (("purchase-funnel.csv", allrows), ("failure-attribution.csv", allfails)):
    with open(f"{OUT}/{name}", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
md = ["# Purchase funnel summary (SEEN IW-23 + IW-25, service caps, automatic attribution)", "", "Reporting only: derived after scoring; oracles, cases and gates unchanged. Stage = first failing stage (IW-25 evaluator logic). Safety is reported separately in REPORT.md.", "",
      "| Arm | Positives | " + " | ".join(STAGES) + " | Failed legit | in discovery | after discovery | top causes |", "|" + "---|" * (len(STAGES) + 6)]
for a, s in summ.items():
    md.append(f"| {a} | {s['positives']} | " + " | ".join(f"{s['stagePass'][x]} ({100*s['stagePass'][x]/s['positives']:.0f}%)" for x in STAGES) + f" | {s['failedLegit']} | {s['failedInDiscovery']} | {s['failedAfterDiscovery']} | " + ", ".join(f"{k} {v}" for k, v in s['primaryCauses'].most_common(3)) + " |")
md += ["", "Conditional rates: each stage's PASS count over the positives that reached it is in purchase-funnel.csv (NOT_REACHED rows excluded)."]
open(f"{OUT}/purchase-funnel-summary.md", "w").write("\n".join(md) + "\n")
print("\n".join(md))
