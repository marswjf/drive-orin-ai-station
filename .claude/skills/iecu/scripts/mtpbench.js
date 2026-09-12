// MTP 基准工具：chat 接口 + 关思考 + /metrics 投机计数器差分算接受率 + 内存水位
// 用法: node mtpbench.js <tag> '<plan JSON>'   plan = [[name, chars, [temps...]], ...]
// plan 传 '[]' 时只打印 BENCH_OK（冒烟测试参数解析）。
// 指标名已对板实测确认: llamacpp:spec_decode_num_draft_tokens_total / _accepted_tokens_total
const http=require('http');
function post(path, obj){ return new Promise((res,rej)=>{ const body=JSON.stringify(obj);
  const req=http.request({host:'127.0.0.1',port:8080,path,method:'POST',
    headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},r=>{
    let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res({code:r.statusCode,j:JSON.parse(d)});}catch(e){res({code:r.statusCode,raw:d.slice(0,200)});}});});
  req.on('error',rej); req.setTimeout(900000,()=>req.destroy(new Error('req timeout'))); req.end(body); }); }
function getSpec(){ return new Promise((res,rej)=>{
  http.get({host:'127.0.0.1',port:8080,path:'/metrics'},r=>{let d='';r.on('data',c=>d+=c);
    r.on('end',()=>{const o={};d.split('\n').forEach(l=>{
      const m=l.match(/^llamacpp:(spec_decode_num_\w+_total)\s+(\S+)/);if(m)o[m[1]]=+m[2];});res(o);});
  }).on('error',rej);});}
function memGB(){ const m=require('fs').readFileSync('/proc/meminfo','utf8');
  return +(m.match(/MemAvailable:\s+(\d+)/)[1]/1048576).toFixed(2); }
const A=['雷达标定','底盘域','车身网关','激光雷达','温控策略','日志采集','冗余电源','转向系统','传感器融合','时间同步','整车诊断','高精地图','泊车规划','车道保持','数据回灌','影子模式','远程升级','安全岛','算力调度','链路聚合'];
const B=['在低温环境下表现出明显漂移','需要在量产前完成三轮验证','和上一版基线存在兼容缺口','的采样频率被固定在较低档位','在长隧道场景里丢失参考','对供电波动异常敏感','未按预期进入低功耗状态','的故障码没有形成闭环','在夜间雨雾中误检率上升','与域控之间存在握手超时'];
const C=['工程团队','测试场同事','供应商','标定工程师','系统架构组','驻场人员','质量部门','算法小组'];
const D=['随后提交了整改单','并把复现步骤写进了知识库','决定回退到上一个稳定版本','在周会上给出了风险评估','用三天时间完成了根因定位','把该项列入了下个迭代','临时用旁路方案顶住了交付','要求增加一组对照实验'];
function corpus(chars){ let s='',i=0;
  while(s.length<chars){
    s+='第'+(i+1)+'项：'+A[i%20]+B[(i*3+1)%10]+'，'+C[(i*7+2)%8]+D[(i*5+3)%8]+'。';
    i++; } return s; }
async function run(tag, name, chars, temp){
  const m1=await getSpec();
  // 前缀含 tag/name/temp，保证每次请求首 token 就不同 → 预填充必为全量，可与基线直接对比
  const r=await post('/v1/chat/completions',{model:'m',
    messages:[{role:'user',content:'['+tag+'/'+name+'/t'+temp+'] '+corpus(chars)+'\n\n基于上文写一段两百字的风险综述，不要复述原文。'}],
    max_tokens:256, temperature:temp,
    chat_template_kwargs:{enable_thinking:false}});
  const m2=await getSpec();
  const t=(r.j&&r.j.timings)||{};
  const draft=(m2.spec_decode_num_draft_tokens_total||0)-(m1.spec_decode_num_draft_tokens_total||0);
  const acc=(m2.spec_decode_num_accepted_tokens_total||0)-(m1.spec_decode_num_accepted_tokens_total||0);
  console.log(JSON.stringify({cfg:tag,ctx:name,temp,code:r.code,prompt_n:t.prompt_n,
    pp_tps:+(t.prompt_per_second||0).toFixed(1),
    gen_n:t.predicted_n, tg_tps:+(t.predicted_per_second||0).toFixed(1),
    draft, accepted:acc, accept_rate:draft?+(acc/draft).toFixed(3):null, mem:memGB()}));
  if(r.code!==200){ throw new Error('bench http '+r.code); }
}
(async()=>{
  const tag=process.argv[2]||'mtp';           // 文件模式: argv[0]=node argv[1]=脚本 argv[2]=第一个参数
  const plan=JSON.parse(process.argv[3]);
  for(const [name,chars,temps] of plan)
    for(const temp of temps) await run(tag,name,chars,temp);
  console.log('BENCH_OK');
})().catch(e=>{console.error('BENCH_FAIL',e.message);process.exit(1);});
