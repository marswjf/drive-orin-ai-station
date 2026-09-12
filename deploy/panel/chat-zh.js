/* llama.cpp 内置聊天界面的中文覆盖层。
 *
 * 为什么用运行时覆盖而不是改打包产物：那个界面是 8.8 MB 的 SvelteKit 单包，
 * 没有 i18n 框架，字符串和代码标识符混在一起（"Stop" 出现 135 次，绝大多数
 * 是标识符不是文案）。直接替换字符串会把应用改坏，而且升级 llama.cpp 就得重来。
 * 覆盖层只认整段文本的精确匹配，改不动就原样保留，风险可控、可随时关掉。
 *
 * 由面板在代理 /llm/ 的 HTML 响应时注入。带 ?lang=en 打开可临时关闭。
 *
 * 安全边界：绝不进入 pre / code / textarea / 可编辑区域 / 消息正文，
 * 否则会把模型的输出和用户输入一起"翻译"了。
 */
(function () {
  'use strict';
  if (/[?&]lang=en\b/.test(location.search)) return;

  var DICT = {
    // 顶栏与导航
    'New chat': '新建对话',
    'Conversations': '对话记录',
    'Settings': '设置',
    'Search': '搜索',
    'Search conversations': '搜索对话',
    'Expand navigation': '展开侧栏',
    'Collapse navigation': '收起侧栏',
    'Back': '返回',
    'Close': '关闭',
    'Cancel': '取消',
    'Save': '保存',
    'Apply': '应用',
    'Continue': '继续',
    'Confirm': '确认',
    'Delete': '删除',
    'Edit': '编辑',
    'Copy': '复制',
    'Cut': '剪切',
    'Paste': '粘贴',
    'Rename': '重命名',
    'Export': '导出',
    'Import': '导入',
    'Enable': '启用',
    'Disable': '停用',
    'Discard': '放弃',
    'Deny': '拒绝',
    'Allow once': '允许一次',
    'All': '全部',
    'Light': '浅色',
    'Dark': '深色',
    'System': '跟随系统',
    'Theme': '主题',
    'Language': '语言',
    'About': '关于',

    // 输入区
    'Send message': '发送消息',
    'Send': '发送',
    'Stop': '停止',
    'Stop generation': '停止生成',
    'Regenerate': '重新生成',
    'Type a message...': '输入消息…',
    'Edit your message...': '修改你的消息…',
    'Add to chat': '添加到对话',
    'Add files, prompts, tools or MCP Servers': '添加文件、提示词、工具或 MCP 服务',
    'Add files, system prompt or configure MCP servers': '添加文件、系统提示词，或配置 MCP 服务',
    'Attachments': '附件',
    'Audio': '音频',
    'Audio Files': '音频文件',
    'Upload': '上传',
    'Upload files': '上传文件',
    'Record': '录音',
    'Binary content': '二进制内容',
    'Download content': '下载内容',
    'Copy content': '复制内容',
    'Copy code': '复制代码',
    'Edit file': '编辑文件',

    // 消息与对话操作
    'Delete Message': '删除这条消息',
    'Delete Conversation': '删除对话',
    'Delete All': '全部删除',
    'Delete all conversations': '删除全部对话',
    'Delete selected': '删除所选',
    'Deselect all': '取消全选',
    'Select all': '全选',
    'Export selected': '导出所选',
    'Exit bulk selection mode': '退出批量选择',
    'Bulk actions for selected conversations': '对所选对话批量操作',
    'All conversations deleted': '已删除全部对话',
    'Add to favorites': '收藏',
    'Discard changes?': '放弃修改？',
    'Enter fork name': '输入分支名称',
    'Collapse System Message': '收起系统提示词',
    'Add custom system message for a new conversation': '为新对话设置系统提示词',

    // 模型与服务器信息
    'Chat': '对话',
    'Chat Template': '对话模板',
    'Context Size': '上下文长度',
    'Embedding Size': '向量维度',
    'Build Info': '版本信息',
    'Current model details and capabilities': '当前模型的详情与能力',
    'Click for model details': '点击查看模型详情',
    'Choose a model to use for the conversation': '选择本次对话使用的模型',
    'Copy model name to clipboard': '复制模型名称',
    'Copy model path to clipboard': '复制模型路径',
    'Current time': '当前时间',
    'Avg speed': '平均速度',
    'Connected': '已连接',
    'Connecting...': '正在连接…',

    // 设置分组
    'General': '通用',
    'Advanced': '进阶',
    'Developer': '开发者',
    'Samplers': '采样',
    'Penalties': '惩罚项',
    'Reasoning': '思考过程',
    'Tools': '工具',
    'Built-in': '内置',
    'Built-in Tools': '内置工具',
    'Custom Tools': '自定义工具',
    'Browser Tools': '浏览器工具',
    'API Key': '接口密钥',
    'Export settings': '导出设置',
    'Import settings': '导入设置',
    'Cleared all user overrides': '已清除全部自定义设置',

    // MCP
    'Add New MCP Server': '添加 MCP 服务',
    'Add another MCP server': '再添加一个 MCP 服务',
    'Add your first MCP server': '添加第一个 MCP 服务',
    'All MCP server connections failed': '所有 MCP 服务都连接失败',

    // Agent
    'Agentic': '智能体',
    'Agentic summary': '智能体执行摘要',
    'Agentic turns (LLM calls)': '智能体轮次（模型调用次数）',
    'Agentic turn limit reached. Continue?': '已达到智能体轮次上限，继续执行？',

    // 状态与错误
    'Loading': '加载中',
    'Error': '出错了',
    'Retry': '重试',
    'Access denied': '没有访问权限',
    'Access denied - check server permissions': '没有访问权限，请检查服务端设置',
    'Connection Error': '连接失败',
    'Connection error - please try again': '连接失败，请重试',
    'Connection refused - server may be offline': '连接被拒绝，服务可能没有运行',
    'Failed to connect to server': '无法连接到服务',
    'Audio files processing requires an audio model': '处理音频需要支持音频的模型',
    'Audio recording not supported': '当前浏览器不支持录音',
    'Failed to export conversations': '导出对话失败',
    'Failed to import conversations': '导入对话失败',
    'Failed to export settings': '导出设置失败',
    'Failed to delete message:': '删除消息失败：',
    'Failed to generate response:': '生成回复失败：',
    'Failed to add system prompt:': '设置系统提示词失败：',
    'Failed to attach resources:': '附加资源失败：',
    'Failed to continue message:': '继续生成失败：',
    'Failed to edit user message:': '修改消息失败：',
    'Error fetching server properties:': '读取服务信息失败：',
    'Error checking API key:': '校验接口密钥失败：',
  };

  // 属性也要翻：无障碍标签和提示气泡是纯文案
  var ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];

  // 这些容器里的文字属于用户输入或模型输出，绝对不能动
  var SKIP_TAG = { PRE: 1, CODE: 1, TEXTAREA: 1, SCRIPT: 1, STYLE: 1, SVG: 1, KBD: 1, SAMP: 1 };
  var SKIP_ATTR = /message|markdown|prose|content-body|chat-body/i;

  var miss = new Set();
  window.__zhMiss = miss;   // 排查用：控制台看 [...window.__zhMiss] 就知道还有哪些没翻

  function blocked(node) {
    for (var el = node.parentElement; el; el = el.parentElement) {
      if (SKIP_TAG[el.tagName]) return true;
      if (el.isContentEditable) return true;
      var cls = typeof el.className === 'string' ? el.className : '';
      if (SKIP_ATTR.test(cls)) return true;
      if (el.hasAttribute && (el.hasAttribute('data-message-id') || el.hasAttribute('data-role'))) return true;
    }
    return false;
  }

  function translateText(node) {
    var raw = node.nodeValue;
    if (!raw) return;
    var key = raw.trim();
    if (key.length < 2 || key.length > 80) return;
    if (!/[A-Za-z]/.test(key)) return;
    var hit = DICT[key];
    if (hit === undefined) {
      // 只记那些看起来像 UI 文案的漏网之鱼，别把模型输出记进来
      if (key.length <= 40 && !blocked(node)) miss.add(key);
      return;
    }
    if (blocked(node)) return;
    node.nodeValue = raw.replace(key, hit);
  }

  function translateEl(el) {
    if (!el.getAttribute) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute(ATTRS[i]);
      if (v && DICT[v.trim()]) el.setAttribute(ATTRS[i], DICT[v.trim()]);
    }
  }

  function walk(root) {
    if (root.nodeType === 3) { translateText(root); return; }
    if (root.nodeType !== 1) return;
    if (SKIP_TAG[root.tagName]) return;
    translateEl(root);
    var it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    var n;
    while ((n = it.nextNode())) {
      if (n.nodeType === 3) translateText(n);
      else translateEl(n);
    }
  }

  function boot() {
    document.documentElement.lang = 'zh-CN';
    walk(document.body);
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.type === 'characterData') translateText(m.target);
        else if (m.type === 'attributes') translateEl(m.target);
        else for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]);
      }
    }).observe(document.body, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATTRS,
    });
    console.log('[IECU] 聊天界面中文覆盖层已启用。未翻译的文案：[...window.__zhMiss]；'
      + '想看英文原版在网址后加 ?lang=en');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
