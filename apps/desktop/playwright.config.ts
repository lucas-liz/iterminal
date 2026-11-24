import { defineConfig } from '@playwright/test';

// 正式版本地模式不能用 AI（第十二轮）；E2E 大多在本地模式下用模拟模型测 AI，启动应用时带上这个变量放开（只在没有打包时生效）
process.env.ITM_ALLOW_LOCAL_AI ??= '1';
// 左侧导航默认隐藏数据库、监控、定时任务、审批（第二十二轮）；E2E 默认全部显示，ui22 里单独测默认值
process.env.ITM_NAV_ALL ??= '1';

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  workers: 1,
  reporter: [['list']],
  outputDir: 'test-results',
});
