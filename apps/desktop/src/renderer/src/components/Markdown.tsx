import { Children, isValidElement, useRef, useState, type ComponentProps } from 'react';
import { Button, Tooltip } from 'antd';
import { CheckOutlined, CopyOutlined } from '@ant-design/icons';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const LANG_LABEL: Record<string, string> = { sh: 'shell', bash: 'bash', zsh: 'zsh', shell: 'shell', console: 'shell', text: '文本', txt: '文本', plaintext: '文本' };

/** 复制到剪贴板，按钮短暂显示「已复制」 */
export function CopyButton({ text, title = '复制', testId, className }: { text: () => string; title?: string; testId?: string; className?: string }): React.JSX.Element {
  const [done, setDone] = useState(false);
  return (
    <Tooltip title={done ? '已复制' : title}>
      <Button
        size="small"
        type="text"
        className={className}
        icon={done ? <CheckOutlined /> : <CopyOutlined />}
        aria-label={title}
        data-testid={testId}
        onClick={() =>
          void navigator.clipboard.writeText(text()).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
        }
      />
    </Tooltip>
  );
}

/** 代码块（sh、shell、文本块等）：右上角显示语言和复制按钮 */
function CodeBlock({ children, node: _node, ...rest }: ComponentProps<'pre'> & { node?: unknown }): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null);
  const first = Children.toArray(children)[0];
  const cls = isValidElement<{ className?: string }>(first) ? (first.props.className ?? '') : '';
  const lang = /language-([\w+#.-]+)/.exec(cls)?.[1]?.toLowerCase() ?? '';
  return (
    <div className="code-block" data-testid="code-block">
      <div className="code-block-bar">
        <span className="code-lang">{LANG_LABEL[lang] ?? (lang || '文本')}</span>
        <CopyButton text={() => (ref.current?.textContent ?? '').replace(/\n$/, '')} title="复制代码" testId="code-copy" />
      </div>
      <pre ref={ref} {...rest}>
        {children}
      </pre>
    </div>
  );
}

export const MD_COMPONENTS: Components = { pre: CodeBlock };

/** Markdown 渲染（GFM）：代码块带复制按钮 */
export function Markdown({ text, className = '' }: { text: string; className?: string }): React.JSX.Element {
  return (
    <div className={`md selectable ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
