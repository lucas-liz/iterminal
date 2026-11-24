import { createServer, type IncomingMessage, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';

export interface MockMessage {
  type: string;
  id: string;
  ts?: string;
  ack?: boolean;
  payload?: Record<string, unknown>;
}

/**
 * 模拟 iTerminal 服务端（文档二第 7 章）：换票、WebSocket（hello / ping / ack）、审计上报、执行器创建远程审批。
 * 只用于测试。
 */
export interface MockServer {
  url: string;
  token: string;
  /** 客户端发来的 WS 消息 */
  received: MockMessage[];
  /** REST 请求（路径 + body + 设备标识） */
  rest: { method: string; path: string; body: unknown; deviceId?: string }[];
  /** 账号登录用的用户名密码（POST /api/v1/auth/login） */
  readonly user: { username: string; password: string };
  /** 让当前的访问令牌失效（测试客户端用刷新令牌换新的） */
  expireAccess(): void;
  /** 让刷新令牌失效（测试登录过期） */
  expireRefresh(): void;
  /** GET /api/v1/ai/policy 返回的内容 */
  setPolicy(p: Record<string, unknown>): void;
  /** 团队模型：GET /api/v1/ai/models 返回的列表；代理把请求转给 upstream（模拟换上真实 Key：Authorization: Bearer sk-upstream） */
  setTeamModels(providers: unknown[], upstream: string | null): void;
  /** 团队主机：GET /api/v1/team/assets 返回的内容 */
  setTeamAssets(data: { folders: unknown[]; hosts: unknown[] }): void;
  /** 知识库：POST /api/v1/kb/search 返回的片段 */
  setKb(hits: unknown[]): void;
  /** 代理收到的请求（鉴权头） */
  proxied: { path: string; auth: string | undefined }[];
  /** 接下来 n 次审计上报返回 500 */
  failAudit(n: number): void;
  /** 不回 ack（测试客户端重发） */
  holdAcks(on: boolean): void;
  /** 执行器创建审批后自动给出结果（null = 不自动处理） */
  autoDecide(d: 'APPROVED' | 'REJECTED' | null): void;
  send(type: string, payload: unknown, opts?: { ack?: boolean; id?: string }): string;
  /** 断开所有客户端（测试重连） */
  dropClients(): void;
  waitFor(pred: (m: MockMessage) => boolean, timeoutMs?: number): Promise<MockMessage>;
  close(): Promise<void>;
}

export async function startMockServer(): Promise<MockServer> {
  let token = `tok-${randomUUID()}`;
  let refresh = `rt-${randomUUID()}`;
  const user = { username: 'tester', password: 'pw-123456' };
  let teamModels: unknown[] = [];
  let teamAssets: { folders: unknown[]; hosts: unknown[] } = { folders: [], hosts: [] };
  let kbHits: unknown[] = [];
  let upstream: string | null = null;
  const proxied: { path: string; auth: string | undefined }[] = [];
  let policy: Record<string, unknown> = { commandRules: [], maskRules: [], unattendedCap: 'READONLY', allowLlmReview: true, version: '1' };
  const received: MockMessage[] = [];
  const rest: MockServer['rest'] = [];
  let auditFailures = 0;
  let hold = false;
  let decide: 'APPROVED' | 'REJECTED' | null = 'APPROVED';
  const clients = new Set<WebSocket>();
  const tickets = new Set<string>();
  const listeners: (() => void)[] = [];

  const body = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => resolve(raw ? (JSON.parse(raw) as unknown) : null));
    });

  const broadcast = (m: MockMessage): void => {
    for (const c of clients) c.send(JSON.stringify(m));
  };
  const send: MockServer['send'] = (type, payload, opts = {}) => {
    const id = opts.id ?? randomUUID();
    broadcast({ type, id, ts: new Date().toISOString(), ...(opts.ack ? { ack: true } : {}), payload: payload as Record<string, unknown> });
    return id;
  };

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    // 大模型代理：原样转发（流式），鉴权用登录令牌（OpenAI SDK 放 Authorization，Anthropic SDK 放 x-api-key）
    const pm = /^\/api\/v1\/llm\/proxy\/([^/]+)\/(.+)$/.exec(path);
    if (pm) {
      const auth = (req.headers.authorization as string | undefined) ?? (req.headers['x-api-key'] ? `Bearer ${req.headers['x-api-key'] as string}` : undefined);
      proxied.push({ path, auth });
      const raw = await new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
      });
      if (auth !== `Bearer ${token}` || !upstream) {
        res.writeHead(401, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: '登录已过期' } }));
      }
      const up = await fetch(`${upstream}/${pm[2]}`, { method: req.method, headers: { 'content-type': 'application/json', authorization: 'Bearer sk-upstream', 'x-api-key': 'sk-upstream' }, body: raw.length ? raw : undefined });
      res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });
      if (up.body) for await (const chunk of up.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk);
      return res.end();
    }
    // 头像（若依的 /profile/** 不需要登录）：1×1 的蓝色 PNG
    if (req.method === 'GET' && path === '/profile/avatar/tester.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
    }
    const b = await body(req);
    rest.push({ method: req.method ?? '', path, body: b, deviceId: req.headers['x-device-id'] as string | undefined });
    const json = (status: number, data: unknown, message?: string): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: status === 200 ? 0 : status, message: message ?? (status === 200 ? 'ok' : 'error'), data }));
    };
    // 账号：登录、刷新令牌（不需要访问令牌）
    if (req.method === 'POST' && path === '/api/v1/auth/login') {
      const lb = (b ?? {}) as { username?: string; password?: string };
      if (lb.username !== user.username || lb.password !== user.password) return json(401, null, '用户不存在/密码错误');
      return json(200, { accessToken: token, refreshToken: refresh, expiresIn: 1800, user: { userId: 7, userName: user.username, nickName: '测试用户', email: 'tester@example.com', avatar: '/profile/avatar/tester.png' } });
    }
    if (req.method === 'POST' && path === '/api/v1/auth/refresh') {
      if ((b as { refreshToken?: string })?.refreshToken !== refresh) return json(401, null, '刷新令牌无效，请重新登录');
      token = `tok-${randomUUID()}`;
      refresh = `rt-${randomUUID()}`;
      return json(200, { accessToken: token, refreshToken: refresh, expiresIn: 1800 });
    }
    if (req.headers.authorization !== `Bearer ${token}`) return json(401, null, '登录已过期');
    if (req.method === 'GET' && path === '/api/v1/ai/policy') return json(200, policy);
    if (req.method === 'GET' && path === '/api/v1/ai/models') return json(200, teamModels);
    if (req.method === 'GET' && path === '/api/v1/team/assets') return json(200, teamAssets);
    if (req.method === 'POST' && path === '/api/v1/kb/search') return json(200, kbHits.slice(0, (b as { topK?: number })?.topK ?? 5));
    if (req.method === 'POST' && path === '/api/v1/auth/logout') return json(200, null);
    if (req.method === 'GET' && path === '/api/v1/ws/ticket') {
      const t = randomUUID();
      tickets.add(t);
      return json(200, { ticket: t });
    }
    if (req.method === 'POST' && path === '/api/v1/audit/commands:batch') {
      if (auditFailures > 0) {
        auditFailures--;
        return json(500, null);
      }
      return json(200, { accepted: ((b as { items: unknown[] }).items ?? []).length });
    }
    if (req.method === 'POST' && /^\/api\/v1\/audit\/sessions\/[^/]+\/chunks$/.test(path)) return json(200, null);
    const m = /^\/api\/v1\/sched\/runs\/([^/]+)\/approvals$/.exec(path);
    if (req.method === 'POST' && m) {
      const approvalId = `ap-${randomUUID()}`;
      json(200, { approvalId, expiresAt: new Date(Date.now() + 60_000).toISOString() });
      if (decide) {
        const d = decide;
        setTimeout(() => send('approval.result', { approvalId, runId: decodeURIComponent(m[1]), decision: d, by: 'admin' }, { ack: true }), 50);
      }
      return;
    }
    json(404, null);
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url ?? '', 'http://x');
    const ticket = u.searchParams.get('ticket') ?? '';
    if (u.pathname !== '/ws/client' || !tickets.delete(ticket)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as MockMessage;
        received.push(msg);
        if (msg.ack && !hold) ws.send(JSON.stringify({ type: 'ack', id: msg.id }));
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', id: msg.id }));
        listeners.forEach((l) => l());
      });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  return {
    url,
    get token() {
      return token;
    },
    user,
    expireAccess: () => {
      token = `tok-${randomUUID()}`;
    },
    expireRefresh: () => {
      refresh = `rt-${randomUUID()}`;
    },
    setPolicy: (p) => {
      policy = p;
    },
    setTeamAssets: (data) => {
      teamAssets = data;
    },
    setKb: (hits) => {
      kbHits = hits;
    },
    setTeamModels: (providers, up) => {
      teamModels = providers;
      upstream = up;
    },
    proxied,
    received,
    rest,
    failAudit: (n) => {
      auditFailures = n;
    },
    holdAcks: (on) => {
      hold = on;
    },
    autoDecide: (d) => {
      decide = d;
    },
    send,
    dropClients: () => {
      for (const c of clients) c.terminate();
      clients.clear();
    },
    waitFor: (pred, timeoutMs = 5000) =>
      new Promise((resolve, reject) => {
        const found = received.find(pred);
        if (found) return resolve(found);
        const timer = setTimeout(() => reject(new Error(`等待消息超时；已收到：${received.map((m) => m.type).join(',')}`)), timeoutMs);
        const check = (): void => {
          const f = received.find(pred);
          if (f) {
            clearTimeout(timer);
            listeners.splice(listeners.indexOf(check), 1);
            resolve(f);
          }
        };
        listeners.push(check);
      }),
    close: () =>
      new Promise<void>((r) => {
        for (const c of clients) c.terminate();
        wss.close();
        server.close(() => r());
      }),
  };
}
