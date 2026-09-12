// IECU 3.1 温度/负载持续监控 — 本机采样，不在板子上安装任何东西
// 用法: node thermal-monitor.js <out.csv> [间隔秒]
// 断线自动重连；输出 CSV（time + 11 温区 + LOAD/CPUFREQ/GPU/MEMAVAIL/EMC）。
// 跑推理负载时务必挂着——空载曲线只是基线，加载后的稳态温度才是关键。
const fs = require('fs');
const { Client } = require('ssh2');

const HOST = process.env.IECU_HOST || '172.31.254.38';
const PORT = parseInt(process.env.IECU_PORT, 10) || 22;
const USER = process.env.IECU_USER || 'root';
const PASS = process.env.IECU_PASS || 'nvidia';
const outCsv = process.argv[2];
const interval = (parseInt(process.argv[3], 10) || 5) * 1000;

// 一条命令取回所有关注量，减少往返
const SAMPLE = [
  'for z in /sys/class/thermal/thermal_zone*; do printf "%s=%s;" "$(cat $z/type)" "$(cat $z/temp)"; done',
  'printf "LOAD=%s;" "$(cut -d\' \' -f1-3 /proc/loadavg | tr \' \' \',\')"',
  'printf "CPUFREQ=%s;" "$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq)"',
  'printf "GPUFREQ=%s;" "$(cat /sys/class/devfreq/17000000.ga10b/cur_freq 2>/dev/null || echo 0)"',
  'printf "GPULOAD=%s;" "$(cat /sys/class/devfreq/17000000.ga10b/device/load 2>/dev/null || cat /sys/devices/platform/17000000.ga10b/load 2>/dev/null || echo 0)"',
  'printf "MEMAVAIL=%s;" "$(grep MemAvailable /proc/meminfo | tr -dc 0-9)"',
  'printf "EMC=%s;" "$(cat /sys/kernel/debug/bpmp/debug/clk/emc/rate 2>/dev/null || echo 0)"',
  'echo',
].join('; ');

let header = null;
if (!fs.existsSync(outCsv)) fs.writeFileSync(outCsv, '', 'utf8');

function parse(line) {
  const o = {};
  line.trim().split(';').forEach(kv => {
    const i = kv.indexOf('=');
    if (i > 0) o[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  });
  return o;
}

let conn = null, timer = null, consecutiveFail = 0;

function connect() {
  conn = new Client();
  conn.on('ready', () => {
    console.log('[monitor] connected');
    consecutiveFail = 0;
    tick();
    timer = setInterval(tick, interval);
  });
  conn.on('error', (e) => {
    console.log('[monitor] error: ' + e.message);
    cleanup();
    setTimeout(connect, 5000);
  });
  conn.connect({ host: HOST, port: PORT, username: USER, password: PASS, readyTimeout: 15000, keepaliveInterval: 5000 });
}
function cleanup() {
  if (timer) { clearInterval(timer); timer = null; }
  if (conn) { try { conn.end(); } catch (e) {} conn = null; }
}
function tick() {
  if (!conn) return;
  conn.exec(SAMPLE, (err, stream) => {
    if (err) { consecutiveFail++; if (consecutiveFail > 3) { cleanup(); setTimeout(connect, 5000); } return; }
    let out = '';
    stream.on('data', d => { out += d.toString(); });
    stream.on('close', () => {
      const o = parse(out);
      if (!Object.keys(o).length) return;
      const keys = Object.keys(o);
      if (!header) {
        header = ['time', ...keys];
        if (fs.readFileSync(outCsv, 'utf8').length === 0) fs.appendFileSync(outCsv, header.join(',') + '\n');
      }
      const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
      const row = [ts, ...header.slice(1).map(k => o[k] ?? '')];
      fs.appendFileSync(outCsv, row.join(',') + '\n');
      const t = (n) => o[n] ? (parseInt(o[n], 10) / 1000).toFixed(1) : '--';
      console.log(`${ts}  CPU=${t('CPU-therm')}C GPU=${t('GPU-therm')}C tj=${t('tj-therm')}C SOC0=${t('SOC0-therm')}C CV0=${t('CV0-therm')}C EXT=${t('EXT0-thermal-remote')}C  load=${o.LOAD}  cpu0=${Math.round((o.CPUFREQ||0)/1000)}MHz gpu=${Math.round((o.GPUFREQ||0)/1e6)}MHz memAvail=${Math.round((o.MEMAVAIL||0)/1024)}MB`);
    });
  });
}
connect();
process.on('SIGINT', () => { cleanup(); process.exit(0); });
