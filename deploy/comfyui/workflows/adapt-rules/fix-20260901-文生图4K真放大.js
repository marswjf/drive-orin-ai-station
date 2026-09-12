const fs = require('fs');
const SRC = 'D:/Users/你的宿主机/Desktop/开发项目/IECU3.1/deploy/comfyui/workflows/板上适配版/文生图4K极速版-IECU.json';
const DST = SRC;
const wf = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// ── 1. 删节点 ───────────────────────────────────────────────
// 36/37/39 SeedVR2 三件套：DiT 是 7B fp16（14 GB），本板 14 GB 权重预算装不下
// 42 Qwen3_VQA_Plus：板上无此节点类型，且要 Qwen3-VL-8B，图生图自动反推提示词这条路走不通
// 46 LoadImage：42 的配套输入，随之删除
// 91 Any Switch：两路输入去掉一路后只剩单源，直连即可
// 99 Fast Groups Bypasser「选择生图模式」：图生图组已删，模式切换失去对象
// 103 easy int + 104 Label：板上无 easy int 类型，且只服务于 SeedVR2 的 resolution 参数
const DROP_NODES = new Set([36, 37, 39, 42, 46, 91, 99, 103, 104]);
wf.nodes = wf.nodes.filter(n => !DROP_NODES.has(n.id));

// ── 2. 删相关连线 ───────────────────────────────────────────
const DROP_LINKS = new Set([36, 37, 39, 56, 130, 132, 135, 136, 137, 138]);
wf.links = wf.links.filter(l => !DROP_LINKS.has(l[0]));

// 清理残留在保留节点上的 link 引用
const liveLinks = new Set(wf.links.map(l => l[0]));
for (const n of wf.nodes) {
  for (const i of (n.inputs || [])) if (i.link != null && !liveLinks.has(i.link)) i.link = null;
  for (const o of (n.outputs || [])) if (Array.isArray(o.links)) o.links = o.links.filter(x => liveLinks.has(x));
}

// ── 3. 新增 4K 放大链路 ─────────────────────────────────────
// 「功能：高清放大(4K)」组的 bounding: x 1051.63~1769.91, y 1097.42~1668.87
// 新节点必须落在这个范围内，Fast Groups Bypasser(matchColors=green) 才能整组开关
const P = { pinned: true };
wf.nodes.push({
  id: 105, type: 'UpscaleModelLoader', mode: 0, order: 21,
  pos: [1085, 1175], size: [330, 58], flags: P,
  widgets_values: ['4x-UltraSharp.pth'],
  inputs: [{ widget: { name: 'model_name' }, name: 'model_name', label: 'model_name', type: 'COMBO', localized_name: '模型名称' }],
  outputs: [{ name: 'UPSCALE_MODEL', links: [141], label: '放大模型', type: 'UPSCALE_MODEL', localized_name: 'UPSCALE_MODEL' }],
  properties: { widget_ue_connectable: {}, 'Node name for S&R': 'UpscaleModelLoader' },
});
wf.nodes.push({
  id: 106, type: 'ImageUpscaleWithModel', mode: 0, order: 22,
  pos: [1085, 1290], size: [330, 50], flags: P,
  widgets_values: [],
  inputs: [
    { name: 'upscale_model', link: 141, label: '放大模型', type: 'UPSCALE_MODEL', localized_name: '放大模型' },
    { name: 'image', link: 140, label: '图像', type: 'IMAGE', localized_name: '图像' },
  ],
  outputs: [{ name: 'IMAGE', links: [142], label: '图像', type: 'IMAGE', localized_name: '图像' }],
  properties: { widget_ue_connectable: {}, 'Node name for S&R': 'ImageUpscaleWithModel' },
});
wf.nodes.push({
  id: 107, type: 'ImageScaleToTotalPixels', mode: 0, order: 23,
  pos: [1085, 1395], size: [330, 130], flags: P,
  // lanczos / 8.3 MP / 步进 8：8.3 MP 对 9:16 就是 2162×3840，长边正好 4K，
  // 且按总像素归一而不是写死宽高，换比例也不会把画面压变形
  widgets_values: ['lanczos', 8.3, 8],
  inputs: [
    { name: 'image', link: 142, label: '图像', type: 'IMAGE', localized_name: '图像' },
    { widget: { name: 'upscale_method' }, name: 'upscale_method', label: 'upscale_method', type: 'COMBO', localized_name: '放大方法' },
    { widget: { name: 'megapixels' }, name: 'megapixels', label: 'megapixels', type: 'FLOAT', localized_name: '百万像素' },
    { widget: { name: 'resolution_steps' }, shape: 7, name: 'resolution_steps', label: 'resolution_steps', type: 'INT', localized_name: '分辨率步进' },
  ],
  outputs: [{ name: 'IMAGE', links: [143, 144], label: '图像', type: 'IMAGE', localized_name: '图像' }],
  properties: { widget_ue_connectable: {}, 'Node name for S&R': 'ImageScaleToTotalPixels' },
});

// 说明卡（前端节点，不参与执行）
const NOTE = [
  '## 文生图 4K 极速版（IECU 3.1 板上可跑版）',
  '',
  '**流程**：提示词 → Z-Image Turbo 出图 → 4 倍超分 → 归一到 4K → 存图',
  '',
  '### 怎么用',
  '',
  '1. 在左侧「提示词」里写要画的内容',
  '2. 「生图尺寸」默认 928×1648（竖版 9:16）',
  '3. 点运行',
  '',
  '### 关键参数',
  '',
  '- **步数 10 / CFG 1.0**：Z-Image Turbo 是蒸馏模型，这两个值不要按普通模型的习惯调大',
  '- **出图尺寸**：928×1648 是本板已验证的档位。调大之前先确认内存余量——没有独立显存，注意力开销随像素数平方增长',
  '- **超分模型**：4x-UltraSharp，锐利，适合人像与写实。板上另有 RealESRGAN_x4plus，风格更柔和',
  '- **最终像素 8.3 MP**：对 9:16 就是 2162×3840，长边 4K。按总像素归一，换比例不会变形',
  '',
  '### 关掉高清放大',
  '',
  '用左侧「高清放大」开关把该组整体旁路，直接输出 928×1648 原图，快很多。',
  '',
  '### 与原版的差别',
  '',
  '原版的 4K 放大用 SeedVR2，其 DiT 是 7B fp16（14 GB），本板装不下，作者留的是旁路状态——等于没有 4K。这里换成板上已有的超分模型，放大会真的执行。',
].join('\n');
wf.nodes.push({
  id: 108, type: 'MarkdownNote', mode: 0, order: 0,
  pos: [2255, 1097], size: [430, 572], flags: {}, color: '#432', bgcolor: '#653',
  widgets_values: [NOTE],
  properties: {},
});

// ── 4. 新增连线 ─────────────────────────────────────────────
wf.links.push([139, 17, 0, 5, 1, 'STRING']);          // CR Prompt Text → CLIPTextEncode.text（原经 Any Switch）
wf.links.push([140, 8, 0, 106, 1, 'IMAGE']);          // VAEDecode → ImageUpscaleWithModel.image
wf.links.push([141, 105, 0, 106, 0, 'UPSCALE_MODEL']);
wf.links.push([142, 106, 0, 107, 0, 'IMAGE']);
wf.links.push([143, 107, 0, 41, 0, 'IMAGE']);         // → SaveImage
wf.links.push([144, 107, 0, 98, 0, 'IMAGE']);         // → PreviewImage

// 把新连线登记到端点节点上
const byId = Object.fromEntries(wf.nodes.map(n => [n.id, n]));
byId[17].outputs[0].links = [139];
byId[5].inputs.find(i => i.name === 'text').link = 139;
byId[8].outputs[0].links = [140];
byId[41].inputs.find(i => i.name === 'images').link = 143;
byId[98].inputs.find(i => i.name === 'images').link = 144;

// ── 5. 组与标签 ─────────────────────────────────────────────
wf.groups = wf.groups.filter(g => g.title !== '模式：图生图（请上传参考图）');
for (const g of wf.groups) {
  if (g.title === '模式：文生图（请输入提示词）') g.title = '提示词';
}
// 「是否开启扩图？」控制的其实是高清放大组；扩图(outpainting)是另一回事，标题写岔了
byId[100].title = '高清放大';

// SaveImage 文件名前缀：ComfyUI 是默认值，换成能认出来源的
byId[41].widgets_values = ['t2i-4k'];

// ── 6. 收尾 ─────────────────────────────────────────────────
wf.last_node_id = 108;
wf.last_link_id = 144;
wf._iecu_adapt = wf._iecu_adapt || {};
wf._iecu_adapt.note = [
  '这张工作流的活跃链路是标准文生图：UNet + CLIP + VAE + KSampler + EmptyLatent，接 4 倍超分。',
  '',
  '2026-09-01 第二轮改造把「4K」做成真的：原版的放大链路挂在 SeedVR2 上（DiT 是 7B fp16，14 GB，本板装不下），',
  '作者留的是旁路状态，等于工作流名字里的 4K 从来没执行过。现改用板上已有的 4x-UltraSharp 超分模型，',
  '再按总像素归一到 8.3 MP（9:16 即 2162×3840）。',
  '',
  '同轮删掉了两个板上没有注册的节点类型：Qwen3_VQA_Plus（图生图自动反推提示词，需要 Qwen3-VL-8B）与 easy int。',
  '它们原本是旁路状态，wf-doctor 因此不报——但前端打开仍会飘红，因为前端查的是类型注册与否，与 mode 无关。',
  '',
  '保留的 rgthree 成员 Label 与 Fast Groups Bypasser 是纯前端节点（web/comfyui 下有 js、Python 侧不注册），',
  '不在数据流上，转 API 时自动跳过，不影响出图。',
].join('\n');
wf._iecu_adapt.changes = (wf._iecu_adapt.changes || []).concat([
  '删除 [36 SeedVR2LoadDiTModel] [37 SeedVR2LoadVAEModel] [39 SeedVR2VideoUpscaler]\n      理由: DiT 是 seedvr2_ema_7b_fp16（7B fp16 约 14 GB），单模型就吃满本板 14 GB 权重预算，与 Z-Image 无法共存。三个节点原为旁路状态，工作流名字里的「4K」实际从未执行。',
  '新增 [105 UpscaleModelLoader] [106 ImageUpscaleWithModel] [107 ImageScaleToTotalPixels]\n      理由: 用板上已有的 4x-UltraSharp.pth 做 4 倍超分，接一个按总像素归一的缩放（8.3 MP，9:16 即 2162×3840，长边 4K）。归一用 ImageScaleToTotalPixels 而不是写死宽高的 ImageScale——后者 crop=disabled 时会强制拉伸，换个比例就把画面压变形。三个节点落在「功能：高清放大(4K)」组的 bounding 内，仍受「高清放大」开关整组旁路。',
  '删除 [42 Qwen3_VQA_Plus] [46 LoadImage] [103 easy int] [104 Label]\n      理由: Qwen3_VQA_Plus 与 easy int 两个类型板上都没有注册，虽然原本是旁路状态、wf-doctor 不报，但前端打开会飘红——前端只查类型注册与否，不看 mode。Qwen3_VQA_Plus 还需要 Qwen3-VL-8B，图生图自动反推提示词这条路在本板走不通。',
  '删除 [91 Any Switch] [99 Fast Groups Bypasser「选择生图模式」]\n      理由: 图生图分支删除后 Any Switch 只剩单一输入源，CR Prompt Text 直连 CLIPTextEncode 即可；模式切换开关失去可切换的对象。',
  '节点 100 标题「是否开启扩图？」→「高清放大」\n      理由: 它 matchColors=green，控制的是「功能：高清放大(4K)」这一组；而「扩图」在中文里指 outpainting（扩展画布），是另一回事，原标题会误导。',
  '节点 41 SaveImage 文件名前缀 "ComfyUI" → "t2i-4k"\n      理由: 默认前缀在输出目录里分不出来源。',
]);

fs.writeFileSync(DST, JSON.stringify(wf, null, 2), 'utf8');
console.log('已写出: ' + DST);
console.log('节点 ' + wf.nodes.length + ' 个，连线 ' + wf.links.length + ' 条');
