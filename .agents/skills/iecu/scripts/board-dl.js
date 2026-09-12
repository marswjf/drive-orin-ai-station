// 板上下载器（已部署到板上 /var/lib/llm/tmp/dl.js，本文件是同步副本）。
// ★ 2026-08-14 起板子已全局出网（A-130），**root 直接跑就行**，不再需要 iecufrp 身份：
//   /var/lib/llm/bin/node /var/lib/llm/tmp/dl.js <URL> <目标文件> [日志文件]
// 大文件挂后台（断 SSH 不受影响）：
//   systemd-run --unit=iecu-dl-xxx --collect \
//     /var/lib/llm/bin/node /var/lib/llm/tmp/dl.js <URL> /opt/update/sd-models/xx.safetensors /tmp/dl.log
// ~~必须以 iecufrp（uid 998）身份跑~~ 已作废——那是全局出网之前的唯一通道。
// 仍然可用 --property=User=iecufrp，但目标目录得是它可写的，反而多一层麻烦。
// 进度看日志文件（每 5 秒一行 PROGRESS）；支持断点续传（重跑同命令自动 Range 续传）；
// 结束时校验 Content-Length，尺寸不符会报 FATAL——判断"下完了"以 DONE 行为准，别看进程存活。
// 出网前提（2026-08-12 实测）：ModelScope 与 hf-mirror.com 都通；目标目录须 iecufrp 可写
//   （/opt/m0/llm 已 chown iecufrp）。
const https = require('https'); const http = require('http');
const fs = require('fs'); const { URL } = require('url');
const [,, rawUrl, dest, logFile] = process.argv;
function log(s){ const line = new Date().toISOString()+' '+s+'\n';
  if(logFile) fs.appendFileSync(logFile, line); else process.stdout.write(line); }
function get(u, headers, redirects, cb){
  if(redirects > 8) return cb(new Error('too many redirects'));
  const o = new URL(u); const mod = o.protocol==='http:'?http:https;
  const req = mod.get({host:o.hostname, port:o.port||undefined, path:o.pathname+o.search,
    headers: Object.assign({'user-agent':'iecu-dl/1.0'}, headers)}, res=>{
    if([301,302,303,307,308].includes(res.statusCode)){
      res.resume(); return get(new URL(res.headers.location, u).href, headers, redirects+1, cb);
    }
    cb(null, res);
  });
  req.on('error', cb); req.setTimeout(60000, ()=>req.destroy(new Error('timeout')));
}
let start = 0;
try{ start = fs.statSync(dest).size; }catch(e){}
const hdr = start>0 ? {Range:'bytes='+start+'-'} : {};
log('START url='+rawUrl+' dest='+dest+' resumeFrom='+start);
get(rawUrl, hdr, 0, (err,res)=>{
  if(err){ log('FATAL '+err.message); process.exit(1); }
  if(start>0 && res.statusCode!==206){ log('FATAL server ignored Range (code '+res.statusCode+'), 不覆盖已有文件'); process.exit(1); }
  if(start===0 && res.statusCode!==200){ log('FATAL http '+res.statusCode); process.exit(1); }
  const total = start + (parseInt(res.headers['content-length']||'0',10)||0);
  log('HTTP '+res.statusCode+' total='+total);
  const ws = fs.createWriteStream(dest, start>0?{flags:'a'}:{});
  let got = start, last = Date.now();
  res.on('data', d=>{ got += d.length;
    if(Date.now()-last > 5000){ last = Date.now();
      log('PROGRESS '+got+'/'+total+' ('+(total?(got*100/total).toFixed(1):'?')+'%)'); } });
  res.pipe(ws);
  ws.on('finish', ()=>{
    const sz = fs.statSync(dest).size;
    if(total && sz !== total){ log('FATAL size mismatch '+sz+' != '+total); process.exit(1); }
    log('DONE size='+sz); process.exit(0);
  });
  res.on('error', e=>{ log('FATAL stream '+e.message); process.exit(1); });
});
