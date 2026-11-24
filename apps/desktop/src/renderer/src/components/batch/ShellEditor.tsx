import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderExt } from '@codemirror/view';
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type StringStream } from '@codemirror/language';
import { tags } from '@lezer/highlight';

/** 外部操作编辑器：从模板插入、重新执行时整体替换 */
export interface ShellEditorApi {
  insert(text: string): void;
  replaceAll(text: string): void;
  focus(): void;
}

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', 'function', 'return', 'exit', 'export', 'local', 'select', 'time']);
const BUILTINS = new Set(['echo', 'cd', 'ls', 'cat', 'grep', 'awk', 'sed', 'find', 'xargs', 'sudo', 'systemctl', 'docker', 'kubectl', 'tail', 'head', 'df', 'du', 'ps', 'kill', 'chmod', 'chown', 'mkdir', 'rm', 'cp', 'mv', 'tar', 'curl', 'wget', 'printf', 'read', 'test', 'source', 'set', 'unset']);

/** 简单的 Shell 语法高亮：注释、字符串、变量、关键字、常用命令 */
/** 读字符串直到结束引号（可以跨行：行尾还没结束时下一行继续） */
function readString(stream: StringStream, state: { inString: string | null }): string {
  while (!stream.eol()) {
    const ch = stream.next();
    if (ch === '\\' && state.inString === '"') stream.next();
    else if (ch === state.inString) {
      state.inString = null;
      break;
    }
  }
  return 'string';
}

const shell = StreamLanguage.define<{ inString: string | null }>({
  name: 'shell',
  startState: () => ({ inString: null }),
  copyState: (s) => ({ ...s }),
  token(stream: StringStream, state) {
    if (state.inString) return readString(stream, state);
    if (stream.eatSpace()) return null;
    if (stream.peek() === '#' && (stream.sol() || /\s/.test(stream.string.charAt(stream.pos - 1)))) {
      stream.skipToEnd();
      return 'comment';
    }
    const ch = stream.next()!;
    if (ch === '"' || ch === "'") {
      state.inString = ch;
      return readString(stream, state);
    }
    if (ch === '$') {
      if (stream.eat('{')) stream.skipTo('}') && stream.next();
      else if (stream.eat('(')) return 'keyword';
      else stream.eatWhile(/[\w@#?*!$-]/);
      return 'variableName.special';
    }
    if (/\d/.test(ch)) {
      stream.eatWhile(/[\d.]/);
      return 'number';
    }
    if (/[|&;<>]/.test(ch)) {
      stream.eatWhile(/[|&;<>]/);
      return 'operator';
    }
    if (/[\w./-]/.test(ch)) {
      stream.eatWhile(/[\w./-]/);
      const w = stream.current();
      if (KEYWORDS.has(w)) return 'keyword';
      if (BUILTINS.has(w)) return 'typeName';
      if (w.startsWith('-')) return 'attributeName';
      return null;
    }
    return null;
  },
});

/** 固定深色（和终端一致），浅色界面里也是深色编辑区 */
const HIGHLIGHT = HighlightStyle.define([
  { tag: tags.keyword, color: '#c792ea', fontWeight: '600' },
  { tag: tags.string, color: '#c3e88d' },
  { tag: tags.number, color: '#f78c6c' },
  { tag: tags.comment, color: '#6a737d', fontStyle: 'italic' },
  { tag: tags.special(tags.variableName), color: '#82aaff' },
  { tag: tags.typeName, color: '#89ddff' },
  { tag: tags.operator, color: '#ffcb6b' },
  { tag: tags.attributeName, color: '#f2c97d' },
]);

const THEME = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '13px', backgroundColor: '#1e1f22', color: '#d6d6d6' },
    '.cm-scroller': { fontFamily: 'Menlo, "SF Mono", Consolas, "DejaVu Sans Mono", monospace', lineHeight: '1.6' },
    '.cm-gutters': { backgroundColor: '#1e1f22', color: '#5c6370', border: 'none', borderRight: '1px solid #2c2e33' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.04)' },
    '.cm-activeLineGutter': { backgroundColor: 'rgba(255,255,255,0.04)', color: '#9da5b4' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: '#e6e6e6' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'rgba(97, 175, 239, 0.28) !important' },
    '.cm-placeholder': { color: '#5c6370' },
    '.cm-panels': { backgroundColor: '#25262b', color: '#d6d6d6' },
    '.cm-tooltip': { backgroundColor: '#25262b', border: '1px solid #3a3d44', color: '#d6d6d6' },
  },
  { dark: true },
);

/**
 * 批量执行的命令编辑器（第三十五轮）：CodeMirror 6 + 简单的 Shell 高亮，⌘ / Ctrl + Enter 执行。
 */
export function ShellEditor({
  value,
  onChange,
  onRun,
  apiRef,
  placeholder,
  testId = 'batch-editor-content',
}: {
  value: string;
  onChange(v: string): void;
  onRun?(): void;
  apiRef?: (api: ShellEditorApi | null) => void;
  placeholder?: string;
  testId?: string;
}): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const handlers = useRef({ onChange, onRun });
  handlers.current = { onChange, onRun };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          shell,
          syntaxHighlighting(HIGHLIGHT),
          THEME,
          placeholderExt(placeholder ?? ''),
          Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => (handlers.current.onRun?.(), true) }])),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString());
          }),
          EditorView.contentAttributes.of({ 'data-testid': testId, spellcheck: 'false' }),
        ],
      }),
    });
    view.current = v;
    apiRef?.({
      insert: (text) => {
        const r = v.state.selection.main;
        v.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length } });
        v.focus();
      },
      replaceAll: (text) => {
        v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
        v.focus();
      },
      focus: () => v.focus(),
    });
    return () => {
      apiRef?.(null);
      v.destroy();
      view.current = null;
    };
    // 只在挂载时创建；外部改值用 apiRef
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 父组件清空（重置）时同步
  useEffect(() => {
    const v = view.current;
    if (v && value !== v.state.doc.toString()) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} className="shell-editor" />;
}
