#!/bin/sh
# 看 ComfyUI 的 input 目录有什么可用输入图，以及 output 里已出的图。
C=/var/lib/llm/comfyui313/ComfyUI
echo "=== input/ ==="
ls -l "$C/input/" 2>/dev/null | head -15 || echo "  目录不存在"
echo
echo "=== output/（刚才出的三张应该在）==="
ls -lt "$C/output/" 2>/dev/null | head -8 || echo "  目录不存在"
echo
echo "=== 上游超分模型是否被扫到（UpscaleModelLoader 的候选）==="
/var/lib/llm/bin/node - <<'JS'
const http=require('http');
http.get({host:'127.0.0.1',port:8188,path:'/object_info/UpscaleModelLoader',timeout:15000},r=>{
  let b='';r.on('data',d=>b+=d);r.on('end',()=>{
    try{
      const o=JSON.parse(b);
      const k=Object.keys(o)[0];
      console.log('  候选:', JSON.stringify(o[k].input.required.model_name[0]));
    }catch(e){console.log('  解析失败',e.message,b.slice(0,120));}
  });
}).on('error',e=>console.log('  请求失败',e.message));
JS
echo
echo "=== LoadImage 的候选（input 目录里的图）==="
/var/lib/llm/bin/node - <<'JS'
const http=require('http');
http.get({host:'127.0.0.1',port:8188,path:'/object_info/LoadImage',timeout:15000},r=>{
  let b='';r.on('data',d=>b+=d);r.on('end',()=>{
    try{
      const o=JSON.parse(b);
      const k=Object.keys(o)[0];
      const c=o[k].input.required.image[0];
      console.log('  候选数:', Array.isArray(c)?c.length:'非数组');
      if(Array.isArray(c)) console.log('  前 8 个:', c.slice(0,8).join(', '));
    }catch(e){console.log('  解析失败',e.message);}
  });
}).on('error',e=>console.log('  请求失败',e.message));
JS
echo
echo "=== 内存现状（ComfyUI 载着 Z-Image）==="
free -m | head -2
cat /sys/kernel/debug/nvmap/iovmm/clients 2>/dev/null | tail -4
