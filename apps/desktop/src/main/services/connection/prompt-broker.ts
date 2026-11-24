import { randomUUID } from 'node:crypto';
import type { PromptAnswer, PromptRequest } from '@itm/protocol';
import type { Emit } from './emitter';

type NewPrompt = PromptRequest extends infer R ? (R extends PromptRequest ? Omit<R, 'promptId'> : never) : never;

interface Pending {
  owner: number;
  kind: PromptRequest['kind'];
  resolve: (a: PromptAnswer) => void;
  timer: NodeJS.Timeout;
}

/** 超时或窗口关闭时的回答：一律视为拒绝 / 取消 */
function refusal(kind: PromptRequest['kind']): PromptAnswer {
  return kind === 'hostKey' ? { kind: 'hostKey', accept: false } : { kind: 'password', value: null, remember: false };
}

/**
 * 连接过程中需要用户决定的事（确认主机指纹、输入密码）：发给发起连接的窗口，等它回答。
 * 只接受发起窗口的回答，其他窗口伪造的 promptId 会被忽略。
 */
export class PromptBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly emit: Emit,
    private readonly timeoutMs = 5 * 60_000,
  ) {}

  ask(owner: number, req: NewPrompt): Promise<PromptAnswer> {
    // 后台（常驻监控等，owner < 0）没有窗口可以问：直接按拒绝处理，不等超时
    if (owner < 0) return Promise.resolve(refusal(req.kind));
    const promptId = randomUUID();
    return new Promise<PromptAnswer>((resolve) => {
      const timer = setTimeout(() => this.settle(promptId, refusal(req.kind)), this.timeoutMs);
      this.pending.set(promptId, { owner, kind: req.kind, resolve, timer });
      this.emit(owner, 'prompt.request', { ...req, promptId } as PromptRequest);
    });
  }

  answer(sender: number, promptId: string, answer: PromptAnswer): void {
    const p = this.pending.get(promptId);
    if (!p || p.owner !== sender || p.kind !== answer.kind) {
      return;
    }
    this.settle(promptId, answer);
  }

  /** 窗口关闭：它名下所有未回答的提示都按拒绝处理 */
  cancelAll(owner: number): void {
    for (const [id, p] of this.pending) {
      if (p.owner === owner) {
        this.settle(id, refusal(p.kind));
      }
    }
  }

  private settle(promptId: string, answer: PromptAnswer): void {
    const p = this.pending.get(promptId);
    if (!p) {
      return;
    }
    this.pending.delete(promptId);
    clearTimeout(p.timer);
    p.resolve(answer);
  }
}
