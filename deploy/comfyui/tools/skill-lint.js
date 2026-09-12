#!/usr/bin/env node
/**
 * skill-lint.js —— 检查技能与文档里的"照着做会失败"的地方
 *
 * 为什么要有它：2026-09-01 那一轮实跑发现，`comfyui-import/SKILL.md` 的 0.2 节
 * ——"判断任何事之前，先拿到当前事实"这个最该可靠的第一步——让人去跑一个
 * **根本不存在的脚本** `43-export-capability.sh`，而且在 L1 验证段又引用了一次。
 * 这类错误靠通读发现不了（文档太长、看着都合理），但一条 grep 就能查出来。
 *
 * CLAUDE.md §0.11 的原话：**凡是能进 lint 的，都应该进 lint，不要只靠文档**。
 *
 * 查五类：
 *   1. 引用的本地文件/脚本不存在      —— 照着做第一步就失败
 *   2. 引用了板上已退役的路径          —— comfyui/ 是 py3.8 老环境，现役是 comfyui313/
 *   3. 写死的板子地址                  —— 两块板不能同时上电，写死就会连到关着的那块
 *   4. 结论没有测定日期                —— 环境变了它不会跟着变，下一轮照着它做错判断
 *   5. 指向 deploy/ 之外的板上绝对路径  —— 提示是否该走工具而不是手敲
 *
 * 用法:
 *   node skill-lint.js                       # 查默认的几份文档
 *   node skill-lint.js <文件或目录> ...
 *   node skill-lint.js --strict              # 第 4 类也算失败（默认只提示）
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const argv = process.argv.slice(2);
const strict = argv.includes('--strict');
const targets = argv.filter(a => !a.startsWith('--'));

const DEFAULT_TARGETS = [
  '.claude/skills/comfyui-import/SKILL.md',
  '.claude/skills/iecu/SKILL.md',
  'deploy/comfyui/workflows/README.md',
  'deploy/comfyui/README.md',
];

// 现役基线：改板子/改环境时同步改这里，lint 才有意义
const BASELINE = {
  activeHost: '__BOARD_LAN_IP__',          // 这块板，现役主力
  knownHosts: ['__BOARD_LAN_IP__', '__BOARD_LAN_IP__', '172.31.254.38'],
  retiredPaths: [
    { pat: /\/var\/lib\/llm\/comfyui(?![0-9])/g, why: 'py3.8 老环境已退役，现役是 /var/lib/llm/comfyui313' },
    { pat: /\/var\/lib\/llm\/comfyui310(?![0-9])/g, why: 'py3.10 环境已退居回滚位，现役是 comfyui313' },
  ],
};

let problems = 0, notes = 0;

function rel(p) { return path.relative(REPO, p).replace(/\\/g, '/'); }

// 一行里出现这些字样，说明作者是**有意**提到旧东西（讲回滚、讲历史、讲已作废），
// 不是照着做会失败的引用。没有这个豁免，lint 会对"这条已经过期了"这种正确的说明报错,
// 而一个误报多的 lint 没人会看，等于没有。
const INTENTIONAL = /回滚|保留|退役|已换|曾经|上一代|旧文档|旧的|历史|作废|不再|原样|老环境|上一版/;

function checkFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const out = [];
  // 整份文档就是讲老环境的，在文件里写一行 `<!-- lint:legacy-ok -->` 即可整份豁免
  const legacyOk = /<!--\s*lint:legacy-ok[^>]*-->/.test(text);

  // 标记每一行是否在代码块内：写死的地址只有出现在**可执行的命令**里才危险，
  // 正文讲"两块板分别是 .15 和 .16"是必须写的
  const inCode = [];
  let fence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) { fence = !fence; inCode.push(fence); continue; }
    inCode.push(fence);
  }

  // ── 1. 引用的本地文件是否存在 ──────────────────────────────
  // 只认明确的项目相对路径，避免把示例路径和板上路径也算进来
  // ⚠ 扩展名交替里长的必须在前：写成 (js|json) 会让 `object_info.json` 先命中 `js`，
  //   于是报一个根本不存在的 `object_info.js`——这个 lint 自己第一次跑就踩了。
  const fileRe = /(?:^|[\s`"'(=])((?:deploy|\.claude|report|baseline)[/\\][A-Za-z0-9_一-龥./\\-]+\.(?:json|yaml|yml|md|sh|js|ps1|py))(?=$|[\s`"'),;：、。])/g;
  const seen = new Set();
  lines.forEach((line, i) => {
    // 划掉的（~~...~~）是明确标注为作废的，不算问题
    const stripped = line.replace(/~~[^~]*~~/g, '');
    let m;
    while ((m = fileRe.exec(stripped))) {
      const p = m[1].replace(/\\/g, '/');
      const key = p + '@' + (i + 1);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!fs.existsSync(path.join(REPO, p))) {
        out.push({ lv: 'ERR', line: i + 1, msg: '引用的文件不存在: ' + p });
      }
    }
  });

  // ── 2. 板上已退役的路径 ────────────────────────────────────
  if (!legacyOk) {
    for (const r of BASELINE.retiredPaths) {
      lines.forEach((line, i) => {
        const stripped = line.replace(/~~[^~]*~~/g, '');
        r.pat.lastIndex = 0;
        if (!r.pat.test(stripped)) return;
        if (INTENTIONAL.test(stripped)) return;   // 讲回滚/历史，不是让人照着做
        out.push({ lv: 'ERR', line: i + 1, msg: '退役路径: ' + r.why });
      });
    }
  }

  // ── 3. 代码块里写死的板子地址 ──────────────────────────────
  // 只查代码块：正文讲"两块板分别是 .15 / .16"是必须写的，而**命令里写死**
  // 才会让人连到一块关着的板（两块板不能同时上电），报出来的是超时，看不出根因。
  lines.forEach((line, i) => {
    if (!inCode[i]) return;
    const stripped = line.replace(/~~[^~]*~~/g, '');
    for (const h of BASELINE.knownHosts) {
      if (h === BASELINE.activeHost) continue;
      if (!stripped.includes(h)) continue;
      // 点明是哪块板就不算问题——注释常写在上一行，所以连上一行一起看
      const ctx = stripped + '\n' + (lines[i - 1] || '');
      if (/批次A|这块板|上一块板|新板|直连|救命/.test(ctx)) continue;
      if (INTENTIONAL.test(ctx)) continue;
      out.push({ lv: 'WARN', line: i + 1, msg: '命令里写死了非现役地址 ' + h + '（现役 ' + BASELINE.activeHost + '）——改用 $env:IECU_HOST 或注明是哪块板' });
    }
  });

  // ── 3b. 代码块里用 curl/wget 探板上的东西 ──────────────────
  // 板上**没有 curl 也没有 wget**（iecu 技能第 1156 行早有记录）。
  // 但那条记在「连接方式」一节里，写探活脚本的人不会想到去翻那一节——
  // 2026-09-02 视频线就这么栽了：用 curl 探 8188 端口，检测永远失败、
  // 循环 180 秒后继续执行，**看起来像"在等服务启动"，实际空转了十几分钟且不报错**。
  // 文档里的示例最容易被照抄，所以在这里拦：位置不对的记录等于没记。
  lines.forEach((line, i) => {
    if (!inCode[i]) return;
    const stripped = line.replace(/~~[^~]*~~/g, '');
    if (!/\b(curl|wget)\b/.test(stripped)) return;
    if (/user-agent|User-Agent|-A '|别指望|没有/.test(stripped)) return;   // UA 伪装串、反面示例
    // 只管板上执行的：本地 PowerShell 里 curl 是 Invoke-WebRequest 的别名，能用
    if (!/exec\.js|ssh |bash -s|127\.0\.0\.1:8188|localhost:8188|\/var\/lib\/llm/.test(stripped)) return;
    out.push({ lv: 'ERR', line: i + 1, msg: '板上没有 curl/wget——这条会静默失败（循环等待、不报错）。改用 /var/lib/llm/bin/node -e "require(\'http\').get(...)"' });
  });

  // ── 4. 硬结论有没有测定日期 ────────────────────────────────
  // 判据：表格行里出现"跑不动/装不下/不可用/无解/不行/必然失败"这类否定断言，
  // 而整行没有任何日期。否定结论最容易过期，也最容易堵死后路。
  // "用不了"故意不列：它多半出现在排错索引的**现象**列（"节点装了但用不了"），
  // 那是待查的症状不是结论，要求它带日期只会制造噪声。
  const NEG = /(跑不动|装不下|不可用|不支持|无解|不行|必然失败|做不到|没有.*支持)/;
  // 合格的标注有三种：日期、证据编号 A-nnn、或【算术】。
  // **【算术】不需要日期**——"18 GB 的模型装不进 14 GB 预算"只要预算不变就永远成立，
  // 它和"ControlNet 跑不动"这种实测结论是两回事：后者换了 Flash Attention 就作废了。
  // 分清这两类，才知道哪些结论该定期复核、哪些可以放心引用。
  const DATE = /20\d\d[-年]\d\d?([-月]\d\d?)?|[A-Z]-\d{2,3}|【算术】/;
  // 讲"曾经的错误认知"的行（反面教材列）说的不是当前结论，不该要求日期
  const RETRO = /说["“]|以为|曾经|差点|正是这种|反面|栽在|错误地/;
  lines.forEach((line, i) => {
    if (!line.trim().startsWith('|')) return;
    // 表头行（下一行是 |---|---| 分隔）与分隔行本身：那是列名，不是结论
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return;
    if (lines[i + 1] && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) return;
    const stripped = line.replace(/~~[^~]*~~/g, '');
    if (!NEG.test(stripped)) return;
    if (DATE.test(stripped)) return;
    if (RETRO.test(stripped)) return;
    out.push({ lv: 'NOTE', line: i + 1, msg: '否定结论没有测定日期或证据编号，将来无法判断是否已过期' });
  });

  return out;
}

const files = [];
for (const t of (targets.length ? targets : DEFAULT_TARGETS)) {
  const p = path.isAbsolute(t) ? t : path.join(REPO, t);
  if (!fs.existsSync(p)) { console.log('跳过（不存在）: ' + t); continue; }
  if (fs.statSync(p).isDirectory()) {
    for (const f of fs.readdirSync(p)) if (f.endsWith('.md')) files.push(path.join(p, f));
  } else files.push(p);
}

for (const f of files) {
  const out = checkFile(f);
  const errs = out.filter(x => x.lv === 'ERR');
  const warns = out.filter(x => x.lv === 'WARN');
  const nts = out.filter(x => x.lv === 'NOTE');
  problems += errs.length + warns.length;
  notes += nts.length;

  if (!out.length) { console.log('✅ ' + rel(f)); continue; }
  console.log((errs.length ? '⛔ ' : '⚠ ') + rel(f));
  for (const x of [...errs, ...warns, ...nts]) {
    const tag = x.lv === 'ERR' ? '  [错] ' : x.lv === 'WARN' ? '  [警] ' : '  [注] ';
    console.log(tag + rel(f) + ':' + x.line + '  ' + x.msg);
  }
}

console.log('');
console.log('检查 ' + files.length + ' 份文档：错/警 ' + problems + ' 处，提示 ' + notes + ' 处');
if (problems || (strict && notes)) process.exit(1);
