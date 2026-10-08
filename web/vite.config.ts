import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 显式绑 IPv4。默认只监听 ::1，浏览器打开 http://127.0.0.1:5173 会连接被拒。
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // 开发时前端在 5173、后端在 5178；代理 /api 就不用配 CORS
    proxy: {
      '/api': { target: 'http://127.0.0.1:5178', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
