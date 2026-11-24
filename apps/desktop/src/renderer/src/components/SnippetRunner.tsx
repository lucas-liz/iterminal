import { useEffect, useMemo, useState } from 'react';
import { Alert, App, Checkbox, Form, Input, Modal, Radio, Space, Typography } from 'antd';
import { fillSnippet, snippetVars } from '@itm/protocol';
import { currentTerminal, readyTerminals, sendToTerminals, useLibrary } from '../store/library';
import { useTabs } from '../store/tabs';
import { useApp } from '../store/app';
import { FormSection } from './FormSection';

/**
 * 发送快捷命令（文档一 6.14）：填写 {{变量}}、预览最终命令、选择发到当前终端还是广播到多个终端。
 */
export function SnippetRunner(): React.JSX.Element {
  const { message } = App.useApp();
  const running = useLibrary((s) => s.running);
  const tabs = useTabs((s) => s.tabs);
  const terminals = readyTerminals(tabs);
  const [values, setValues] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<string[]>([]);
  const [execute, setExecute] = useState(true);
  const vars = useMemo(() => (running ? snippetVars(running.snippet.content) : []), [running]);

  useEffect(() => {
    if (!running) return;
    setValues(Object.fromEntries(vars.map((v) => [v.name, v.defaultValue])));
    const cur = currentTerminal();
    setTargets(running.broadcast ? readyTerminals().map((t) => t.id) : cur ? [cur.id] : []);
    setExecute(running.execute);
  }, [running]);

  const command = running ? fillSnippet(running.snippet.content, values) : '';
  const close = (): void => useLibrary.getState().closeRunner();

  return (
    <Modal
      open={!!running}
      title={running ? `发送快捷命令「${running.snippet.name}」` : ''}
      okText={targets.length > 1 ? `发送到 ${targets.length} 个终端` : '发送'}
      cancelText="取消"
      okButtonProps={{ disabled: targets.length === 0 || !command.trim(), 'data-testid': 'snippet-run-ok' } as never}
      onCancel={close}
      onOk={() => {
        const n = sendToTerminals(targets, command, execute);
        message.success(`已发送到 ${n} 个终端`);
        close();
        if (useApp.getState().page !== 'workspace') useApp.getState().setPage('workspace');
      }}
      width={600}
      destroyOnHidden
    >
      {vars.length > 0 && (
        <FormSection title="填写变量">
          <Form layout="vertical">
            {vars.map((v, i) => (
              <Form.Item key={v.name} label={v.name}>
                <Input
                  autoFocus={i === 0}
                  value={values[v.name] ?? ''}
                  placeholder={v.defaultValue ? `默认：${v.defaultValue}` : ''}
                  onChange={(e) => setValues((x) => ({ ...x, [v.name]: e.target.value }))}
                  data-testid={`snippet-var-${v.name}`}
                />
              </Form.Item>
            ))}
          </Form>
        </FormSection>
      )}
      <FormSection title="将要发送的命令">
        <pre className="snippet-preview mono selectable" data-testid="snippet-preview">
          {command}
        </pre>
        <Checkbox checked={execute} onChange={(e) => setExecute(e.target.checked)} style={{ marginBottom: 12 }}>
          发送后执行（末尾追加回车）
        </Checkbox>
      </FormSection>
      <FormSection title={running?.broadcast ? '广播到这些终端' : '发送到'}>
        {terminals.length === 0 ? (
          <Alert type="warning" showIcon message="没有已连接的终端，请先打开一个终端" style={{ marginBottom: 12 }} />
        ) : running?.broadcast ? (
          <Checkbox.Group
            value={targets}
            onChange={(v) => setTargets(v as string[])}
            options={terminals.map((t) => ({ value: t.id, label: t.title }))}
            style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}
          />
        ) : (
          <Radio.Group value={targets[0]} onChange={(e) => setTargets([e.target.value as string])} style={{ marginBottom: 12 }}>
            <Space direction="vertical">
              {terminals.map((t) => (
                <Radio key={t.id} value={t.id}>
                  {t.title}
                  {t.id === currentTerminal()?.id && <Typography.Text type="secondary">（当前）</Typography.Text>}
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        )}
      </FormSection>
    </Modal>
  );
}
