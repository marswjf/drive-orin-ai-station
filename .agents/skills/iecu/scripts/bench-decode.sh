#!/bin/bash
# decode 速度基准（MTP / ngram / 换模型 A/B 专用协议）。用 exec.js --file 跑在板上。
# 协议要点：低重复度自然语料（防投机解码在合成文本上虚高）+ chat 接口 + 关思考 + 256 tokens。
# ★ 2026-08-12 基线（IQ4_XS + ngram-mod + ub1024，双服务运行）：
#     4K:  temp1.0 = 28.8 t/s   temp0 = 27.7 t/s   （pp 748 t/s）
#     32K: temp1.0 = 21.1 t/s   temp0 = 20.8 t/s   （pp 703 t/s）
#   换配置后跑本脚本，直接与上面四个数对比。
NODE=/var/lib/llm/bin/node
cat > /tmp/benchdecode.js <<'EOF'
const http=require('http');
const HOST='127.0.0.1', PORT=8080;
function post(path, obj){ return new Promise((res,rej)=>{ const body=JSON.stringify(obj);
  const req=http.request({host:HOST,port:PORT,path,method:'POST',
    headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},r=>{
    let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res({code:r.statusCode,j:JSON.parse(d)});}catch(e){res({code:r.statusCode,raw:d.slice(0,200)});}});});
  req.on('error',rej); req.end(body); }); }
function getSpec(){ return new Promise((res,rej)=>{
  http.get({host:HOST,port:PORT,path:'/metrics'},r=>{let d='';r.on('data',c=>d+=c);
    r.on('end',()=>{const o={};d.split('\n').forEach(l=>{
      const m=l.match(/^llamacpp:(spec_decode_num_\w+_total)\s+(\S+)/);if(m)o[m[1]]=+m[2];});res(o);});
  }).on('error',rej);});}
const A=['雷达标定','底盘域','车身网关','激光雷达','温控策略','日志采集','冗余电源','转向系统','传感器融合','时间同步','整车诊断','高精地图','泊车规划','车道保持','数据回灌','影子模式','远程升级','安全岛','算力调度','链路聚合'];
const B=['在低温环境下表现出明显漂移','需要在量产前完成三轮验证','和上一版基线存在兼容缺口','的采样频率被固定在较低档位','在长隧道场景里丢失参考','对供电波动异常敏感','未按预期进入低功耗状态','的故障码没有形成闭环','在夜间雨雾中误检率上升','与域控之间存在握手超时'];
const C=['工程团队','测试场同事','供应商','标定工程师','系统架构组','驻场人员','质量部门','算法小组'];
const D=['随后提交了整改单','并把复现步骤写进了知识库','决定回退到上一个稳定版本','在周会上给出了风险评估','用三天时间完成了根因定位','把该项列入了下个迭代','临时用旁路方案顶住了交付','要求增加一组对照实验'];
function corpus(chars){ let s='',i=0;
  while(s.length<chars){
    s+='第'+(i+1)+'项：'+A[i%20]+B[(i*3+1)%10]+'，'+C[(i*7+2)%8]+D[(i*5+3)%8]+'。';
    i++; } return s; }
async function run(name, chars, temp){
  const m1=await getSpec();
  const r=await post('/v1/chat/completions',{model:'m',
    messages:[{role:'user',content:corpus(chars)+'\n\n基于上文写一段两百字的风险综述，不要复述原文。'}],
    max_tokens:256, temperature:temp,
    chat_template_kwargs:{enable_thinking:false}});
  const m2=await getSpec();
  const t=(r.j&&r.j.timings)||{};
  const draft=(m2.spec_decode_num_draft_tokens_total||0)-(m1.spec_decode_num_draft_tokens_total||0);
  const acc=(m2.spec_decode_num_accepted_tokens_total||0)-(m1.spec_decode_num_accepted_tokens_total||0);
  console.log(JSON.stringify({ctx:name,temp,code:r.code,prompt_n:t.prompt_n,
    pp_tps:+(t.prompt_per_second||0).toFixed(1),
    gen_n:t.predicted_n, tg_tps:+(t.predicted_per_second||0).toFixed(1),
    draft, accepted:acc, accept_rate:draft?+(acc/draft).toFixed(3):null}));
}
(async()=>{
  for(const [name,chars] of [['4K',6400],['32K',51500]])
    for(const temp of [1.0, 0.7, 0]) await run(name,chars,temp);
  console.log('BENCH_DONE');
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
EOF
$NODE /tmp/benchdecode.js
