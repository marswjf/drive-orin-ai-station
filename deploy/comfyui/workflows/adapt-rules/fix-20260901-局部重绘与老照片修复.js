const fs = require('fs');
const DIR = 'D:/Users/你的宿主机/Desktop/开发项目/IECU3.1/deploy/comfyui/workflows/板上适配版/';
const SRC = DIR + '局部重绘ControlNet-IECU.json';
const wf = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// ── 1. 输入图指向板上真实存在的文件 ─────────────────────────
// 原值是 clipspace/<hash>.png —— 那是原作者在他自己机器上用遮罩编辑器临时生成的，
// 板上 input/clipspace/ 目录根本不存在，打开工作流就是缺图状态。
const byId = Object.fromEntries(wf.nodes.map(n => [n.id, n]));
byId[134].widgets_values = ['inpaint-768x1024.png', 'image'];

// ── 2. 删两个孤立的参考图节点 ───────────────────────────────
// 145/146 没有任何输出连线，引用的 pasted/<hash>.png 同样不在板上。
const DROP = new Set([145, 146]);
wf.nodes = wf.nodes.filter(n => !DROP.has(n.id));
wf.groups = wf.groups.filter(g => g.id !== 8);   // 组 8 里只有这两个节点

// ── 3. 旁路的加速 LoRA 换成板上真实存在的那个 ───────────────
// 原值 daming3dstyle_000002000.safetensors 是作者的风格 LoRA，板上没有。
// 换成官方蒸馏加速 LoRA（已下到 /opt/m/sd-models/loras/），**仍保持旁路**：
// 它是 4 步版，启用时要把 KSampler 步数一起改成 4，不是打开就能用的。
byId[119].widgets_values = ['Z-Image-Fun-Lora-Distill-4-Steps-2602-ComfyUI.safetensors', 1.0];

// ── 4. 组标题与说明卡 ───────────────────────────────────────
for (const g of wf.groups) {
  if (g.id === 7) g.title = '输入区';
}
const NOTE = [
  '## 局部重绘（IECU 3.1 板上可跑版）',
  '',
  '**做什么**：把图片里圈出来的一块按提示词重画，其余部分原样保留。',
  '',
  '### 怎么用',
  '',
  '1. 在「输入区」的图片节点上传自己的图',
  '2. **在图片上右键 → 打开遮罩编辑器 → 涂抹要重画的区域 → 保存**',
  '3. 在提示词框里写这块区域要画成什么',
  '4. 点运行',
  '',
  '预置的示例图 `inpaint-768x1024.png` 中间已经带了一块遮罩，可以直接跑一次看效果。',
  '',
  '### 原理',
  '',
  '遮罩交给 ZImageFunControlnet 做局部约束，再由 DifferentialDiffusion 让边界过渡自然，',
  '所以采样降噪值是 1.0 也不会把整张图重画——**这个 1.0 不要改小**，改小反而会让重绘区糊。',
  '',
  '### 关键参数',
  '',
  '- **步数 8 / CFG 1.0**：Z-Image Turbo 的标准档，不要按普通模型的习惯调大',
  '- **输出尺寸**：跟随输入图，由图片尺寸节点自动读取，不用手填',
  '- **ControlNet**：Z-Image-Turbo-Fun-Controlnet-Union-2.1 的 lite 档（1.9 GB）',
  '',
  '### 加速 LoRA（默认关闭）',
  '',
  '模型加载器下面挂着一个官方 4 步蒸馏 LoRA，默认是旁路状态。',
  '要启用就取消旁路，**同时把采样步数从 8 改成 4**——只开 LoRA 不改步数没有意义。',
].join('\n');
wf.nodes.push({
  id: 147, type: 'MarkdownNote', mode: 0, order: 0,
  pos: [1200, -110], size: [430, 600], flags: {}, color: '#432', bgcolor: '#653',
  widgets_values: [NOTE], properties: {},
});
wf.last_node_id = 147;

// ── 5. 适配记录 ─────────────────────────────────────────────
wf._iecu_adapt = wf._iecu_adapt || {};
wf._iecu_adapt.note = [
  '局部重绘：遮罩 → ZImageFunControlnet 局部约束 → DifferentialDiffusion 边界过渡 → KSampler。',
  '',
  '2026-09-01 补齐：此前缺 ControlNet 权重，工作流打不开也跑不了。',
  '本轮下载了 Z-Image-Turbo-Fun-Controlnet-Union-2.1-lite-2602-8steps.safetensors（1.88 GB，',
  '来源 ModelScope PAI/Z-Image-Turbo-Fun-Controlnet-Union-2.1），放在 /opt/m/sd-models/model_patches/。',
  '',
  '★ 放 /opt/m 不放 /opt/m0：这块板的 /opt/m0 是 vblkdev56，与 /opt/other 同设备，',
  '而 /opt/other/overlay/upper 是 /var 的可写层宿主，往那儿放模型等于吃掉 /var；',
  'extra_model_paths.yaml 里也物理上不登记这个根，放进去 ComfyUI 扫不到。',
  '',
  '⚠ A-138「ControlNet 双分支跑不动」那条结论是 py3.10 / torch 2.4.1 旧栈下的，已被 A-156 推翻：',
  '现役栈（torch 2.11 + Flash Attention）上 512² 实测 21.3 秒出图。',
].join('\n');
wf._iecu_adapt.changes = (wf._iecu_adapt.changes || []).concat([
  '节点 134 LoadImage 输入图 clipspace/<hash>.png → inpaint-768x1024.png\n      理由: 原值是作者在自己机器上用遮罩编辑器生成的临时文件，板上 input/clipspace/ 目录不存在，打开即缺图。换成随工作流一起备好的示例图（768×1024，中间带一块 304×320 的遮罩，可直接跑一次看效果）。',
  '删除 [145 LoadImage] [146 LoadImage] 与组 8\n      理由: 两个节点没有任何输出连线，引用的 pasted/<hash>.png 也不在板上；组 8 里只有它们俩。',
  '节点 119 LoraLoaderModelOnly 模型 daming3dstyle_000002000.safetensors → Z-Image-Fun-Lora-Distill-4-Steps-2602-ComfyUI.safetensors\n      理由: 原值是作者的风格 LoRA，板上没有，留着就是一行找不到的文件名。换成官方 4 步蒸馏加速 LoRA（542 MB，本轮已下到板上），**保持旁路状态**——它要配 4 步采样，不是打开就能用。',
  '组 7 标题「输入提示词 右键遮罩编辑器中涂抹要重绘的区域」→「输入区」\n      理由: 组标题写成两句操作说明，屏幕上一行放不下也读不清；操作步骤移到新增的说明卡里，写全了。',
  '新增 [147 MarkdownNote] 说明卡\n      理由: 局部重绘要先涂遮罩才有意义，不写清楚用户会直接点运行然后拿到一张整体重画的图。',
]);

fs.writeFileSync(SRC, JSON.stringify(wf, null, 2), 'utf8');
console.log('局部重绘: 节点 ' + wf.nodes.length + '，连线 ' + wf.links.length);

// ── 老照片修复：输入图指向板上真实存在的文件 ────────────────
const SRC2 = 'D:/Users/你的宿主机/Desktop/开发项目/IECU3.1/deploy/comfyui/workflows/老照片修复.json';
const wf2 = JSON.parse(fs.readFileSync(SRC2, 'utf8'));
const n1 = wf2.nodes.find(n => n.id === 1);
n1.widgets_values = ['old-photo-832x464.png', 'image'];
wf2._iecu_adapt = wf2._iecu_adapt || {};
wf2._iecu_adapt.changes = (wf2._iecu_adapt.changes || []).concat([
  '节点 1 LoadImage 输入图 example.png → old-photo-832x464.png\n      理由: example.png 是 ComfyUI 自带示例，本板的 input/ 目录里并没有这个文件，打开工作流即缺图。换成随工作流备好的样张（832×464，比例 1.793，带划痕/噪点/泛黄）。**特意用非正方形**：方图会让所有比例 bug 隐身，而这张工作流历史上正是栽在比例上（ImageScale 写死 1024×1024 把 16:9 压成方图）。',
]);
fs.writeFileSync(SRC2, JSON.stringify(wf2, null, 2), 'utf8');
console.log('老照片修复: 输入图已指向 old-photo-832x464.png');
