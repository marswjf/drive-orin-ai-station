/* 与面板后端通信。所有写操作都要带 X-Panel-Request 头——
 * 后端用它挡跨站表单提交（会话 Cookie 是 SameSite=Strict，这是第二道）。
 * 401 表示会话过期，直接送去登录页，不要在界面上堆一个用户看不懂的错误。 */

async function req(path, opts = {}) {
  const init = { credentials: 'same-origin', ...opts, headers: { ...(opts.headers || {}) } };
  if (init.method && init.method !== 'GET') init.headers['X-Panel-Request'] = '1';

  const r = await fetch(path, init);
  if (r.status === 401) { window.location.replace('/login.html'); throw new Error('会话已过期'); }

  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 原样交给下面处理 */ }

  if (!r.ok) throw new Error((data && data.error) || text.slice(0, 200) || `请求失败（${r.status}）`);
  return data;
}

export const getStatus = () => req('/api/status');
export const getRuntime = () => req('/api/runtime');
export const getHistory = (minutes) => req(`/api/history?minutes=${minutes}`);
export const getLogs = (unit, n) => req(`/api/logs/${unit}?n=${n}`);

export const serviceAction = (unit, action) => req(`/api/service/${unit}/${action}`, { method: 'POST' });
export const switchMode = (mode) => req(`/api/mode/${mode}`, { method: 'POST' });
export const getPresets = () => req('/api/preset');
export const applyPreset = (name) => req(`/api/preset/${name}`, { method: 'POST' });
export const getSdModels = () => req('/api/sd-models');
export const dropCaches = () => req('/api/drop-caches', { method: 'POST' });
export const getEmbeddingBackend = () => req('/api/embedding-backend');
export const applyEmbeddingBackend = (b) => req(`/api/embedding-backend/${b}`, { method: 'POST' });
export const rollbackConfig = () => req('/api/config/rollback', { method: 'POST' });

export const saveConfig = (body) => req('/api/config', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const logout = () => req('/api/auth/logout', { method: 'POST' });
export const authState = () => req('/api/auth/state');
