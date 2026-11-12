# Recording tooling for the demo video

Temporary, demo-only tooling used to record `demo-final.mp4`. It is not part of the product and changes no product code. Absolute paths in these files are the cloud container's scratch folder (`$R`); adjust them to rerun.

| File | Purpose |
|---|---|
| `server.mts` | Starts the repository's own offline MOCK demo world (`scripts/buy-panel/demo-app.ts`) on 127.0.0.1:8790 with a DEV-ONLY client token and owner key from the environment (`TOK`, `OWN`) and `DELAY` ms of simulated provider latency |
| `reset.sh` | Kills old processes, generates fresh DEV-ONLY credentials, writes the host's MCP config, starts the server, starts Claude Code in tmux inside xterm on the Xvfb display `:99` |
| `hostenv.sh`, `runhost.sh` | Run the Claude Code CLI with a clean `HOME` (no memory or project context), the MCP config, two allowed DIAPORIA tools and `sysprompt.txt` appended |
| `sysprompt.txt` | The one paragraph appended to the host's system prompt (pass the user's words verbatim; do not print the panel link; answer status from `get_shopping_panel`) |
| `record.cjs` | Playwright driver: opens the browser window, starts `ffmpeg -f x11grab`, types the prompts into the host, reads the `panelUrl` from the host's own transcript, drives the panel, the owner page and the MOCK buyer step with the DEV-ONLY owner key, logs `events.json` |
| `build.py`, `cards.cjs`, `title.html`, `close.html` | Title and closing cards, captions (`captions.ass`) timed from `events.json`, final H.264 encode |
| `waiting.html`, `sandbox-evidence.html` | The browser's placeholder before the panel opens, and the verbatim run-2 excerpt of `docs/TEST_REPORT.md` |
| `events.json`, `host-pane.txt`, `receipt.txt`, `captions.ass` | Evidence from the take used in the video |

Steps: `Xvfb :99 -screen 0 1920x1080x24 &`, complete Claude Code's first-run screens once in the clean `HOME`, then `DELAY=2500 bash reset.sh` and `node record.cjs` (with `R`, `H`, `OWN`, `OUT` set), then `python3 build.py $R $OUT $E`.

No credential is stored here: the DEV-ONLY token and owner key were generated per run, used only against a loopback, in-memory MOCK server, and discarded.
