import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillInfo } from '@itm/protocol';
import { estimateTokens } from '@itm/agent-core';
// 命名导入：默认导入在 CJS 入口下是 undefined（测试环境走的就是 CJS 入口）
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml';
import type { SkillParam, SkillRisk } from '@itm/protocol';
import { UserError } from '../../util/errors';

/** Skill 的名称（也是目录名）：字母、数字、- 和 _ */
export const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/**
 * 第十三轮到第二十二轮带过 10 个内置 Skill（以及 0.x / 1.0 写入的示例 host-health-check），第二十三轮去掉了。
 * 以前写进 Skill 目录、用户没改过的在第一次打开时删掉；改过的留下，当作用户自己的 Skill。
 * {skills}/.builtin.json 记着写入时的内容哈希；旧版示例没有记录，用它的内容哈希判断。
 */
const LEGACY_STATE = '.builtin.json';
const LEGACY_SAMPLE_SHA = '993d57023d0aafb6e00c2a2ef61cbd90de4e91d9c409a9ffda438164c462e796';

export interface Skill extends SkillInfo {
  content: string;
}

const sha = (s: string): string => createHash('sha256').update(s.replace(/\r\n/g, '\n').trimEnd()).digest('hex');

const RISKS: SkillRisk[] = ['readonly', 'write-needs-approval', 'dangerous'];
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : typeof v === 'string' && v ? [v] : []);

/**
 * 解析 SKILL.md（文档一 7.6）：YAML front matter + Markdown 正文。字段缺失或不合法时用默认值：
 * 单主机、只读、并发 4、出错继续、模型汇总。
 */
export function parseSkill(id: string, content: string): Skill {
  const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/.exec(content);
  let meta: Record<string, unknown> = {};
  if (fm) {
    try {
      const v = loadYaml(fm[1], { schema: JSON_SCHEMA });
      if (v && typeof v === 'object' && !Array.isArray(v)) meta = v as Record<string, unknown>;
    } catch {
      // front matter 写错了：当作没有，正文照样可用
    }
  }
  const str = (k: string): string | null => (typeof meta[k] === 'string' || typeof meta[k] === 'number' ? String(meta[k]).trim() || null : null);
  const params: SkillParam[] = Array.isArray(meta.params)
    ? (meta.params as unknown[])
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof (p as { name?: unknown }).name === 'string')
        .slice(0, 20)
        .map((p) => {
          const type = p.type === 'number' || p.type === 'boolean' ? p.type : 'string';
          const def = p.default;
          return {
            name: String(p.name),
            type,
            ...(def !== undefined && def !== null ? { default: type === 'number' ? Number(def) : type === 'boolean' ? def === true || def === 'true' : String(def) } : {}),
            ...(typeof p.description === 'string' ? { description: p.description } : {}),
          } as SkillParam;
        })
    : [];
  const name = str('name') ?? id;
  const concurrency = Number(meta.concurrency);
  return {
    id,
    name,
    title: str('title') ?? name,
    description: str('description') ?? '',
    version: str('version'),
    mode: meta.mode === 'parallel' ? 'parallel' : 'single',
    risk: RISKS.includes(meta.risk as SkillRisk) ? (meta.risk as SkillRisk) : 'readonly',
    concurrency: Number.isInteger(concurrency) && concurrency >= 1 ? Math.min(concurrency, 16) : 4,
    onError: meta['on-error'] === 'stop' ? 'stop' : 'continue',
    output: meta.output === 'raw' ? 'raw' : 'summary',
    hosts: strList(meta.hosts),
    params,
    allowedTools: strList(meta['allowed-tools']),
    triggers: strList(meta.triggers),
    content,
    tokens: estimateTokens(content),
  };
}

/**
 * 本地 Skill（文档一 7.6 的本地部分）：{档案目录}/skills/<目录>/SKILL.md，开头的 front matter 写 name 和 description。
 * 被引用时，正文追加到当轮用户消息里。
 */
export class SkillStore {
  private cleaned = false;

  constructor(readonly dir: string) {}

  /** 删掉以前版本写入、用户没改过的内置 Skill（见 LEGACY_STATE） */
  private removeLegacyBuiltins(): void {
    const stateFile = join(this.dir, LEGACY_STATE);
    const known: [string, string][] = [['host-health-check', LEGACY_SAMPLE_SHA]];
    if (existsSync(stateFile)) {
      try {
        const st = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, { hash?: unknown }>;
        for (const [name, v] of Object.entries(st ?? {})) if (typeof v?.hash === 'string' && v.hash) known.push([name, v.hash]);
      } catch {
        // 记录坏了：只按旧版示例判断
      }
    }
    for (const [name, hash] of known) {
      const file = join(this.dir, name, 'SKILL.md');
      if (!NAME_RE.test(name) || !existsSync(file)) continue;
      if (sha(readFileSync(file, 'utf8')) === hash) rmSync(join(this.dir, name), { recursive: true, force: true });
    }
    rmSync(stateFile, { force: true });
  }

  ensureDir(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    if (!this.cleaned) {
      this.cleaned = true;
      try {
        this.removeLegacyBuiltins();
      } catch {
        // 删不掉时不影响已有的 Skill
      }
    }
  }

  list(): Skill[] {
    this.ensureDir();
    const out: Skill[] = [];
    for (const name of readdirSync(this.dir)) {
      const file = join(this.dir, name, 'SKILL.md');
      try {
        if (!statSync(file).isFile() || statSync(file).size > 256 * 1024) continue;
      } catch {
        continue;
      }
      const content = readFileSync(file, 'utf8');
      out.push(parseSkill(name, content));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  get(id: string): Skill | null {
    return this.list().find((s) => s.id === id) ?? null;
  }

  /** 读取 SKILL.md 原文（编辑用） */
  read(id: string): string {
    if (!NAME_RE.test(id)) throw new UserError('Skill 不存在');
    const file = join(this.dir, id, 'SKILL.md');
    if (!existsSync(file)) throw new UserError('Skill 不存在');
    return readFileSync(file, 'utf8');
  }

  /**
   * 手动创建 / 修改 Skill：内容是完整的 SKILL.md。新建时用 front matter 里的 name 作为目录名（不能和已有的重名）；
   * 修改时目录不变。
   */
  save(id: string | null, content: string): Skill {
    if (typeof content !== 'string' || !content.trim()) throw new UserError('内容不能为空');
    if (Buffer.byteLength(content) > 256 * 1024) throw new UserError('SKILL.md 太大（最多 256KB）');
    if (!/^---\s*\r?\n[\s\S]*?\r?\n---/.test(content)) throw new UserError('开头需要用 --- 包起来的 front matter（至少写 name 和 description）');
    const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(content)!;
    let meta: Record<string, unknown>;
    try {
      meta = (loadYaml(fm[1], { schema: JSON_SCHEMA }) ?? {}) as Record<string, unknown>;
    } catch (e) {
      throw new UserError(`front matter 不是合法的 YAML：${(e as Error).message.split('\n')[0]}`);
    }
    const name = typeof meta.name === 'string' ? meta.name.trim() : '';
    if (!NAME_RE.test(name)) throw new UserError('name 只能用字母、数字、- 和 _，例如 nginx-reload');
    if (typeof meta.description !== 'string' || !meta.description.trim()) throw new UserError('请填写 description（一句话说明这个 Skill 做什么，Agent 根据它决定是否使用）');
    this.ensureDir();
    const dir = id ?? name;
    if (!NAME_RE.test(dir)) throw new UserError('Skill 不存在');
    if (!id && existsSync(join(this.dir, dir))) throw new UserError(`已经有名为「${dir}」的 Skill`);
    if (id && !existsSync(join(this.dir, dir, 'SKILL.md'))) throw new UserError('Skill 不存在');
    mkdirSync(join(this.dir, dir), { recursive: true });
    writeFileSync(join(this.dir, dir, 'SKILL.md'), content.endsWith('\n') ? content : `${content}\n`);
    return parseSkill(dir, readFileSync(join(this.dir, dir, 'SKILL.md'), 'utf8'));
  }

  /**
   * 备份恢复 / 分享导入（第二十二轮）：直接写入 SKILL.md（覆盖同名的）。内容要有 front matter；目录名就是 id
   */
  writeRaw(id: string, content: string): void {
    if (!NAME_RE.test(id)) throw new UserError(`Skill 名称不正确：${id}`);
    if (typeof content !== 'string' || !/^---\s*\r?\n/.test(content)) throw new UserError(`Skill「${id}」的内容不正确`);
    if (Buffer.byteLength(content) > 256 * 1024) throw new UserError(`Skill「${id}」太大（最多 256KB）`);
    this.ensureDir();
    mkdirSync(join(this.dir, id), { recursive: true });
    writeFileSync(join(this.dir, id, 'SKILL.md'), content.endsWith('\n') ? content : `${content}\n`);
  }

  /** 覆盖恢复时去掉本机多出来的 Skill */
  removeForRestore(id: string): void {
    if (!NAME_RE.test(id) || !existsSync(join(this.dir, id, 'SKILL.md'))) return;
    rmSync(join(this.dir, id), { recursive: true, force: true });
  }

  /** 删除 Skill（整个目录） */
  delete(id: string): void {
    if (!NAME_RE.test(id) || !existsSync(join(this.dir, id, 'SKILL.md'))) throw new UserError('Skill 不存在');
    rmSync(join(this.dir, id), { recursive: true, force: true });
  }

  /** 按 ID 或名称查找（不区分大小写），skill_load 工具使用 */
  find(nameOrId: string): Skill | null {
    const k = nameOrId.trim().toLowerCase();
    return this.list().find((s) => s.id.toLowerCase() === k || s.name.toLowerCase() === k) ?? null;
  }
}
