import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 产物直接推到板子的 /var/lib/llm/panel/。面板后端把 /assets/* 设为长缓存，
// 其余 no-store，所以文件名必须带内容哈希（Vite 默认就带）。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 板子通过 SFTP 推文件，文件越少越省事；不做代码分割
    rollupOptions: { output: { manualChunks: undefined } },
    chunkSizeWarningLimit: 900,
  },
  server: {
    // 本地开发时把接口代理到隧道上的板子（先开好 -L <PANEL_JUMP_PORT2> 那条隧道）
    proxy: {
      '/api': 'http://127.0.0.1:<PANEL_JUMP_PORT2>',
      '/llm': 'http://127.0.0.1:<PANEL_JUMP_PORT2>',
      '/v1': 'http://127.0.0.1:<PANEL_JUMP_PORT2>',
    },
  },
});
