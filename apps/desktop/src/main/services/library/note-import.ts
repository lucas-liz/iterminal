import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml';
import type { Note, NoteFormat } from '@itm/protocol';
import type { NoteRepo } from './note-repo';

/** 可以导入成笔记的文件（第二十二轮） */
export const NOTE_IMPORT_EXT = ['md', 'markdown', 'mdown', 'mkd', 'txt'];
/** Word 文档（第二十六轮）：.docx 转成 Markdown（保留标题、列表、表格、粗体），.doc 只取文字 */
export const NOTE_WORD_EXT = ['docx', 'doc'];
/** Word 文件本身可以大一些（图片占大头，导入时图片换成「（图片）」） */
const MAX_WORD_BYTES = 30 * 1024 * 1024;
const MAX_FILES = 200;
/** 和笔记的长度上限一致（1MB） */
const MAX_BYTES = 1024 * 1024;
const MAX_TITLE = 200;

/**
 * 一个 Markdown / 文本文件 → 笔记：标题取 front matter 的 title，其次是开头的一级标题（# 标题），最后是文件名；
 * 正文原样保留（不删 front matter 和标题，导出再导入不丢内容）。
 */
export function noteFromFile(fileName: string, raw: string): { title: string; content: string; format: NoteFormat } {
  const content = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const ext = extname(fileName).slice(1).toLowerCase();
  let title = '';
  const fm = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
  if (fm) {
    try {
      const meta = loadYaml(fm[1], { schema: JSON_SCHEMA }) as Record<string, unknown> | null;
      if (meta && typeof meta.title === 'string') title = meta.title.trim();
    } catch {
      // front matter 写错了：当作正文
    }
  }
  if (!title) {
    const body = fm ? content.slice(fm[0].length) : content;
    const first = body.split('\n').find((l) => l.trim());
    const h1 = first && /^#\s+(.+?)\s*#*\s*$/.exec(first.trim());
    if (h1) title = h1[1].trim();
  }
  if (!title) title = basename(fileName, extname(fileName)).trim();
  return { title: (title || '无标题').slice(0, MAX_TITLE), content, format: ext === 'txt' ? 'TEXT' : 'MARKDOWN' };
}

export interface NoteImportResult {
  notes: Note[];
  skipped: { name: string; reason: string }[];
}

/** .docx → Markdown：mammoth 转成 HTML（图片换成占位），再用 turndown（GFM 表格）转成 Markdown */
export async function docxToMarkdown(path: string): Promise<string> {
  const mammoth = await import('mammoth');
  const { default: TurndownService } = await import('turndown');
  const { gfm } = (await import('turndown-plugin-gfm')) as unknown as { gfm: (s: unknown) => void };
  const r = await mammoth.convertToHtml({ path }, { convertImage: mammoth.images.imgElement(async () => ({ src: '', alt: '图片' })) });
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.use(gfm);
  td.addRule('image-placeholder', { filter: 'img', replacement: () => '（图片）' });
  // Word 的表格没有表头行（mammoth 只输出 td）：第一行当表头，转成 GFM 表格；单元格里只取文字
  td.addRule('docx-table', {
    filter: 'table',
    replacement: (_content, node) => {
      type El = { querySelectorAll(s: string): ArrayLike<El>; textContent: string | null };
      const rows = Array.from((node as El).querySelectorAll('tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td, th')).map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()),
      );
      if (!rows.length) return '';
      const cols = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]): string => `| ${Array.from({ length: cols }, (_, i) => r[i] ?? '').join(' | ')} |`;
      return `\n\n${[line(rows[0]), line(rows[0].map(() => '---').concat(Array(cols - rows[0].length).fill('---'))), ...rows.slice(1).map(line)].join('\n')}\n\n`;
    },
  });
  return td.turndown(r.value).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** .doc（Word 97–2003）：只取正文文字 */
export async function docToText(path: string): Promise<string> {
  const { default: WordExtractor } = (await import('word-extractor')) as unknown as { default: new () => { extract(p: string): Promise<{ getBody(): string }> } };
  const doc = await new WordExtractor().extract(path);
  return doc.getBody().replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** 把选中的文件导入成笔记（放进 groupId 分组）；不支持的、太大的、读不了的文件跳过并说明原因 */
export async function importNoteFiles(repo: NoteRepo, paths: string[], groupId: string | null): Promise<NoteImportResult> {
  const out: NoteImportResult = { notes: [], skipped: [] };
  for (const p of paths.slice(0, MAX_FILES)) {
    const name = basename(String(p));
    const ext = extname(name).slice(1).toLowerCase();
    try {
      const word = NOTE_WORD_EXT.includes(ext);
      if (!word && !NOTE_IMPORT_EXT.includes(ext)) {
        out.skipped.push({ name, reason: '不是 Markdown / 文本 / Word 文件' });
        continue;
      }
      const st = statSync(p);
      if (!st.isFile()) {
        out.skipped.push({ name, reason: '不是文件' });
        continue;
      }
      if (st.size > (word ? MAX_WORD_BYTES : MAX_BYTES)) {
        out.skipped.push({ name, reason: word ? '超过 30MB' : '超过 1MB' });
        continue;
      }
      if (word) {
        const text = ext === 'docx' ? await docxToMarkdown(p) : await docToText(p);
        if (!text.trim()) {
          out.skipped.push({ name, reason: '没有读到文字' });
          continue;
        }
        if (Buffer.byteLength(text) > MAX_BYTES) {
          out.skipped.push({ name, reason: '转换后的文字超过 1MB' });
          continue;
        }
        // 标题：开头的一级标题，没有时用文件名（.doc 没有格式，用文件名）
        const n = noteFromFile(`${basename(name, extname(name))}.md`, ext === 'docx' ? text : text);
        out.notes.push(repo.save(null, { groupId, title: ext === 'doc' ? basename(name, extname(name)) : n.title, content: n.content, format: 'MARKDOWN' }));
        continue;
      }
      const n = noteFromFile(name, readFileSync(p, 'utf8'));
      out.notes.push(repo.save(null, { groupId, title: n.title, content: n.content, format: n.format }));
    } catch (e) {
      out.skipped.push({ name, reason: (e as Error).message.slice(0, 120) });
    }
  }
  if (paths.length > MAX_FILES) out.skipped.push({ name: `其余 ${paths.length - MAX_FILES} 个文件`, reason: `一次最多导入 ${MAX_FILES} 个` });
  return out;
}
