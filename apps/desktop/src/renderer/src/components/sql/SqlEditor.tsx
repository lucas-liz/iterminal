import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { MySQL, PostgreSQL, SQLite, sql } from '@codemirror/lang-sql';
import { tags } from '@lezer/highlight';
import { closeCompletion } from '@codemirror/autocomplete';

export type SqlDialectName = 'mysql' | 'postgres' | 'sqlite';

/** 外部操作编辑器（执行选中 / 当前语句、AI 结果替换或插入） */
export interface SqlEditorApi {
  value(): string;
  selection(): { text: string; from: number; to: number };
  cursor(): number;
  /** 替换选中的部分（没有选中时在光标处插入） */
  insert(text: string): void;
  replaceAll(text: string): void;
  /** 选中一段（执行出错时定位语句） */
  select(from: number, to: number): void;
  focus(): void;
}

/** 语法颜色：用主题变量，深色 / 浅色界面都能看清 */
const HIGHLIGHT = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--itm-primary)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--itm-log-success)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--itm-log-warn)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--itm-text-secondary)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.standard(tags.name), tags.function(tags.variableName)], color: 'var(--itm-log-info)' },
  { tag: [tags.special(tags.name), tags.quote], color: 'var(--itm-log-error)' },
]);

const THEME = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--itm-input-bg)', color: 'var(--itm-text)' },
  '.cm-scroller': { fontFamily: 'Menlo, "SF Mono", Consolas, "DejaVu Sans Mono", monospace', lineHeight: '1.55' },
  '.cm-gutters': { backgroundColor: 'var(--itm-section-bg)', color: 'var(--itm-text-secondary)', border: 'none', borderRight: '1px solid var(--itm-border)' },
  '.cm-activeLine': { backgroundColor: 'var(--itm-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--itm-hover)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--itm-text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--itm-primary-soft) !important' },
  '.cm-tooltip': { backgroundColor: 'var(--itm-elevated-bg)', border: '1px solid var(--itm-border-strong)', color: 'var(--itm-text)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--itm-primary)', color: '#fff' },
  '.cm-panels': { backgroundColor: 'var(--itm-section-bg)', color: 'var(--itm-text)' },
  '.cm-placeholder': { color: 'var(--itm-text-secondary)' },
});

const DIALECTS = { mysql: MySQL, postgres: PostgreSQL, sqlite: SQLite } as const;

/**
 * SQL 编辑器（第十八轮，文档一 6.32.1）：CodeMirror 6 + SQL 方言；补全关键字、表名、`表.` 后面的列名。
 * ⌘ / Ctrl + Enter 执行（选中的部分或光标所在语句），⇧ + ⌘ / Ctrl + Enter 执行全部。
 */
export function SqlEditor({
  value,
  onChange,
  dialect,
  schema,
  defaultTable,
  onRun,
  onRunAll,
  apiRef,
  placeholder,
  minHeight = 140,
  testId,
}: {
  value: string;
  onChange(v: string): void;
  dialect: SqlDialectName;
  /** 表名 → 列名（补全用） */
  schema: Record<string, string[]>;
  /** 只有一张表时，补全不带表名的列 */
  defaultTable?: string;
  onRun?(): void;
  onRunAll?(): void;
  apiRef?: (api: SqlEditorApi | null) => void;
  placeholder?: string;
  minHeight?: number;
  testId?: string;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  const handlers = useRef({ onChange, onRun, onRunAll });
  handlers.current = { onChange, onRun, onRunAll };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          lang.current.of(sql({ dialect: DIALECTS[dialect], schema, defaultTable, upperCaseKeywords: true })),
          syntaxHighlighting(HIGHLIGHT),
          THEME,
          placeholderExt(placeholder ?? ''),
          Prec.highest(
            keymap.of([
              { key: 'Mod-Enter', run: () => (handlers.current.onRun?.(), true) },
              { key: 'Shift-Mod-Enter', run: () => (handlers.current.onRunAll?.(), true) },
            ]),
          ),
          // 点到编辑器外面（按钮、其他输入框）时收起补全列表，不让它留在别处
          EditorView.domEventHandlers({ blur: (_e, v) => (closeCompletion(v), false) }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ 'data-testid': testId ?? 'sql-editor-content', spellcheck: 'false' }),
        ],
      }),
    });
    view.current = v;
    apiRef?.({
      value: () => v.state.doc.toString(),
      selection: () => {
        const r = v.state.selection.main;
        return { text: v.state.sliceDoc(r.from, r.to), from: r.from, to: r.to };
      },
      cursor: () => v.state.selection.main.head,
      insert: (text) => {
        const r = v.state.selection.main;
        v.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length } });
        v.focus();
      },
      replaceAll: (text) => {
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
        v.focus();
      },
      select: (from, to) => {
        const n = v.state.doc.length;
        v.dispatch({ selection: { anchor: Math.min(from, n), head: Math.min(to, n) }, scrollIntoView: true });
        v.focus();
      },
      focus: () => v.focus(),
    });
    return () => {
      apiRef?.(null);
      v.destroy();
      view.current = null;
    };
    // 编辑器只创建一次；方言、补全、外部改动的内容在下面更新
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(sql({ dialect: DIALECTS[dialect], schema, defaultTable, upperCaseKeywords: true })) });
  }, [dialect, schema, defaultTable]);

  // 外部替换了内容（切换标签、AI 结果）：同步到编辑器
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} className="sql-editor" style={{ minHeight }} data-testid={testId ? `${testId}-wrap` : 'sql-editor'} />;
}
