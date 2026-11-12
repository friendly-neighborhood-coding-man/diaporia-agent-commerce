set -e
R=/tmp/claude-0/-home-user/661c2cfa-2ac8-5ad7-b200-ff25b77e92ad/scratchpad/rec; H=$R/hosthome
pkill -f "server.mts" || true; tmux -L rec kill-server 2>/dev/null || true; pkill xterm || true; pkill -f chrome-profile || true; sleep 1
python3 -c "import secrets;print('dct_'+secrets.token_hex(24));print('dok_'+secrets.token_hex(24))" > $R/creds.txt
export TOK=$(sed -n 1p $R/creds.txt) OWN=$(sed -n 2p $R/creds.txt)
printf '{"mcpServers":{"diaporia":{"type":"http","url":"http://127.0.0.1:8790/mcp","headers":{"Authorization":"Bearer %s"}}}}' "$TOK" > $R/mcp.json
rm -rf $H/.claude/projects
cd /home/user/diaporia-agent-commerce && (DELAY=${DELAY:-600} nohup npx tsx $R/server.mts > $R/server.log 2>&1 &)
export DISPLAY=:99 LANG=C.UTF-8 LC_ALL=C.UTF-8
tmux -u -L rec new-session -d -s host -x 84 -y 49 "bash $R/runhost.sh; sleep 999999"
tmux -L rec set -g status off
(xterm -u8 -geometry 84x49+0+0 -fa "DejaVu Sans Mono" -fs 12 -bg "#0f1115" -fg "#e6e6e6" -bw 0 -e "tmux -u -L rec attach -t host" > /dev/null 2>&1 &)
sleep 10; grep listening $R/server.log
