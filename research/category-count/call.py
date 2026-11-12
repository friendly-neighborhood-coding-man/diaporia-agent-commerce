import json, subprocess, sys, time, os
HERE = os.path.dirname(os.path.abspath(__file__))
# usage: call.py <arm> <request> -> prints JSON record
def call(arm, request, root=os.environ.get("KCAT_ROOT", HERE), timeout=240):
    prompt = open(f"{root}/prompts/{arm}.txt").read() + json.dumps({"request": request}, ensure_ascii=False) + "\n"
    schema = open(f"{root}/schemas/{arm}.json").read()
    t0 = time.time()
    try:
        p = subprocess.run([os.environ.get("KCAT_HK", os.path.join(HERE, "hk.sh")), "--json-schema", schema], input=prompt, capture_output=True, text=True, timeout=timeout)
        out = json.loads(p.stdout)
    except Exception as e:
        return {"arm": arm, "request": request, "error": repr(e)[:500], "wall_ms": int((time.time()-t0)*1000)}
    u = out.get("usage", {})
    return {"arm": arm, "request": request, "doc": out.get("structured_output"), "result_text": None if out.get("structured_output") else (out.get("result") or "")[:4000],
            "is_error": out.get("is_error"), "models": list((out.get("modelUsage") or {}).keys()), "num_turns": out.get("num_turns"),
            "duration_ms": out.get("duration_ms"), "duration_api_ms": out.get("duration_api_ms"), "wall_ms": int((time.time()-t0)*1000),
            "usage": {k: u.get(k) for k in ("input_tokens","output_tokens","cache_creation_input_tokens","cache_read_input_tokens")},
            "thinking_tokens": (u.get("output_tokens_details") or {}).get("thinking_tokens"), "cost_list_usd": out.get("total_cost_usd"), "session_id": out.get("session_id")}
if __name__ == "__main__":
    print(json.dumps(call(sys.argv[1], sys.argv[2]), ensure_ascii=False, indent=1))
