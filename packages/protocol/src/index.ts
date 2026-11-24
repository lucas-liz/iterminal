/**
 * 主进程和渲染进程共用的类型（文档一 9.1）。所有 IPC 通道都在 ipc.ts 里定义，禁止在代码里拼接通道名。
 * 敏感信息（密码、私钥）只能从渲染进程写入主进程，主进程永远不把它们返回给渲染进程
 * （唯一的例外是经过重新验证的「查看明文」，见 credential.reveal）。
 */
export * from './core';
export * from './shortcuts';
export * from './vault';
export * from './monitor';
export * from './ai';
export * from './ai-vendors';
export * from './web-search';
export * from './settings';
export * from './highlight';
export * from './terminal-colors';
export * from './schedule';
export * from './ssh-forward';
export * from './library';
export * from './mcp';
export * from './sync';
export * from './audit';
export * from './update';
export * from './server';
export * from './alert';
export * from './feedback';
export * from './database';
export * from './batch';
export * from './ipc';
