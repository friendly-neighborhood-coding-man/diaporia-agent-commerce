import json, subprocess, sys, os
R, TAKE, E = sys.argv[1], sys.argv[2], sys.argv[3]
ev = {e['name']: e['t'] for e in json.load(open(f"{TAKE}/events.json"))}
TITLE, CLOSE, T0 = 11.0, 8.0, 5.5          # live segment starts at event time T0
RAW_OFF = 3.0                               # raw.mp4 time = event time - RAW_OFF
T1 = ev['REC_END'] - 2.0
o = lambda t: TITLE + (t - T0)
caps = [
 (T0, ev['PROMPT_SENT'], "Claude Code, a real AI host, gets a shopping request (typed by the recording script)."),
 (ev['PROMPT_SENT'], ev['PANEL_OPEN'], "The host calls DIAPORIA's start_shopping_panel tool over MCP; research runs server-side."),
 (ev['PANEL_OPEN'], ev['RESULTS'], "The DIAPORIA Buy panel opens beside the assistant with live progress (offline demo catalog)."),
 (ev['RESULTS'], ev['DETAIL_Q3'], "Card prices are search-time listings, not totals. Only the Halden A8 has every must-have verified."),
 (ev['DETAIL_Q3'], ev['DETAIL_A8'], "Orrin Q3 is cheaper, but nothing attributable verifies its must-haves: not recommended."),
 (ev['DETAIL_A8'], ev['SELECT_A8'], "Halden A8: each must-have is backed by a quoted manufacturer source; identity is locked."),
 (ev['SELECT_A8'], ev['OFFERS'], "Selecting the product asks every merchant for a fresh quote with shipping and tax."),
 (ev['OFFERS'], ev['PREPARE'], "Verified total $138.35 vs. the $121 listing. Look-alike alpha-audi0.example is rejected."),
 (ev['PREPARE'], ev['OWNER_PAGE'], "The AI can prepare a checkout but cannot authorize spending. Approval moves to the owner page."),
 (ev['OWNER_PAGE'], ev['LIMIT_100'], "Owner page (MOCK). A scripted demo owner enters a DEMO-ONLY key: a simulation, not real consent."),
 (ev['LIMIT_100'], ev['REFUSED_AMOUNT_EXCEEDED'], "The simulated owner sets a $100 spending limit, below the $138.35 verified total..."),
 (ev['REFUSED_AMOUNT_EXCEEDED'], ev['OWNER_RETRY'], "...and DIAPORIA refuses it: AMOUNT_EXCEEDED. No payment is started."),
 (ev['OWNER_RETRY'], ev['MOCK_PAYPAL_PAGE'], "The simulated owner sets a $140 limit and confirms."),
 (ev['MOCK_PAYPAL_PAGE'], ev['BACK_TO_PANEL'], "MOCK PayPal approval: no PayPal call, no money. The owner key stands in for the buyer's login."),
 (ev['BACK_TO_PANEL'], ev['HOST_FOLLOWUP'], "The receipt appears only after the DIAPORIA backend verifies the MOCK capture."),
 (ev['HOST_FOLLOWUP'], ev['SANDBOX_EVIDENCE'], "The host reads DIAPORIA's records: only a MOCK capture is complete. No order, no fulfilment."),
 (ev['SANDBOX_EVIDENCE'], T1, "Recorded PayPal Sandbox run, Nov 9: real test API calls; capture still PENDING_REVIEW."),
]
def ts(x):
  h=int(x//3600); m=int(x%3600//60); s=x%60; return f"{h}:{m:02d}:{s:05.2f}"
ass = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,Inter,31,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,1,40,420,32,1
Style: Tag,Inter,21,&H00A8B3BF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,3,40,40,38,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
for a,b,t in caps: ass += f"Dialogue: 0,{ts(o(a))},{ts(o(b))},Cap,,0,0,0,,{t}\n"
ass += f"Dialogue: 0,{ts(TITLE)},{ts(o(ev['SANDBOX_EVIDENCE']))},Tag,,0,0,0,,Live recording · build be03b52 · MOCK · no money\n"
ass += f"Dialogue: 0,{ts(o(ev['SANDBOX_EVIDENCE']))},{ts(o(T1))},Tag,,0,0,0,,Excerpt of docs/TEST_REPORT.md · not re-run\n"
open(f"{E}/captions.ass","w").write(ass)
live = T1 - T0; total = TITLE + live + CLOSE
print("live", round(live,2), "total", round(total,2))
ss = T0 - RAW_OFF
cmd = ["ffmpeg","-loglevel","error","-y",
 "-loop","1","-t",str(TITLE),"-framerate","30","-i",f"{E}/title.png",
 "-ss",f"{ss:.3f}","-t",f"{live:.3f}","-i",f"{TAKE}/raw.mp4",
 "-loop","1","-t",str(CLOSE),"-framerate","30","-i",f"{E}/close.png",
 "-f","lavfi","-t",f"{total:.3f}","-i","anullsrc=r=48000:cl=stereo",
 "-filter_complex",
 f"[0:v]format=yuv420p,fade=t=out:st={TITLE-0.5}:d=0.5,setsar=1[a];[1:v]fps=30,format=yuv420p,setsar=1,fade=t=in:st=0:d=0.4[b];[2:v]format=yuv420p,fade=t=in:st=0:d=0.5,setsar=1[c];[a][b][c]concat=n=3:v=1:a=0,ass={E}/captions.ass[v]",
 "-map","[v]","-map","3:a","-c:v","libx264","-preset","slow","-crf","18","-profile:v","high","-pix_fmt","yuv420p","-r","30","-c:a","aac","-b:a","128k","-shortest","-movflags","+faststart",f"{E}/demo-final.mp4"]
subprocess.run(cmd, check=True)
