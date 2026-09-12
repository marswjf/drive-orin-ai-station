import { Component, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';

/* 界面崩了不能变成白屏——这台设备很多时候只能从公网看它。
   出错时至少要让人知道发生了什么，并且还能回到旧版面板做操作。 */
class Boundary extends Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error('[panel] 渲染失败', err, info); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div style={{ maxWidth: 560, margin: '48px auto', padding: 24, lineHeight: 1.7 }}>
        <h1 style={{ fontSize: 17, margin: '0 0 8px' }}>界面加载失败</h1>
        <p style={{ color: 'var(--fg-2)', fontSize: 13.5, margin: '0 0 12px' }}>
          设备本身不受影响，推理服务仍在按原状运行。可以先用旧版面板操作，或刷新重试。
        </p>
        <pre style={{
          background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8,
          padding: 10, fontSize: 11.5, whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 200,
        }}>{String(this.state.err && this.state.err.message || this.state.err)}</pre>
        <p style={{ marginTop: 14, fontSize: 13 }}>
          <a href="/index.legacy.html" style={{ color: 'var(--accent)' }}>打开旧版面板</a>
          {'　'}
          <a href="/" style={{ color: 'var(--accent)' }}>重新加载</a>
        </p>
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>,
);
