import { useState } from 'react';
import { App, Button, Tooltip } from 'antd';
import { CopyOutlined, DownloadOutlined, TableOutlined } from '@ant-design/icons';
import type { DbResultTable } from '@itm/protocol';
import { errorMessage, invoke } from '../../api';

/** 收起时显示的行数 */
const FOLD_ROWS = 20;
/** 单元格最多显示的字符（悬停看全文） */
const CELL_CHARS = 120;

/** Markdown 表格（竖线转义，换行换成空格） */
export function tableToMarkdown(t: Pick<DbResultTable, 'columns' | 'rows'>): string {
  const esc = (v: string | null): string => (v === null ? 'NULL' : v.replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
  return [`| ${t.columns.map(esc).join(' | ')} |`, `| ${t.columns.map(() => '---').join(' | ')} |`, ...t.rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n');
}

/** CSV（RFC 4180） */
export function tableToCsv(t: Pick<DbResultTable, 'columns' | 'rows'>): string {
  const q = (v: string | null): string => (v === null ? '' : /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [t.columns, ...t.rows].map((r) => r.map(q).join(',')).join('\n');
}

/**
 * 数据库查询的结果卡片（第十七轮，文档一 6.31.6）：表头固定、左右滚动、NULL 灰色显示、长单元格省略；
 * 复制为 Markdown / CSV，导出 CSV（UTF-8 带 BOM）。显示的是原值（发给模型的那份已脱敏）。
 */
export function DbResultView({
  table,
  summary,
  name,
  fill = false,
  actions,
}: {
  table: DbResultTable;
  summary: string;
  name: string;
  /** SQL 工作台：不折叠，表格占满结果区 */
  fill?: boolean;
  /** 底栏额外的按钮（工作台的「导出全部」） */
  actions?: React.ReactNode;
}): React.JSX.Element {
  const { message } = App.useApp();
  const [all, setAll] = useState(false);
  const rows = all || fill ? table.rows : table.rows.slice(0, FOLD_ROWS);
  const copy = (text: string, what: string): void => {
    void navigator.clipboard.writeText(text).then(() => message.success(`已复制为 ${what}`));
  };
  const exportCsv = async (): Promise<void> => {
    const path = await invoke('dialog.saveFile', { title: '导出查询结果', defaultName: `${name.replace(/[\\/:*?"<>|]/g, '_')}-查询结果.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (!path) return;
    try {
      await invoke('db.exportCsv', { path, columns: table.columns, rows: table.rows });
      message.success(`已导出到 ${path}`);
    } catch (e) {
      message.error(errorMessage(e));
    }
  };
  return (
    <div className={`db-result ${fill ? 'fill' : ''}`} data-testid="db-result">
      {table.columns.length > 0 && (
        <div className="db-result-scroll">
          <table className="db-grid mono selectable" data-testid="db-grid">
            <thead>
              <tr>
                <th className="db-rownum">#</th>
                {table.columns.map((c, i) => (
                  <th key={i}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="db-rownum">{i + 1}</td>
                  {r.map((v, j) =>
                    v === null ? (
                      <td key={j} className="db-null">
                        NULL
                      </td>
                    ) : (
                      <td key={j} title={v.length > CELL_CHARS ? v : undefined}>
                        {v.length > CELL_CHARS ? `${v.slice(0, CELL_CHARS)}…` : v}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="db-result-foot">
        <TableOutlined />
        <span className="db-result-summary" data-testid="db-result-summary">
          {summary}
        </span>
        {!fill && table.rows.length > FOLD_ROWS && (
          <Button type="link" size="small" onClick={() => setAll((v) => !v)} data-testid="db-result-more">
            {all ? '收起' : `显示全部 ${table.rows.length} 行`}
          </Button>
        )}
        {table.columns.length > 0 && (
          <span className="db-result-actions">
            <Tooltip title="复制为 Markdown 表格">
              <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => copy(tableToMarkdown(table), 'Markdown')} data-testid="db-copy-md">
                Markdown
              </Button>
            </Tooltip>
            <Tooltip title="复制为 CSV（可以直接粘贴到 Excel）">
              <Button size="small" type="text" icon={<CopyOutlined />} onClick={() => copy(tableToCsv(table), 'CSV')} data-testid="db-copy-csv">
                CSV
              </Button>
            </Tooltip>
            <Tooltip title={fill ? '把显示的这些行导出为 CSV 文件' : '导出为 CSV 文件'}>
              <Button size="small" type="text" icon={<DownloadOutlined />} onClick={() => void exportCsv()} data-testid="db-export-csv" aria-label="导出 CSV" />
            </Tooltip>
            {actions}
          </span>
        )}
      </div>
    </div>
  );
}
