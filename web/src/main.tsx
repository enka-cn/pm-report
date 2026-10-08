import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 本地单用户工具：不需要窗口聚焦就重取，失败也别自动重试（错误信息直接给用户看）
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 挂载点');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
