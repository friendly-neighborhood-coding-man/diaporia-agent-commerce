import json, sys, os, random, threading
from concurrent.futures import ThreadPoolExecutor, as_completed
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__))); from call import call
# usage: run.py <requests.json> <trial> <arms,comma> <outdir> [workers]
reqs = json.load(open(sys.argv[1])); trial = sys.argv[2]; arms = sys.argv[3].split(","); outdir = sys.argv[4]; W = int(sys.argv[5]) if len(sys.argv) > 5 else 10
os.makedirs(outdir, exist_ok=True)
done = set(); path = f"{outdir}/trial{trial}.jsonl"
if os.path.exists(path):
    for l in open(path):
        d = json.loads(l)
        if d.get("doc") is not None or d.get("result_text"): done.add((d["arm"], d["request"]))
jobs = [(a, r["request"]) for r in reqs for a in arms if (a, r["request"]) not in done]
random.Random(f"kcat-{trial}").shuffle(jobs)
lock = threading.Lock(); n = 0
print(f"{len(jobs)} jobs", flush=True)
with ThreadPoolExecutor(W) as ex, open(path, "a") as f:
    futs = [ex.submit(call, a, r) for a, r in jobs]
    for fu in as_completed(futs):
        d = fu.result(); d["trial"] = trial
        with lock:
            f.write(json.dumps(d, ensure_ascii=False) + "\n"); f.flush(); n += 1
            if n % 50 == 0: print(n, flush=True)
print("DONE", n, flush=True)
