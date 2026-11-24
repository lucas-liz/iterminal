// 极简 Markdown 渲染（问题反馈的 AI 分析结果用）：先转义 HTML，再处理标题、列表、代码块、粗体、行内代码、引用。
// 不支持表格以外的复杂语法；表格按原样等宽显示。
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const inline = (s) =>
  esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

export function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let list = null
  let code = null
  const closeList = () => {
    if (list) out.push(list === 'ol' ? '</ol>' : '</ul>')
    list = null
  }
  for (const line of lines) {
    if (code !== null) {
      if (/^```/.test(line)) {
        out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>')
        code = null
      } else code.push(line)
      continue
    }
    if (/^```/.test(line)) {
      closeList()
      code = []
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      closeList()
      const n = Math.min(h[1].length + 2, 6)
      out.push(`<h${n}>${inline(h[2])}</h${n}>`)
      continue
    }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol'
      if (list !== kind) {
        closeList()
        out.push(kind === 'ol' ? '<ol>' : '<ul>')
        list = kind
      }
      out.push('<li>' + inline((ul || ol)[1]) + '</li>')
      continue
    }
    closeList()
    if (/^>\s?/.test(line)) out.push('<blockquote>' + inline(line.replace(/^>\s?/, '')) + '</blockquote>')
    else if (/^\|/.test(line)) out.push('<pre class="md-table">' + esc(line) + '</pre>')
    else if (line.trim()) out.push('<p>' + inline(line) + '</p>')
  }
  if (code !== null) out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>')
  closeList()
  return out.join('\n')
}
