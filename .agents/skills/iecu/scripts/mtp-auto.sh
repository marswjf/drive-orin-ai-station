#!/bin/bash
# MTP 全自动上板 A/B（板上自宿版 v2）：等下载 → 换装 → 探针 → 基准（n-max 2 与 4）→ 恢复生产。
# 由 systemd-run --unit=mtp-auto 拉起，全程不依赖任何外部 SSH 会话。
# v2 修复：mtpbench.js 拆为独立文件（argv 索引 bug 已修），旧日志归档到 .prev。
# 结果与日志：/opt/m0/llm/mtp-test-results.log（判读：看 ALL_DONE / RESTORED 标记）
NODE=/var/lib/llm/bin/node
CFG=/var/lib/llm/config.json
BAK=/var/lib/llm/config.json.bak-pre-mtp
LOG=/opt/m0/llm/mtp-test-results.log
BENCH=/var/lib/llm/tmp/mtpbench.js
MODEL=/opt/m0/llm/Qwen3.6-35B-A3B-MTP-UD-IQ4_XS.gguf
[ -f "$LOG" ] && mv -f "$LOG" "$LOG.prev"
exec >> "$LOG" 2>&1
say(){ echo "[$(date '+%H:%M:%S')] $*"; }

wait_health(){ # $1=port $2=最长秒数
  $NODE -e '
const http=require("http");const port=process.argv[1],max=+process.argv[2];let n=0;
const t=setInterval(()=>{n+=3;
  http.get("http://127.0.0.1:"+port+"/health",r=>{if(r.statusCode===200){console.log("healthy :"+port+" ~"+n+"s");clearInterval(t);process.exit(0);}}).on("error",()=>{});
  if(n>max){console.log("HEALTH TIMEOUT :"+port);process.exit(1);}
},3000);' "$1" "$2"
}

restore(){
  say "== 恢复生产配置 =="
  cp -f "$BAK" "$CFG"
  systemctl restart llm-server
  wait_health 8080 420 || say "警告：恢复后 llm-server 健康检查超时，需人工查看"
  systemctl start llm-embedding
  wait_health 8081 150 || say "警告：embedding 健康检查超时"
  systemctl is-active llm-server llm-embedding iecu-panel | tr '\n' ' '; echo
  grep MemAvailable /proc/meminfo
  say "RESTORED"
}

say "===== MTP 自动测试开始（v2）====="

# ---- 阶段 0：确认模型文件（下载已完成则秒过） ----
for i in $(seq 1 240); do
  grep -q 'DONE' /opt/m0/llm/dl.log 2>/dev/null && break
  grep -q 'FATAL' /opt/m0/llm/dl.log 2>/dev/null && { say "下载 FATAL，终止"; tail -3 /opt/m0/llm/dl.log; exit 1; }
  sleep 10
done
grep -q 'DONE' /opt/m0/llm/dl.log || { say "等待 40 分钟仍未 DONE，终止"; exit 1; }
SZ=$(stat -c %s "$MODEL")
[ "$SZ" = "18209036576" ] || { say "尺寸不符 $SZ，终止"; exit 1; }
MAGIC=$(head -c 4 "$MODEL")
[ "$MAGIC" = "GGUF" ] || { say "魔数不是 GGUF，终止"; exit 1; }
say "模型文件校验通过（18,209,036,576 字节，GGUF）"

# ---- 冒烟：基准工具参数解析必须先过 ----
$NODE "$BENCH" smoke '[]' | grep -q BENCH_OK || { say "mtpbench.js 冒烟失败，终止（未动生产）"; exit 1; }
say "基准工具冒烟通过"

# ---- 阶段 1：换装 ----
systemctl stop llm-embedding
cp -f "$CFG" "$BAK"
$NODE -e '
const fs=require("fs");const p="/var/lib/llm/config.json";
const c=JSON.parse(fs.readFileSync(p,"utf8"));
c.model="/opt/m0/llm/Qwen3.6-35B-A3B-MTP-UD-IQ4_XS.gguf";
c.mmproj="";
c.extraArgs=["--spec-type","draft-mtp","--spec-draft-n-max","2",
  "--temp","1.0","--top-p","0.95","--top-k","20","--min-p","0","--presence-penalty","1.5"];
fs.writeFileSync(p,JSON.stringify(c,null,2));
console.log("已切换 MTP n-max=2");'
systemctl restart llm-server
wait_health 8080 420 || { say "MTP 配置起不来，回滚"; restore; exit 1; }
journalctl -u llm-server -n 200 --no-pager 2>/dev/null | grep -iE 'speculative|mtp|not supported|disabled' | tail -4
grep MemAvailable /proc/meminfo

# ---- 阶段 2：探针（3 连 4K 全新预填充盯内存泄漏；前缀各不相同） ----
say "== 稳定性探针 =="
$NODE "$BENCH" probe '[["4K-a",6410,[0]],["4K-b",6420,[0]],["4K-c",6430,[0]]]' \
  || { say "探针失败，回滚"; restore; exit 1; }

# ---- 阶段 3：n-max=2 全套 ----
say "== n-max=2：4K/32K × temp 1.0/0.7/0，外加 64K ×1.0 =="
$NODE "$BENCH" nmax2 '[["4K",6400,[1.0,0.7,0]],["32K",51500,[1.0,0.7,0]],["64K",100300,[1.0]]]' \
  || { say "n-max=2 基准失败，回滚"; restore; exit 1; }

# ---- 阶段 4：n-max=4（长上下文验证：更长草稿是否更赚） ----
say "== 切 n-max=4 重启 =="
$NODE -e '
const fs=require("fs");const p="/var/lib/llm/config.json";
const c=JSON.parse(fs.readFileSync(p,"utf8"));
c.extraArgs=["--spec-type","draft-mtp","--spec-draft-n-max","4",
  "--temp","1.0","--top-p","0.95","--top-k","20","--min-p","0","--presence-penalty","1.5"];
fs.writeFileSync(p,JSON.stringify(c,null,2));console.log("n-max=4");'
systemctl restart llm-server
if wait_health 8080 420; then
  $NODE "$BENCH" nmax4 '[["32K",51500,[1.0]],["64K",100300,[1.0]]]' || say "n-max=4 基准失败（继续恢复）"
else
  say "n-max=4 起不来（继续恢复）"
fi

# ---- 阶段 5：恢复生产 ----
restore
say "ALL_DONE"
