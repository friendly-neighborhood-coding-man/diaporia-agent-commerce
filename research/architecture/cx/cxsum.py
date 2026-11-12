import json,sys
d=json.load(open(sys.argv[1]))
s=d['summary']['service'];print({k:s[k] for k in ['stateCorrect','unsafeRecommendations','paymentGateBypasses','gateBypassCases','legitimateCheckoutAcceptance','allowedProbesPrepared','misses']})
for r in d['results']['service']: print(r['id'],r['state'],r['recommended'],r['locked'],'ok' if r['stateOk'] else 'X','UNSAFE' if r['unsafe'] else '',[ (g['group'],g['outcome']) for g in r['gates']],str(r['why'])[:200])
