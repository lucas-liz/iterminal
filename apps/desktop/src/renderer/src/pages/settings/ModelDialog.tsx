import { useMemo, useState } from 'react';
import { App, Button, Input, InputNumber, Modal, Segmented, Select, Tooltip, Typography } from 'antd';
import { CheckOutlined, ExperimentOutlined, LoadingOutlined, UndoOutlined } from '@ant-design/icons';
import {
  EFFORTS,
  EFFORT_LABEL,
  thinkingControlOf,
  type AiModelConfig,
  type AiProviderInput,
  type AiProviderType,
  type Effort,
  type ModelProbe,
  type ModelProbeResult,
  type ThinkingControl,
  type ThinkingStyle,
} from '@itm/protocol';
import { errorMessage, invoke } from '../../api';
import { formatTokens, parseTokens } from '../../util/model-tokens';

const CONTEXT_CHIPS = [128_000, 200_000, 256_000, 500_000, 1_000_000];
const OUTPUT_CHIPS = [8192, 32_768, 65_536, 131_072];
const CONTROL_OPTIONS: { value: ThinkingControl; label: string }[] = [
  { value: 'effort', label: '自适应档位' },
  { value: 'budget', label: 'Token 预算' },
  { value: 'toggle', label: '仅开关' },
];
const CONTROL_HINT: Record<ThinkingControl, string> = {
  effort: '按档位发送思考强度（reasoning_effort / effort），模型自己决定想多久',
  budget: '把档位换算成思考 token 数（低 2K、中 8K、高 16K、超高 32K、最高 64K，不超过最大输出的一半）',
  toggle: '只能开启或关闭思考，不发强度',
};

/** 检测结果里的能力简写：✓ 支持、✗ 不支持、? 没能判断 */
export function probeSummary(p: Pick<ModelProbe, 'images' | 'tools' | 'reasoning'>): string {
  const mark = (v: boolean | null | undefined): string => (v === true ? '✓' : v === false ? '✗' : '?');
  return `${mark(p.images)}图 ${mark(p.tools)}工具 ${mark(p.reasoning === null || p.reasoning === undefined ? null : p.reasoning !== 'none')}思考`;
}

/** 把检测结果套到模型配置上（没能判断的项保持原样） */
function applyProbe(m: AiModelConfig, p: ModelProbe): AiModelConfig {
  const next: AiModelConfig = { ...m };
  if (p.contextWindow) {
    next.contextWindow = p.contextWindow;
    if (next.maxOutput > p.contextWindow) next.maxOutput = Math.min(next.maxOutput, Math.floor(p.contextWindow / 2));
  }
  if (p.images !== null) next.supportsImages = p.images;
  if (p.images && p.imageFormat) next.imageFormat = p.imageFormat === 'base64' ? 'base64' : null;
  if (p.tools !== null) next.supportsTools = p.tools;
  if (p.reasoning) next.reasoning = p.reasoning;
  if (p.reasoning && p.reasoning !== 'none') {
    if (p.efforts?.length) {
      next.efforts = [...p.efforts];
      next.thinkingControl = 'effort';
    } else if (p.thinkingControl === 'toggle' && !next.efforts?.length) next.thinkingControl = 'toggle';
  }
  return next;
}

/** 模型配置和检测结果是否一致（不一致时显示「恢复检测结果」） */
function matchesProbe(m: AiModelConfig, p: ModelProbe): boolean {
  const a = applyProbe(m, p);
  return (
    a.contextWindow === m.contextWindow &&
    !!a.supportsImages === !!m.supportsImages &&
    (a.supportsTools ?? null) === (m.supportsTools ?? null) &&
    (a.reasoning ?? 'none') === (m.reasoning ?? 'none') &&
    JSON.stringify(a.efforts ?? null) === JSON.stringify(m.efforts ?? null)
  );
}

/**
 * 模型设置弹窗（第二十五轮，参考 NewMax）：上下文窗口、能力支持（图片 / 工具调用 / 思考）、深度思考的控制方式和支持的档位，
 * 右上角「检测模型能力」自动识别，「恢复检测结果」撤销手动修改。
 */
export function ModelDialog({
  model,
  existingIds,
  providerType,
  thinkingStyle,
  probeTarget,
  onOk,
  onClose,
}: {
  /** null = 添加新模型 */
  model: AiModelConfig | null;
  /** 同一个提供商里已有的模型 ID（不能重复） */
  existingIds: string[];
  providerType: AiProviderType;
  thinkingStyle: ThinkingStyle;
  /** 检测用的提供商表单（还没保存也可以检测）；不能检测时返回 null */
  probeTarget: (() => { id: string | null; input: AiProviderInput } | null) | null;
  onOk(m: AiModelConfig): void;
  onClose(): void;
}): React.JSX.Element {
  const { message, notification } = App.useApp();
  const [draft, setDraft] = useState<AiModelConfig>(() => model ?? { id: '', contextWindow: 128_000, maxOutput: 8192, reasoning: 'none' });
  const [ctxText, setCtxText] = useState(() => formatTokens(draft.contextWindow));
  const [outText, setOutText] = useState(() => formatTokens(draft.maxOutput));
  const [probing, setProbing] = useState(false);
  const [more, setMore] = useState(false);
  const isNew = !model;
  const anthropic = providerType === 'ANTHROPIC';
  const thinking = (draft.reasoning ?? 'none') !== 'none';
  const control = thinkingControlOf(draft, thinkingStyle);
  const set = (patch: Partial<AiModelConfig>): void => setDraft((d) => ({ ...d, ...patch }));
  // 没改过的输入框保留原值（显示成 1M 的 1048576 不会被改成 1000000）
  const ctx = ctxText === formatTokens(draft.contextWindow) ? draft.contextWindow : parseTokens(ctxText);
  const out = outText === formatTokens(draft.maxOutput) ? draft.maxOutput : parseTokens(outText);
  const idTaken = !!draft.id.trim() && existingIds.includes(draft.id.trim()) && draft.id.trim() !== model?.id;
  const probe = draft.probe ?? null;
  const restorable = useMemo(() => !!probe && !matchesProbe(draft, probe), [draft, probe]);

  const levels: Effort[] = control === 'budget' ? EFFORTS.filter((e) => e !== 'minimal') : [...EFFORTS];
  const toggleEffort = (e: Effort): void => {
    const cur = draft.efforts ?? [];
    const next = cur.includes(e) ? cur.filter((x) => x !== e) : EFFORTS.filter((x) => x === e || cur.includes(x));
    set({ efforts: next.length ? next : null, effort: draft.effort && next.includes(draft.effort) ? draft.effort : null });
  };

  const runProbe = async (): Promise<void> => {
    const id = draft.id.trim();
    if (!id) return void message.warning('先填写模型 ID');
    const target = probeTarget?.();
    if (!target) return void message.warning('先填写 API Key 和接口地址');
    setProbing(true);
    try {
      const r: ModelProbeResult = await invoke('ai.providers.probe', { ...target, modelId: id });
      if (!r.ok) {
        notification.error({ message: `${id} 检测失败`, description: r.notes?.connect ?? '连接失败', placement: 'topRight' });
        return;
      }
      const { ok: _ok, latencyMs: _l, reply: _r, requests, ...p } = r;
      // 以输入框里的窗口为准再套检测结果（检测期间可能改过）
      const base = { ...draft, contextWindow: ctx && !Number.isNaN(ctx) ? ctx : draft.contextWindow, maxOutput: out && !Number.isNaN(out) ? out : draft.maxOutput };
      const next = { ...applyProbe(base, p), probe: p };
      setDraft(next);
      setCtxText(formatTokens(next.contextWindow));
      setOutText(formatTokens(next.maxOutput));
      const levelsText = p.efforts?.length ? `；档位：${p.efforts.map((e) => EFFORT_LABEL[e]).join(' / ')}` : '';
      notification.success({
        message: `${id} 测试通过`,
        description: (
          <div data-testid="probe-summary">
            <div>能力：{probeSummary(p)}{levelsText}</div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              共 {requests} 次请求 · 首次响应 {r.latencyMs} ms
            </Typography.Text>
          </div>
        ),
        placement: 'topRight',
      });
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setProbing(false);
    }
  };

  const submit = (): void => {
    const id = draft.id.trim();
    if (!id) return void message.warning('请填写模型 ID');
    if (idTaken) return void message.warning(`模型 ${id} 已经添加过了`);
    if (ctx === null || Number.isNaN(ctx)) return void message.warning('上下文窗口格式不对，例如 128K、1M');
    if (out === null || Number.isNaN(out)) return void message.warning('最大输出格式不对，例如 8K、64K');
    if (out > ctx) return void message.warning('最大输出不能超过上下文窗口');
    onOk({ ...draft, id, contextWindow: ctx, maxOutput: out, displayName: draft.displayName?.trim() || undefined });
  };

  const notes = probe?.notes ?? {};
  return (
    <Modal
      open
      width={640}
      className="model-dialog"
      title={
        <div className="model-dialog-head">
          {isNew ? (
            <Input
              variant="borderless"
              className="model-dialog-id"
              placeholder="模型 ID，例如 deepseek-flash"
              value={draft.id}
              status={idTaken ? 'error' : undefined}
              onChange={(e) => set({ id: e.target.value })}
              autoFocus
              data-testid="model-id-input"
            />
          ) : (
            <span className="model-dialog-id mono">{draft.id}</span>
          )}
          <span className="model-dialog-actions">
            {restorable && (
              <Button
                size="small"
                icon={<UndoOutlined />}
                onClick={() => {
                  if (!probe) return;
                  const next = { ...applyProbe(draft, probe), probe };
                  setDraft(next);
                  setCtxText(formatTokens(next.contextWindow));
                  setOutText(formatTokens(next.maxOutput));
                }}
                data-testid="model-probe-restore"
              >
                恢复检测结果
              </Button>
            )}
            {probeTarget && (
              <Tooltip title="同时检测窗口与能力（图片、工具调用、思考开关和档位），会发十次左右很短的请求；真实能力请求的费用以供应商计费规则为准">
                <Button size="small" shape="round" icon={probing ? <LoadingOutlined /> : <ExperimentOutlined />} disabled={probing} onClick={() => void runProbe()} data-testid="model-probe">
                  {probing ? '检测中…' : '检测模型能力'}
                </Button>
              </Tooltip>
            )}
          </span>
        </div>
      }
      onCancel={onClose}
      okText="确定"
      cancelText="取消"
      onOk={submit}
      okButtonProps={{ 'data-testid': 'model-dialog-ok' } as never}
      destroyOnHidden
      maskClosable={false}
    >
      <div className="md-block">
        <div className="md-label">上下文窗口</div>
        <div className="md-tokens">
          <Input value={ctxText} onChange={(e) => setCtxText(e.target.value)} status={ctx !== null && Number.isNaN(ctx) ? 'error' : undefined} placeholder="例如 128K" data-testid="model-context" />
          {CONTEXT_CHIPS.map((n) => (
            <button key={n} type="button" className={`md-chip ${ctx === n ? 'on' : ''}`} onClick={() => setCtxText(formatTokens(n))}>
              {formatTokens(n)}
            </button>
          ))}
        </div>
        <div className="md-hint">纯数字默认按 k 处理，也支持 k、M；最大 10M。{notes.context ? `（检测：${notes.context}）` : ''}</div>
      </div>
      <div className="md-block">
        <div className="md-label">最大输出</div>
        <div className="md-tokens">
          <Input value={outText} onChange={(e) => setOutText(e.target.value)} status={out !== null && Number.isNaN(out) ? 'error' : undefined} placeholder="例如 8K" data-testid="model-max-output" />
          {OUTPUT_CHIPS.map((n) => (
            <button key={n} type="button" className={`md-chip ${out === n ? 'on' : ''}`} onClick={() => setOutText(formatTokens(n))}>
              {formatTokens(n)}
            </button>
          ))}
        </div>
      </div>

      <div className="md-card">
        <div className="md-card-title">能力支持</div>
        <div className="md-chips">
          <Chip on={!!draft.supportsImages} onClick={() => set({ supportsImages: !draft.supportsImages })} testId="cap-images">
            图片
          </Chip>
          <Chip on={draft.supportsTools !== false} onClick={() => set({ supportsTools: draft.supportsTools === false ? null : false })} testId="cap-tools">
            工具调用
          </Chip>
          <Chip on={thinking} onClick={() => set({ reasoning: thinking ? 'none' : 'optional' })} testId="cap-thinking">
            思考
          </Chip>
        </div>
        {(notes.images || notes.tools) && (
          <div className="md-notes">
            {notes.images && <div>图片：{notes.images}</div>}
            {notes.tools && <div>工具调用：{notes.tools}</div>}
          </div>
        )}
        {draft.supportsImages && !anthropic && (
          <div className="md-row">
            <span className="md-row-label">
              图片发送格式
              <Tooltip title="大多数接口（DeepSeek、千问、GLM、Kimi、豆包、OpenAI、Gemini、Ollama 等）认 data URL；少数接口只认纯 base64。「检测模型能力」会自动识别">
                <Typography.Text type="secondary"> ⓘ</Typography.Text>
              </Tooltip>
            </span>
            <Segmented
              size="small"
              value={draft.imageFormat === 'base64' ? 'base64' : 'data-url'}
              onChange={(v) => set({ imageFormat: v === 'base64' ? 'base64' : null })}
              options={[
                { value: 'data-url', label: 'Data URL（标准）' },
                { value: 'base64', label: '纯 Base64' },
              ]}
              data-testid="model-image-format"
            />
          </div>
        )}
        {draft.supportsTools === false && <div className="md-notes warn">不能调用工具的模型只能用 Ask 模式问答，智能体模式没法执行命令</div>}
      </div>

      {thinking && (
        <div className="md-card">
          <div className="md-card-head">
            <span className="md-card-title">深度思考</span>
            <Segmented size="small" value={control} onChange={(v) => set({ thinkingControl: v as ThinkingControl })} options={CONTROL_OPTIONS} data-testid="model-thinking-control" />
          </div>
          <div className="md-hint">{CONTROL_HINT[control]}</div>
          <div className="md-sub">支持的思考档位</div>
          <div className="md-chips">
            <Chip on disabled tip="不指定强度时用模型的默认值">
              自动
            </Chip>
            <Chip on={draft.reasoning === 'optional'} onClick={() => set({ reasoning: draft.reasoning === 'optional' ? 'always' : 'optional' })} tip="能关闭思考（不选表示这个模型始终思考）" testId="level-off">
              关闭
            </Chip>
            {control !== 'toggle' &&
              levels.map((e) => (
                <Chip key={e} on={!!draft.efforts?.includes(e)} onClick={() => toggleEffort(e)} testId={`level-${e}`}>
                  {EFFORT_LABEL[e]}
                </Chip>
              ))}
          </div>
          {notes.thinking && <div className="md-notes">{notes.thinking}</div>}
          {control === 'budget' && (
            <div className="md-row">
              <span className="md-row-label">没选档位时的思考预算</span>
              <InputNumber min={1024} step={1024} placeholder="8192" value={draft.thinkingBudget ?? null} onChange={(v) => set({ thinkingBudget: v ?? null })} addonAfter="token" style={{ width: 180 }} />
            </div>
          )}
        </div>
      )}

      <button type="button" className="md-more" onClick={() => setMore((v) => !v)} data-testid="model-more">
        {more ? '收起更多参数' : '更多参数（显示名称、默认开关、温度）'}
      </button>
      {more && (
        <div className="md-grid">
          <label>
            <span>显示名称</span>
            <Input placeholder="留空显示模型 ID" value={draft.displayName ?? ''} onChange={(e) => set({ displayName: e.target.value })} data-testid="model-display-name" />
          </label>
          {draft.reasoning === 'optional' && (
            <label>
              <span>默认开启思考</span>
              <Select
                value={draft.thinkingDefault === true ? 'on' : draft.thinkingDefault === false ? 'off' : 'inherit'}
                onChange={(v) => set({ thinkingDefault: v === 'on' ? true : v === 'off' ? false : null })}
                options={[
                  { value: 'inherit', label: '跟随全局默认' },
                  { value: 'on', label: '开启' },
                  { value: 'off', label: '关闭' },
                ]}
              />
            </label>
          )}
          {thinking && control !== 'toggle' && (
            <label>
              <span>默认思考强度</span>
              <Select
                value={draft.effort ?? ''}
                onChange={(v: Effort | '') => set({ effort: v || null })}
                options={[{ value: '', label: '跟随全局默认' }, ...(draft.efforts?.length ? draft.efforts : levels).map((e) => ({ value: e, label: EFFORT_LABEL[e] }))]}
                data-testid="model-effort"
              />
            </label>
          )}
          <label>
            <span>温度</span>
            <InputNumber min={0} max={2} step={0.1} placeholder="默认" value={draft.temperature ?? null} onChange={(v) => set({ temperature: v ?? null })} style={{ width: '100%' }} data-testid="model-temperature" />
          </label>
          <label>
            <span>Top-P</span>
            <InputNumber min={0} max={1} step={0.05} placeholder="默认" value={draft.topP ?? null} onChange={(v) => set({ topP: v ?? null })} style={{ width: '100%' }} />
          </label>
        </div>
      )}
    </Modal>
  );
}

function Chip({ on, onClick, disabled, children, tip, testId }: { on: boolean; onClick?: () => void; disabled?: boolean; children: React.ReactNode; tip?: string; testId?: string }): React.JSX.Element {
  const el = (
    <button type="button" className={`md-chip pill ${on ? 'on' : ''}`} disabled={disabled} onClick={onClick} data-testid={testId} data-on={on ? '1' : '0'}>
      {on && <CheckOutlined />}
      {children}
    </button>
  );
  return tip ? <Tooltip title={tip}>{el}</Tooltip> : el;
}
