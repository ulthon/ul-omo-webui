#!/usr/bin/env bash
# task-2 CLI/webui 同会话并发 spike 编排器（脱离 eval cell 预算独立运行）
# 实验状态全部在 /tmp/conc-spike；原始证据实时镜像到工作树 task-2-raw/
ROOT=/tmp/conc-spike
WT=/data/projects/senpi-webui-wt/docs08-batch-w0-t2
EV=$WT/.omo/evidence/docs08-2026-10-23-24-batch/task-2-raw
PORT=7791
B=http://127.0.0.1:$PORT
AGENT_DIR=$ROOT/agent
PROJ=$ROOT/proj
PW=conc-spike-pw-2026
mkdir -p "$EV"

mirror(){ if [ -f "$1" ]; then cp "$1" "$EV/$2" 2>/dev/null; fi; }
log(){ echo "[$(date -Is)] $*" >> $ROOT/orchestrator.log 2>/dev/null; mirror $ROOT/orchestrator.log orchestrator.log; }

echo "[$(date -Is)] === orchestrator start ===" > $ROOT/orchestrator.log
mkdir -p $ROOT 2>/dev/null || { echo "FATAL: cannot create $ROOT" >> $WT/.omo/evidence/docs08-2026-10-23-24-batch/task-2-raw/orchestrator.log; exit 1; }

# ---------- PHASE 0: 环境重建 ----------
log "PHASE0_BEGIN"
if ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN; then log "FATAL: port $PORT occupied, abort"; exit 1; fi
rm -rf $ROOT
mkdir -p $ROOT/data $ROOT/config $AGENT_DIR $PROJ || { log "FATAL: mkdir failed"; exit 1; }
printf '# conc spike proj\n' > $PROJ/README.md
cp /root/.omo/agent/auth.json /root/.omo/agent/models.json /root/.omo/agent/models-store.json /root/.omo/agent/settings.json $AGENT_DIR/ || { log "FATAL: copy agent files failed"; exit 1; }
ls -la $AGENT_DIR >> $ROOT/orchestrator.log
log "PHASE0 env rebuilt"

# 看门狗：3s 一拍记录关键路径/端口/进程存活时间线（环境外力清删取证）
( while true; do
    ts=$(date -Is)
    d=$([ -d $ROOT/data ] && echo ok || echo GONE)
    a=$([ -f $AGENT_DIR/settings.json ] && echo ok || echo GONE)
    l=$([ -f $ROOT/server.log ] && echo ok || echo GONE)
    p=$(ss -ltn "sport = :$PORT" 2>/dev/null | grep -c LISTEN)
    if [ -f $ROOT/server.pid ]; then sp=$(ps -p $(cat $ROOT/server.pid) >/dev/null 2>&1 && echo alive || echo dead); else sp=nopid; fi
    echo "$ts data=$d settings=$a serverlog=$l listen=$p serverproc=$sp"
    sleep 3
  done ) > $ROOT/watchdog.log 2>&1 &
WATCHDOG=$!
echo $WATCHDOG > $ROOT/watchdog.pid
log "PHASE0 watchdog pid=$WATCHDOG"

# ---------- PHASE 1: server 启动 ----------
log "PHASE1_BEGIN"
cd $ROOT || exit 1
setsid env UL_OMO_WEBUI_PORT=$PORT \
  UL_OMO_WEBUI_DATA_DIR=$ROOT/data \
  UL_OMO_WEBUI_CONFIG_DIR=$ROOT/config \
  UL_OMO_WEBUI_AGENT_DIR=$AGENT_DIR \
  UL_OMO_WEBUI_PASSWORD=$PW \
  node /data/projects/senpi-webui/server/dist/index.js > $ROOT/server.log 2>&1 < /dev/null &
SERVER_PID=$!
echo $SERVER_PID > $ROOT/server.pid
log "PHASE1 server pid=$SERVER_PID"
ready=""
for i in $(seq 1 60); do
  code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' $B/api/projects 2>/dev/null)
  if [ "$code" = "401" ] || [ "$code" = "200" ]; then ready=1; break; fi
  sleep 2
done
if [ -z "$ready" ]; then log "FATAL: server not ready in 120s"; tail -20 $ROOT/server.log >> $ROOT/orchestrator.log 2>/dev/null; exit 1; fi
log "PHASE1 server ready"
tail -3 $ROOT/server.log >> $ROOT/orchestrator.log 2>/dev/null

# ---------- PHASE 2: 登录/注册/建会话 ----------
log "PHASE2_BEGIN"
curl -s -m 5 -c $ROOT/cookies.txt -X POST -H 'Content-Type: application/json' -d '{"password":"'"$PW"'"}' $B/api/auth/login > $ROOT/login.json 2>/dev/null
log "PHASE2 login: $(cat $ROOT/login.json 2>/dev/null)"
curl -s -m 10 -b $ROOT/cookies.txt -X POST -H 'Content-Type: application/json' -d '{"path":"'"$PROJ"'"}' $B/api/projects > $ROOT/register-project.json 2>/dev/null
log "PHASE2 register: $(head -c 200 $ROOT/register-project.json 2>/dev/null)"
curl -s -m 30 -b $ROOT/cookies.txt -X POST -H 'Content-Type: application/json' -d '{"project":"'"$PROJ"'"}' $B/api/sessions > $ROOT/create-session.json 2>/dev/null
WEBUI_SID=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).session.id)}catch(e){console.log("")}' $ROOT/create-session.json 2>/dev/null)
SESS_PATH=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).session.sessionPath||"")}catch(e){console.log("")}' $ROOT/create-session.json 2>/dev/null)
ENGINE_SID=$(basename "$SESS_PATH" 2>/dev/null | sed 's/^.*_//; s/\.jsonl$//')
echo -n "$WEBUI_SID" > $ROOT/webui-sid.txt; echo -n "$ENGINE_SID" > $ROOT/engine-sid.txt; echo -n "$SESS_PATH" > $ROOT/sess-path.txt
log "PHASE2 session webui=$WEBUI_SID engine=$ENGINE_SID path=$SESS_PATH"
[ -z "$WEBUI_SID" ] || [ -z "$ENGINE_SID" ] && { log "FATAL: session ids empty"; exit 1; }

# ---------- PHASE 3: webui 基线回合 ----------
log "PHASE3_BEGIN baseline turn"
curl -s -m 200 -b $ROOT/cookies.txt -X POST -H 'Content-Type: application/json' -d '{"text":"只回复四个字：基线收到"}' $B/api/sessions/$WEBUI_SID/prompt > $ROOT/baseline-prompt-receipt.json 2>/dev/null
log "PHASE3 prompt receipt: $(head -c 300 $ROOT/baseline-prompt-receipt.json 2>/dev/null)"
turn_done=""
for i in $(seq 1 45); do
  if [ -f "$SESS_PATH" ] && grep -q '"role":"assistant"' "$SESS_PATH" 2>/dev/null; then turn_done=1; break; fi
  sleep 4
done
log "PHASE3 turn completed=$turn_done waited_${i}x4s"
wc -l "$SESS_PATH" > $ROOT/baseline-wc.txt 2>/dev/null
md5sum "$SESS_PATH" > $ROOT/baseline-md5.txt 2>/dev/null
log "PHASE3 baseline: $(cat $ROOT/baseline-wc.txt 2>/dev/null) | $(cat $ROOT/baseline-md5.txt 2>/dev/null)"
curl -s -m 30 -b $ROOT/cookies.txt "$B/api/sessions/$WEBUI_SID/messages" > $ROOT/baseline-messages.json 2>/dev/null
curl -s -m 30 -b $ROOT/cookies.txt "$B/api/sessions?project=$PROJ" > $ROOT/baseline-list.json 2>/dev/null
LEAF=$(node -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.cursor||j.leafId||"")}catch(e){console.log("")}' $ROOT/baseline-messages.json 2>/dev/null)
echo -n "$LEAF" > $ROOT/baseline-leaf.txt
log "PHASE3 leaf=$LEAF entries=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).entries.length)}catch(e){console.log("ERR")}' $ROOT/baseline-messages.json 2>/dev/null)"

# 引擎进程发现（webui 拉起的引擎，env 含本实验 DATA_DIR 标记）
find_engine_pids(){
  for p in /proc/[0-9]*/environ; do
    if tr '\0' '\n' < "$p" 2>/dev/null | grep -q '^UL_OMO_WEBUI_DATA_DIR=/tmp/conc-spike/data$'; then
      echo "$(basename $(dirname $p))"
    fi
  done
}
find_engine_pids | tr '\n' ' ' > $ROOT/experiment-pids.txt
log "PHASE3 experiment pids: $(cat $ROOT/experiment-pids.txt 2>/dev/null)"

# ---------- PHASE 4: CLI 写同一会话（观察 a：可见性） ----------
log "PHASE4_BEGIN cli turn"
cd $PROJ || exit 1
export OMO_CODING_AGENT_DIR=$AGENT_DIR SENPI_CODING_AGENT_DIR=$AGENT_DIR
timeout 240 omo --offline -nt -p "只回复四个字：CLI写入" --session-id "$ENGINE_SID" > $ROOT/cli-turn1.log 2>&1
CEXIT=$?
log "PHASE4 cli exit=$CEXIT output_head: $(head -c 300 $ROOT/cli-turn1.log 2>/dev/null)"
md5sum "$SESS_PATH" > $ROOT/after-cli-md5.txt 2>/dev/null
wc -l "$SESS_PATH" > $ROOT/after-cli-wc.txt 2>/dev/null
log "PHASE4 after-cli: $(cat $ROOT/after-cli-wc.txt 2>/dev/null) | $(cat $ROOT/after-cli-md5.txt 2>/dev/null)"
curl -s -m 30 -b $ROOT/cookies.txt "$B/api/sessions/$WEBUI_SID/messages" > $ROOT/after-cli-messages-tailread.json 2>/dev/null
curl -s -m 60 -b $ROOT/cookies.txt "$B/api/sessions/$WEBUI_SID/messages?cursor=$LEAF" > $ROOT/after-cli-messages-cursor.json 2>/dev/null
curl -s -m 30 -b $ROOT/cookies.txt "$B/api/sessions?project=$PROJ" > $ROOT/after-cli-list.json 2>/dev/null
log "PHASE4 tailread entries=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).entries.length)}catch(e){console.log("ERR")}' $ROOT/after-cli-messages-tailread.json 2>/dev/null) cursor_entries=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).entries.length)}catch(e){console.log("ERR")}' $ROOT/after-cli-messages-cursor.json 2>/dev/null)"
grep -c "CLI写入" "$SESS_PATH" > $ROOT/after-cli-marker-count.txt 2>/dev/null
mirror "$SESS_PATH" session-after-cli.jsonl

# ---------- PHASE 5: 并发双写（观察 b：完整性） ----------
log "PHASE5_BEGIN concurrent double-write"
curl -s -m 280 -b $ROOT/cookies.txt -X POST -H 'Content-Type: application/json' -d '{"text":"用约150字介绍互斥锁，写完即止"}' $B/api/sessions/$WEBUI_SID/prompt > $ROOT/concurrent-webui-receipt.json 2>/dev/null &
WPID=$!
sleep 3
timeout 280 omo --offline -nt -p "用约150字介绍信号量，写完即止" --session-id "$ENGINE_SID" > $ROOT/cli-turn2.log 2>&1
CEXIT2=$?
wait $WPID
WEXIT=$?
log "PHASE5 webui_curl_exit=$WEXIT cli_exit=$CEXIT2 webui_receipt: $(head -c 300 $ROOT/concurrent-webui-receipt.json 2>/dev/null) cli_head: $(head -c 300 $ROOT/cli-turn2.log 2>/dev/null)"
curl -s -m 30 -b $ROOT/cookies.txt "$B/api/sessions?project=$PROJ" > $ROOT/after-concurrent-list.json 2>/dev/null
md5sum "$SESS_PATH" > $ROOT/after-concurrent-md5.txt 2>/dev/null
wc -l "$SESS_PATH" > $ROOT/after-concurrent-wc.txt 2>/dev/null
node "$SCRIPT_DIR/validate-jsonl.js" "$SESS_PATH" > $ROOT/concurrent-validate.txt 2>&1
echo "mutex_marker=$(grep -c '互斥锁' "$SESS_PATH" 2>/dev/null) semaphore_marker=$(grep -c '信号量' "$SESS_PATH" 2>/dev/null)" > $ROOT/concurrent-markers.txt
log "PHASE5 $(cat $ROOT/after-concurrent-wc.txt 2>/dev/null) | $(cat $ROOT/after-concurrent-md5.txt 2>/dev/null) | validate: $(cat $ROOT/concurrent-validate.txt 2>/dev/null) | $(cat $ROOT/concurrent-markers.txt 2>/dev/null)"
curl -s -m 30 -b $ROOT/cookies.txt "$B/api/sessions/$WEBUI_SID/messages" > $ROOT/after-concurrent-messages.json 2>/dev/null
mirror "$SESS_PATH" session-after-concurrent.jsonl

# ---------- PHASE 6: 服务重启后再观察（观察 a-with-restart） ----------
log "PHASE6_BEGIN restart"
kill $(cat $ROOT/server.pid) 2>/dev/null
for i in $(seq 1 20); do
  ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN || break
  sleep 1
done
log "PHASE6 server stopped (waited ${i}s)"
cd $ROOT || exit 1
setsid env UL_OMO_WEBUI_PORT=$PORT \
  UL_OMO_WEBUI_DATA_DIR=$ROOT/data \
  UL_OMO_WEBUI_CONFIG_DIR=$ROOT/config \
  UL_OMO_WEBUI_AGENT_DIR=$AGENT_DIR \
  UL_OMO_WEBUI_PASSWORD=$PW \
  node /data/projects/senpi-webui/server/dist/index.js >> $ROOT/server.log 2>&1 < /dev/null &
echo $! > $ROOT/server.pid
log "PHASE6 server restarted pid=$!"
ready2=""
for i in $(seq 1 60); do
  code=$(curl -s -m 2 -o /dev/null -w '%{http_code}' $B/api/projects 2>/dev/null)
  if [ "$code" = "401" ] || [ "$code" = "200" ]; then ready2=1; break; fi
  sleep 2
done
log "PHASE6 restart ready=$ready2"
curl -s -m 30 -b $ROOT/cookies.txt "$B/api/sessions/$WEBUI_SID/messages" > $ROOT/after-restart-messages.json 2>/dev/null
curl -s -m 30 -b $ROOT/cookies.txt "$B/api/sessions?project=$PROJ" > $ROOT/after-restart-list.json 2>/dev/null
log "PHASE6 after-restart entries=$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).entries.length)}catch(e){console.log("ERR")}' $ROOT/after-restart-messages.json 2>/dev/null)"
md5sum "$SESS_PATH" > $ROOT/final-md5.txt 2>/dev/null
wc -l "$SESS_PATH" > $ROOT/final-wc.txt 2>/dev/null
node "$SCRIPT_DIR/validate-jsonl.js" "$SESS_PATH" > $ROOT/final-validate.txt 2>&1
log "PHASE6 final $(cat $ROOT/final-wc.txt 2>/dev/null) | $(cat $ROOT/final-md5.txt 2>/dev/null) | validate: $(cat $ROOT/final-validate.txt 2>/dev/null)"
mirror "$SESS_PATH" session-final.jsonl

# ---------- PHASE 7: 清理（仅精确 pid） ----------
log "PHASE7_BEGIN cleanup"
find_engine_pids > $ROOT/cleanup-pids.txt
log "PHASE7 killing experiment pids: $(cat $ROOT/cleanup-pids.txt 2>/dev/null)"
for pid in $(cat $ROOT/cleanup-pids.txt 2>/dev/null); do
  [ "$pid" = "$$" ] && continue
  kill "$pid" 2>/dev/null
done
sleep 2
for pid in $(cat $ROOT/cleanup-pids.txt 2>/dev/null); do
  if ps -p "$pid" > /dev/null 2>&1; then
    log "PHASE7 pid $pid still alive, kill -9"
    kill -9 "$pid" 2>/dev/null
  fi
done
kill $(cat $ROOT/server.pid) 2>/dev/null
sleep 2
if ps -p $(cat $ROOT/server.pid) > /dev/null 2>&1; then kill -9 $(cat $ROOT/server.pid) 2>/dev/null; fi
ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN && log "PHASE7 WARN port still listening" || log "PHASE7 port freed"
ps -p $(cat $ROOT/watchdog.pid) > /dev/null 2>&1 && kill $(cat $ROOT/watchdog.pid) 2>/dev/null
git -C /data/projects/senpi-webui status --porcelain > $ROOT/main-status-final.txt 2>&1
log "PHASE7 main-checkout status: [$(cat $ROOT/main-status-final.txt)]"
log "ALL_DONE"
mirror $ROOT/watchdog.log watchdog.log
mirror $ROOT/orchestrator.log orchestrator.log
exit 0
