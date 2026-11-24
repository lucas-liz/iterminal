import { useEffect, useState } from 'react';
import { Button, Input, Typography } from 'antd';
import { CheckOutlined, EnterOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import type { AgentStep } from '@itm/protocol';

/**
 * AI 反问的卡片（ask_user，第二十六轮）：选项一行一个（序号、选项、一句说明、推荐标记），
 * 单选点一下就回答，多选勾好后点「提交」；最后一行可以自己输入。按数字键 1–9 直接选。
 */
export function QuestionCard({
  step,
  waiting,
  busy,
  error,
  onAnswer,
  onSkip,
}: {
  step: AgentStep;
  waiting: boolean;
  busy: boolean;
  error: string | null;
  onAnswer(answer: string): void;
  onSkip(): void;
}): React.JSX.Element {
  const q = step.question!;
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  // 推荐的选项排在第一个（模型没有这样排时也调整过来），记住原来的下标
  const order = q.options.map((_, i) => i);
  if (q.recommended !== null && q.recommended !== undefined && q.recommended > 0) order.unshift(...order.splice(q.recommended, 1));

  const pick = (i: number): void => {
    if (!waiting || busy) return;
    if (q.multi) setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]));
    else onAnswer(q.options[i]);
  };
  const submitMulti = (): void => {
    const parts = order.filter((i) => picked.includes(i)).map((i) => q.options[i]);
    if (text.trim()) parts.push(text.trim());
    if (parts.length) onAnswer(parts.join('、'));
  };

  // 数字键直接选（焦点在输入框里时不处理）
  useEffect(() => {
    if (!waiting) return;
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > order.length) return;
      e.preventDefault();
      pick(order[n - 1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!waiting) {
    return (
      <div className="step-card question done" data-testid="agent-step" data-status={step.status}>
        <div className="ask-head">
          <QuestionCircleOutlined className="ask-icon" />
          <span className="ask-title">{q.text}</span>
        </div>
        {step.answer ? (
          <div className="ask-answer" data-testid="ask-answer">
            <CheckOutlined />
            {step.answer}
          </div>
        ) : (
          <Typography.Text type="secondary" className="ask-answer none">
            {step.status === 'pending' ? '等待回答…' : step.output || '没有回答'}
          </Typography.Text>
        )}
      </div>
    );
  }

  return (
    <div className="step-card question waiting" data-testid="agent-step" data-status={step.status}>
      <div className="ask-head">
        <QuestionCircleOutlined className="ask-icon" />
        <span className="ask-title">{q.text}</span>
        {q.multi && <span className="ask-hint">可多选</span>}
      </div>
      {order.length > 0 && (
        <div className="ask-options" role={q.multi ? 'group' : 'radiogroup'}>
          {order.map((i, n) => (
            <button
              key={i}
              type="button"
              className={`ask-opt ${picked.includes(i) ? 'on' : ''}`}
              disabled={busy}
              onClick={() => pick(i)}
              data-testid="ask-option"
            >
              <span className="ask-no">{q.multi && picked.includes(i) ? <CheckOutlined /> : n + 1}</span>
              <span className="ask-opt-text">
                <span className="ask-opt-label">
                  {q.options[i]}
                  {i === q.recommended && <span className="ask-rec">推荐</span>}
                </span>
                {q.details?.[i] && <span className="ask-opt-desc">{q.details[i]}</span>}
              </span>
              {!q.multi && <EnterOutlined className="ask-go" />}
            </button>
          ))}
        </div>
      )}
      <div className="ask-other">
        <Input
          size="small"
          variant="borderless"
          placeholder={order.length ? '其他回答（可以直接输入）' : '输入回答'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPressEnter={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (q.multi) submitMulti();
            else if (text.trim()) onAnswer(text.trim());
          }}
          data-testid="ask-input"
        />
        {q.multi ? (
          <Button size="small" type="primary" shape="round" disabled={!picked.length && !text.trim()} loading={busy} onClick={submitMulti} data-testid="ask-submit">
            提交{picked.length ? `（${picked.length}）` : ''}
          </Button>
        ) : (
          <Button size="small" type="primary" shape="round" disabled={!text.trim()} loading={busy} onClick={() => onAnswer(text.trim())} data-testid="ask-submit">
            回答
          </Button>
        )}
      </div>
      <div className="ask-foot">
        {order.length > 1 && <span className="ask-keys">按 1–{Math.min(9, order.length)} 直接选择</span>}
        <Button size="small" type="link" className="ask-skip" onClick={onSkip} disabled={busy} data-testid="ask-skip">
          跳过
        </Button>
      </div>
      {error && <Typography.Text type="danger">{error}</Typography.Text>}
    </div>
  );
}
