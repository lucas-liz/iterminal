import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { startLlmMock, type LlmMock } from '../test/support/llm-mock';

/**
 * 知识库 + 本地向量模型联调（真实服务端 + 真实的本地向量服务），只在设置了 ITM_REAL_SERVER 时运行：
 *   ITM_REAL_SERVER=http://127.0.0.1:18080 npx playwright test e2e/kb-local.spec.ts
 * 本地向量服务默认是本机 Ollama 的 bge-m3（ITM_LOCAL_EMBED_URL / ITM_LOCAL_EMBED_MODEL 可以覆盖）；服务端需要关闭验证码。
 * 验证：AI 对话里「引用知识库」后，发送时先按问题做语义检索，模型不调用工具也能拿到命中的片段（任何模型都能用上知识库）。
 */
const BASE = process.env.ITM_REAL_SERVER ?? '';
const USER = process.env.ITM_REAL_USER ?? 'admin';
const PASSWORD = process.env.ITM_REAL_PASSWORD ?? '';
const EMBED_URL = process.env.ITM_LOCAL_EMBED_URL ?? 'http://127.0.0.1:11434';
const EMBED_MODEL = process.env.ITM_LOCAL_EMBED_MODEL ?? 'bge-m3';

test.skip(!BASE || !process.env.ITM_REAL_PASSWORD, '没有设置 ITM_REAL_SERVER 和 ITM_REAL_PASSWORD');

let root: string;
let llm: LlmMock;

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...process.env, ITM_USER_DATA: join(root, 'userData'), ITM_INSECURE_KEYSTORE: '1', ELECTRON_RENDERER_URL: '', ITM_DEFAULT_SERVER_URL: BASE };
  const app = await electron.launch({ args: ['.'], cwd: join(__dirname, '..'), env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

type Itm = { itm: { invoke(c: string, a?: unknown): Promise<unknown> } };
const call = <T,>(page: Page, c: string, a?: unknown): Promise<T> => page.evaluate(([c2, a2]) => (globalThis as unknown as Itm).itm.invoke(c2 as string, a2) as Promise<T>, [c, a] as const);

async function admin<T = Record<string, unknown>>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (await res.json()) as T;
}

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'itm-e2e-kb-local-'));
  llm = await startLlmMock();
});

test.afterAll(async () => {
  await llm?.close();
  rmSync(root, { recursive: true, force: true });
});

test('引用知识库（本地向量模型）：发送前按问题语义检索，模型不调用工具也拿到命中的片段', async () => {
  test.setTimeout(180_000);
  const token = (await admin<{ token: string }>(null, 'POST', '/login', { username: USER, password: PASSWORD })).token;
  expect(token).toBeTruthy();
  type Conf = { source: string; embedProviderId: string; embedUrl: string; embedModel: string };
  const before = (await admin<{ data: Conf }>(token, 'GET', '/iterminal/kb/config')).data;
  const undo: (() => Promise<unknown>)[] = [() => admin(token, 'PUT', '/iterminal/kb/config', before)];
  try {
    // 后台：向量模型用本地向量服务；团队模型指向本机的模拟模型接口（只回答文字，不会调用工具）
    const saved = await admin<{ code: number; msg: string }>(token, 'PUT', '/iterminal/kb/config', { source: 'LOCAL', embedUrl: EMBED_URL, embedModel: EMBED_MODEL });
    expect(saved.code, saved.msg).toBe(200);
    const llmName = `知识库联调模型-${Date.now()}`;
    const added = await admin<{ code: number; msg: string }>(token, 'POST', '/iterminal/llm/provider', {
      providerName: llmName, providerType: 'OPENAI_COMPAT', baseUrl: llm.url, apiKey: 'sk-kb-local',
      models: JSON.stringify([{ id: 'mock-model', contextWindow: 32000, maxOutput: 4096 }]),
    });
    expect(added.code, added.msg).toBe(200);
    const providerId = (await admin<{ rows: { providerId: number }[] }>(token, 'GET', `/iterminal/llm/provider/list?providerName=${encodeURIComponent(llmName)}`)).rows[0].providerId;
    undo.push(() => admin(token, 'DELETE', `/iterminal/llm/provider/${providerId}`));

    const kbName = `网关手册-${Date.now()}`;
    await admin(token, 'POST', '/iterminal/kb/collection', { collectionName: kbName, description: '本地向量联调', roleKeys: '' });
    const kb = (await admin<{ data: { collection_id: number; collection_name: string }[] }>(token, 'GET', '/iterminal/kb/collection/list')).data.find((c) => c.collection_name === kbName)!;
    undo.push(() => admin(token, 'DELETE', `/iterminal/kb/collection/${kb.collection_id}`));
    await admin(token, 'POST', '/iterminal/kb/document/text', {
      collectionId: kb.collection_id,
      title: '网关故障手册',
      content: '# 网关故障手册\n\n## 502 Bad Gateway\n\nNginx 返回 502 时，先确认 upstream 后端进程是否存活，再看 error.log 里的 upstream prematurely closed connection。',
    });
    await expect
      .poll(async () => (await admin<{ data: { status: string; embedded: string }[] }>(token, 'GET', `/iterminal/kb/document/list?collectionId=${kb.collection_id}`)).data.map((d) => `${d.status}/${d.embedded}`), { timeout: 60_000 })
      .toEqual(['INDEXED/1']);

    // 客户端：登录，AI 对话里引用这个知识库
    const { app, page } = await launch();
    await page.getByTestId('avatar-trigger').click();
  await page.getByTestId('login-open').click();
    await page.getByTestId('login-username').fill(USER);
    await page.getByTestId('login-password').fill(PASSWORD);
    await page.getByTestId('login-submit').click();
    await expect(page.getByTestId('avatar-trigger')).toHaveAttribute('data-status', 'valid', { timeout: 20_000 });
    await expect.poll(async () => (await call<{ id: string }[]>(page, 'ai.providers.list')).some((p) => p.id === `team:${providerId}`), { timeout: 15_000 }).toBe(true);
    expect((await call<{ name: string }[]>(page, 'kb.collections')).map((c) => c.name)).toContain(kbName);

    await page.getByTestId('mode-ai').click();
    await page.getByTestId('agent-new').click();
    await page.getByTestId('refs-expand').click();
    await page.getByTestId('refs-cat-kb').click();
    await expect(page.getByTestId('ref-kb-all')).toBeVisible();
    await page.getByTestId(`ref-kb-${kbName}`).click();
    await expect(page.getByTestId('refs-cat-kb')).toContainText('1');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ctx-kb')).toContainText(kbName);

    // 问法和原文没有相同的关键词：靠本地向量模型的语义检索命中；模型直接回答（没有调用 kb_search）
    const n = llm.requests.length;
    llm.enqueue({ text: '先确认上游后端进程是否存活 [1]' });
    await page.getByTestId('agent-input').fill('网站打不开，反向代理报网关错误');
    await page.getByTestId('agent-send').click();
    await expect(page.getByText('先确认上游后端进程是否存活')).toBeVisible({ timeout: 30_000 });
    const sent = JSON.stringify(llm.requests[n].body.messages);
    expect(sent).toContain('【知识库检索结果】');
    expect(sent).toContain('[1] 网关故障手册 · 网关故障手册 / 502 Bad Gateway');
    expect(sent).toContain(`来源 ${kbName}`);
    expect(sent).toContain('upstream prematurely closed connection');
    expect(llm.requests.length).toBe(n + 1);
    await page.screenshot({ path: join(__dirname, '..', 'test-results', 'kb-local-ref.png') });
    await app.close();
  } finally {
    for (const f of undo.reverse()) await f().catch(() => undefined);
  }
});
