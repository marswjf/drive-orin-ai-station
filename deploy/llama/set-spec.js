// 只替换 config.json 里 extraArgs 的投机解码相关参数，其余字段一律不动。
// 用法: node set-spec.js <specType> <draftModelPath|-> <nMax|-> [ngld|-] [pMin|-]
//   node set-spec.js draft-mtp - 2 - 0.6                        ← MTP + 置信度门控
//   node set-spec.js draft-dspark /opt/m/llm/x.gguf 4 99 -      ← 外挂草稿模型
//   node set-spec.js draft-mtp - 2                              ← 还原到基线
//   node set-spec.js none - -                                   ← 关掉投机
//
// 为什么要有这个脚本：直接手改 config.json 容易漏字段（PRESET_KEEP 那类问题），
// 而 llama.cpp 的重复参数取第一个不取最后一个（陷阱 63），追加覆盖的写法不成立，
// 所以必须先把旧的投机参数连值一起剔掉再写新的。
const fs = require('fs');
const P = process.env.IECU_CONFIG || '/var/lib/llm/config.json';
const BAK = P + '.bak-before-spec-sweep';

const [, , specType, draftPath, nMax, ngld, pMin] = process.argv;
if (!specType) { console.error('用法: set-spec.js <specType> <draftPath|-> <nMax|-> [ngld|-] [pMin|-]'); process.exit(1); }

const c = JSON.parse(fs.readFileSync(P, 'utf8'));
const before = JSON.stringify(c);
if (!fs.existsSync(BAK)) { fs.writeFileSync(BAK, before); console.log('已备份 -> ' + BAK); }

// 剔除全部投机相关项（连同它们的值）
const TAKES_VALUE = new Set(['--spec-type', '--spec-draft-n-max', '--spec-draft-n-min',
  '--spec-draft-model', '-md', '--model-draft', '--spec-draft-ngl', '-ngld',
  '--n-gpu-layers-draft', '--gpu-layers-draft', '--spec-draft-type-k', '-ctkd',
  '--spec-draft-type-v', '-ctvd', '--spec-draft-p-min', '--draft-p-min']);
const old = c.extraArgs || [];
const rest = [];
for (let i = 0; i < old.length; i++) {
  if (TAKES_VALUE.has(old[i])) { i++; continue; }
  rest.push(old[i]);
}

const has = v => v && v !== '-';
const spec = ['--spec-type', specType];
if (specType !== 'none') {
  if (has(draftPath)) {
    if (!fs.existsSync(draftPath)) { console.error('★ 草稿模型不存在: ' + draftPath); process.exit(1); }
    spec.push('--spec-draft-model', draftPath, '--spec-draft-ngl', String(has(ngld) ? ngld : 99));
  }
  if (has(nMax)) spec.push('--spec-draft-n-max', String(nMax));
  if (has(pMin)) spec.push('--spec-draft-p-min', String(pMin));
}
c.extraArgs = spec.concat(rest);
fs.writeFileSync(P, JSON.stringify(c, null, 2));

// 回读校验（陷阱 62：改完必须回读，"没报错"不是"做对了"的证据）
const back = JSON.parse(fs.readFileSync(P, 'utf8'));
if (JSON.stringify(back.extraArgs) !== JSON.stringify(c.extraArgs)) { console.error('★ 回读不一致'); process.exit(1); }
if (Object.keys(back).length !== Object.keys(JSON.parse(before)).length) { console.error('★ 字段数变了'); process.exit(1); }
console.log('新 extraArgs: ' + JSON.stringify(back.extraArgs));
console.log('SET_OK');
