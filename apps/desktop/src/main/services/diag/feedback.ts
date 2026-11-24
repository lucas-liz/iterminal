import { arch, cpus, freemem, platform, release, totalmem, version as osVersion } from 'node:os';
import { Masker } from '@itm/masking';
import {
  FEEDBACK_MAX_IMAGE_BYTES,
  FEEDBACK_MAX_IMAGES,
  type DiagEntry,
  type Diagnostics,
  type FeedbackEnv,
  type FeedbackImage,
  type FeedbackInput,
  type FeedbackPreview,
  type FeedbackRecord,
} from '@itm/protocol';
import { UserError } from '../../util/errors';
import { envelopeError, OLD_SERVER } from '../../util/envelope';
import { redactServers } from '../../util/redact-server';
import type { DiagLog } from './diag-log';

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const TRAIL_IN_MD = 200;
const CAPTURE_JPEG_OVER = 2 * 1024 * 1024;

export interface FeedbackDeps {
  diag: DiagLog;
  version: string;
  /** 当前档案：账号模式时有登录的服务端连接 */
  profile(): { kind: 'local' | 'account'; serverUrl: string | null; email: string | null };
  /** 账号模式的服务端连接（带登录令牌）；本地模式为 null */
  link(): { rawRequest(method: 'GET' | 'POST', path: string, init?: { body?: RequestInit['body']; headers?: Record<string, string>; timeoutMs?: number }): Promise<Response> } | null;
  /** 本地模式提交到哪个服务端（预置的，否则默认服务端；未配置默认服务端时为 null） */
  anonymousServer(): string | null;
  /** 档案相关的环境信息（设置摘要、数据条数、打开的会话） */
  profileEnv(): FeedbackEnv;
  /** 应用级的环境信息（语言、屏幕、运行时版本） */
  appEnv(): FeedbackEnv;
  /** 截取窗口（PNG） */
  capture(owner: number): Promise<{ png: Buffer; jpeg: () => Buffer }>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const gb = (n: number): string => `${(n / 1024 ** 3).toFixed(1)} GB`;

/** 相对时间：-35s、-2m05s、-1h03m */
export function relTime(t: number, base: number): string {
  const s = Math.round((t - base) / 1000);
  const a = Math.abs(s);
  const txt = a < 60 ? `${a}s` : a < 3600 ? `${Math.floor(a / 60)}m${String(a % 60).padStart(2, '0')}s` : `${Math.floor(a / 3600)}h${String(Math.floor((a % 3600) / 60)).padStart(2, '0')}m`;
  return `${s < 0 ? '-' : '+'}${txt}`;
}

/**
 * 问题反馈（第十三轮，文档一 6.27.1）：收集环境信息、操作轨迹、错误、日志尾部，生成 diagnostics.json 和给 AI 看的 diagnostics.md，
 * 连同截图提交到服务端（账号模式用登录的连接；本地模式走匿名接口）。
 */
export class FeedbackService {
  constructor(private readonly d: FeedbackDeps) {}

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private env(): FeedbackEnv {
    const p = this.d.profile();
    const c = cpus();
    const base: FeedbackEnv = {
      应用: {
        版本: this.d.version,
        档案: p.kind === 'account' ? '账号' : '本地模式（未登录）',
        // 界面上不显示服务端地址：只说明是不是默认（或企业预置）的服务端
        服务端: p.kind !== 'account' ? '—' : p.serverUrl && p.serverUrl === this.d.anonymousServer() ? '默认' : '其他',
        运行时长: `${Math.round(process.uptime() / 60)} 分钟`,
      },
      系统: {
        平台: platform(),
        系统版本: `${release()}（${osVersion()}）`.slice(0, 100),
        架构: arch(),
        CPU: c.length ? `${c[0].model.trim()} × ${c.length}` : '—',
        内存: `${gb(totalmem())}（可用 ${gb(freemem())}）`,
        时区: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    };
    let app: FeedbackEnv = {};
    let prof: FeedbackEnv = {};
    try {
      app = this.d.appEnv();
    } catch {
      app = {};
    }
    try {
      prof = this.d.profileEnv();
    } catch {
      prof = {};
    }
    const out: FeedbackEnv = { ...base };
    for (const [k, v] of Object.entries({ ...app, ...prof })) out[k] = { ...(out[k] ?? {}), ...v };
    return out;
  }

  /** 生成诊断包：所有文本用同一个 Masker（同一个 IP 始终是同一个 HOST_IP_n） */
  build(maskIps: boolean): { diagnostics: Diagnostics; markdown: string } {
    const m = new Masker({ maskIps, maskPii: true });
    // 先去掉服务端地址（预览和发送的内容一样，界面上不显示服务端地址），再脱敏
    const t = (s: string): string => m.mask(redactServers(s)).text;
    const env: FeedbackEnv = {};
    for (const [sec, items] of Object.entries(this.env())) {
      env[sec] = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, typeof v === 'string' ? t(v) : v]));
    }
    const maskEntry = (e: DiagEntry): DiagEntry => {
      const out: DiagEntry = { ...e, msg: t(e.msg) };
      if (e.data !== undefined) {
        try {
          out.data = JSON.parse(t(JSON.stringify(e.data)));
        } catch {
          out.data = t(String(e.data));
        }
      }
      return out;
    };
    const breadcrumbs = this.d.diag.entries().map(maskEntry);
    const errors = this.d.diag.errors(50).map(maskEntry);
    const logTail = t(this.d.diag.tail());
    const createdAt = this.now();
    const diagnostics: Diagnostics = { format: 'itm-diag', version: 1, createdAt, env, breadcrumbs, errors, logTail };
    return { diagnostics, markdown: this.markdown(diagnostics) };
  }

  /** 给 AI 看的 Markdown（不含用户的描述，描述在提交时由服务端 / 调用方加在前面） */
  markdown(x: Diagnostics, input?: Pick<FeedbackInput, 'title' | 'description' | 'category'>): string {
    const line = (e: DiagEntry): string => {
      const data = e.data === undefined ? '' : ` ${typeof e.data === 'string' ? e.data : JSON.stringify(e.data)}`;
      return `${relTime(e.t, x.createdAt).padStart(8)}  ${e.cat.padEnd(7)} ${e.level.padEnd(5)} ${e.msg}${data}`.slice(0, 1500);
    };
    const parts: string[] = [];
    parts.push('# iTerminal 诊断信息');
    parts.push(
      '> 给 AI 的说明：这是 iTerminal 桌面客户端（Electron：主进程负责连接、数据和 IPC，渲染进程是 React 界面，Agent 在独立的 utilityProcess 里运行）' +
        '自动收集的诊断信息。操作轨迹按时间排列，时间是相对提交时刻；分类：app 应用、ipc 界面调用主进程（通道名、耗时、结果）、event 主进程推送的状态、' +
        'ui 用户操作、console 界面日志、error 异常、net 访问服务端。敏感信息已经脱敏。请按时间线找出和问题相关的错误，定位根因并给出修复建议。',
    );
    if (input) {
      parts.push(`## 问题描述\n\n- 标题：${input.title}\n- 类型：${input.category}\n\n${input.description}`);
    }
    parts.push(
      `## 环境\n\n${Object.entries(x.env)
        .map(([sec, items]) => `### ${sec}\n${Object.entries(items).map(([k, v]) => `- ${k}：${v}`).join('\n')}`)
        .join('\n\n')}`,
    );
    parts.push(
      `## 最近的错误（${x.errors.length}）\n\n${
        x.errors.length
          ? x.errors
              .slice(-20)
              .reverse()
              .map((e) => {
                const stack = e.data && typeof e.data === 'object' && typeof (e.data as { stack?: unknown }).stack === 'string' ? (e.data as { stack: string }).stack : null;
                return `- \`${relTime(e.t, x.createdAt)}\` [${e.cat}] ${e.msg}${stack ? `\n\n  \`\`\`\n  ${stack.split('\n').join('\n  ')}\n  \`\`\`` : e.data !== undefined ? `\n  ${JSON.stringify(e.data).slice(0, 800)}` : ''}`;
              })
              .join('\n')
          : '没有记录到错误'
      }`,
    );
    const trail = x.breadcrumbs.slice(-TRAIL_IN_MD);
    parts.push(`## 操作轨迹（最近 ${trail.length} 条，共 ${x.breadcrumbs.length} 条）\n\n\`\`\`\n${trail.map(line).join('\n')}\n\`\`\``);
    parts.push(`## 日志尾部（main.log）\n\n\`\`\`\n${x.logTail.trim() || '（空）'}\n\`\`\``);
    return parts.join('\n\n');
  }

  private target(): { anonymous: boolean } {
    return { anonymous: !(this.d.profile().kind === 'account' && this.d.link()) };
  }

  preview(maskIps: boolean): FeedbackPreview {
    const { diagnostics, markdown } = this.build(maskIps);
    return {
      env: diagnostics.env,
      markdown,
      breadcrumbs: diagnostics.breadcrumbs.length,
      errors: diagnostics.errors.length,
      logBytes: Buffer.byteLength(diagnostics.logTail),
      target: this.target(),
    };
  }

  /** 截取窗口：超过 2MB 时转成 JPEG */
  async capture(owner: number): Promise<FeedbackImage> {
    const shot = await this.d.capture(owner);
    const stamp = new Date(this.now()).toTimeString().slice(0, 8).replace(/:/g, '');
    if (shot.png.length <= CAPTURE_JPEG_OVER) return { name: `截图-${stamp}.png`, type: 'image/png', data: shot.png.toString('base64'), size: shot.png.length };
    const jpg = shot.jpeg();
    return { name: `截图-${stamp}.jpg`, type: 'image/jpeg', data: jpg.toString('base64'), size: jpg.length };
  }

  private validate(input: FeedbackInput): void {
    if (!input || typeof input !== 'object') throw new UserError('反馈内容不正确');
    if (!String(input.title ?? '').trim()) throw new UserError('请填写标题');
    if (String(input.title).length > 100) throw new UserError('标题太长了（最多 100 字）');
    if (!String(input.description ?? '').trim()) throw new UserError('请描述一下遇到的问题');
    if (String(input.description).length > 5000) throw new UserError('描述太长了（最多 5000 字）');
    const images = Array.isArray(input.images) ? input.images : [];
    if (images.length > FEEDBACK_MAX_IMAGES) throw new UserError(`最多上传 ${FEEDBACK_MAX_IMAGES} 张图片`);
    for (const img of images) {
      if (!IMAGE_TYPES.includes(img?.type)) throw new UserError('只支持 PNG / JPG / GIF / WebP 图片');
      if (typeof img.data !== 'string' || (img.data.length * 3) / 4 > FEEDBACK_MAX_IMAGE_BYTES + 4) throw new UserError(`图片「${String(img.name).slice(0, 40)}」超过 5MB`);
    }
  }

  private async json<T>(res: Response): Promise<T> {
    const text = await res.text();
    type Envelope = { message?: string; msg?: string; data?: T };
    let j: Envelope | null = null;
    try {
      j = text ? (JSON.parse(text) as Envelope) : null;
    } catch {
      j = null;
    }
    const err = envelopeError(res.status, j);
    if (err) throw new UserError(err);
    if (j?.data === undefined || j?.data === null) throw new UserError(OLD_SERVER);
    return j.data as T;
  }

  async submit(input: FeedbackInput): Promise<{ id: number }> {
    this.validate(input);
    const target = this.target();
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>;
    const form = new FormData();
    let env: FeedbackEnv = {};
    if (input.includeDiagnostics) {
      const { diagnostics } = this.build(!!input.maskIps);
      env = diagnostics.env;
      const md = this.markdown(diagnostics, { title: input.title, description: input.description, category: input.category });
      form.append('diagnostics', new Blob([JSON.stringify(diagnostics)], { type: 'application/json' }), 'diagnostics.json');
      form.append('diagnosticsMd', new Blob([md], { type: 'text/markdown' }), 'diagnostics.md');
    } else {
      // 不附带诊断信息时也带上最基本的版本和系统（不含操作轨迹和日志）
      const e = this.env();
      env = { 应用: e['应用'] ?? {}, 系统: e['系统'] ?? {} };
    }
    form.append(
      'meta',
      JSON.stringify({
        category: input.category,
        title: input.title.trim(),
        description: input.description.trim(),
        contact: String(input.contact ?? '').trim().slice(0, 100),
        clientVersion: this.d.version,
        platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform,
        osVersion: release(),
        arch: arch(),
        env,
      }),
    );
    input.images.forEach((img, i) => {
      const buf = Buffer.from(img.data, 'base64');
      form.append('images', new Blob([new Uint8Array(buf)], { type: img.type }), String(img.name || `image-${i + 1}.${ext[img.type]}`).slice(0, 100));
    });
    let res: Response;
    const link = this.d.link();
    if (!target.anonymous && link) {
      res = await link.rawRequest('POST', '/api/v1/feedback', { body: form, timeoutMs: 120_000 });
    } else {
      const rawBase = this.d.anonymousServer();
      if (!rawBase) throw new UserError('未配置服务端地址，无法在线提交反馈；请先点「复制诊断信息」手动发送给管理员');
      const base = rawBase.replace(/\/+$/, '');
      try {
        res = await (this.d.fetchImpl ?? fetch)(`${base}/api/v1/public/feedback`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
      } catch (e) {
        throw new UserError(`连不上服务端：${redactServers((e as Error).message)}。可以先点「复制诊断信息」发给管理员`);
      }
    }
    const r = await this.json<{ id: number }>(res);
    this.d.diag.info('app', '提交了问题反馈', { id: r.id, images: input.images.length, diagnostics: input.includeDiagnostics });
    return { id: r.id };
  }

  async mine(): Promise<FeedbackRecord[]> {
    const link = this.d.link();
    if (!link || this.d.profile().kind !== 'account') return [];
    return (await this.json<FeedbackRecord[]>(await link.rawRequest('GET', '/api/v1/feedback/mine'))) ?? [];
  }
}
