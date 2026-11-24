import type { RemoteApproval } from '@itm/protocol';
import { UserError } from '../../util/errors';
import type { ServerLink } from './server-link';

type Decision = 'APPROVED' | 'REJECTED' | 'EXPIRED';

const toMs = (v: unknown, fallback: number): number => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return fallback;
};
const str = (v: unknown, max = 8000): string => (typeof v === 'string' ? v.slice(0, max) : v === undefined || v === null ? '' : String(v).slice(0, max));

/**
 * 远程审批（文档一 6.11、文档二 5.9 / 7.2）。
 * - 审批人侧：收到 approval.request 后列入待审批，用户批准 / 拒绝后发 approval.decide；
 * - 执行器侧：无人值守任务需要审批时，用 REST 创建审批，等 approval.result。
 */
export class RemoteApprovals {
  private readonly pending = new Map<string, RemoteApproval>();
  private readonly waiters = new Map<string, (d: Decision) => void>();
  /** 在执行器登记等待之前就到达的结果（保留 60 秒） */
  private readonly early = new Map<string, { decision: Decision; at: number }>();
  private sweep: NodeJS.Timeout | null = null;

  constructor(
    private readonly link: Pick<ServerLink, 'on' | 'send' | 'request'>,
    private readonly d: {
      emit(list: RemoteApproval[]): void;
      /** 新的审批请求：系统通知 */
      notify(a: RemoteApproval): void;
      now?: () => number;
    },
  ) {
    link.on('approval.request', (p) => this.onRequest(p as Record<string, unknown>));
    link.on('approval.result', (p) => this.onResult(p as Record<string, unknown>));
    // 过期的审批自动移除
    this.sweep = setInterval(() => this.prune(), 30_000);
    this.sweep.unref?.();
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  stop(): void {
    if (this.sweep) clearInterval(this.sweep);
    for (const w of this.waiters.values()) w('EXPIRED');
    this.waiters.clear();
  }

  list(): RemoteApproval[] {
    this.prune(false);
    return [...this.pending.values()].sort((a, b) => a.receivedAt - b.receivedAt);
  }

  private prune(emit = true): void {
    const now = this.now();
    let changed = false;
    for (const [id, a] of this.pending) {
      if (a.expiresAt <= now) {
        this.pending.delete(id);
        changed = true;
      }
    }
    if (changed && emit) this.d.emit(this.list());
  }

  private onRequest(p: Record<string, unknown>): void {
    const id = str(p?.approvalId, 64);
    if (!id) return;
    const a: RemoteApproval = {
      approvalId: id,
      runId: str(p.runId, 64),
      taskName: str(p.taskName, 200) || null,
      host: str(p.host, 200) || '（未知主机）',
      command: str(p.command),
      risk: str(p.risk, 10) || 'L1',
      reasons: Array.isArray(p.reasons) ? p.reasons.map((x) => str(x, 500)).slice(0, 20) : [],
      explanation: str(p.explanation, 1000) || null,
      diff: str(p.diff, 64 * 1024) || null,
      expiresAt: toMs(p.expiresAt, this.now() + 30 * 60_000),
      receivedAt: this.now(),
    };
    if (a.expiresAt <= this.now()) return;
    const isNew = !this.pending.has(id);
    this.pending.set(id, a);
    this.d.emit(this.list());
    if (isNew) this.d.notify(a);
  }

  private onResult(p: Record<string, unknown>): void {
    const id = str(p?.approvalId, 64);
    const decision = p?.decision === 'APPROVED' ? 'APPROVED' : p?.decision === 'REJECTED' ? 'REJECTED' : 'EXPIRED';
    // 其他人（或其他设备）已经处理：从待审批里移除
    if (this.pending.delete(id)) this.d.emit(this.list());
    const w = this.waiters.get(id);
    if (w) {
      this.waiters.delete(id);
      w(decision);
    } else if (id) {
      this.early.set(id, { decision, at: this.now() });
      for (const [k, v] of this.early) if (this.now() - v.at > 60_000) this.early.delete(k);
    }
  }

  /** 审批人批准 / 拒绝 */
  decide(approvalId: string, decision: 'APPROVED' | 'REJECTED', comment?: string): void {
    const a = this.pending.get(approvalId);
    if (!a) throw new UserError('这个审批已经处理或者已过期');
    this.link.send('approval.decide', { approvalId, decision, comment: (comment ?? '').slice(0, 500) || undefined }, { ack: true });
    this.pending.delete(approvalId);
    this.d.emit(this.list());
  }

  /**
   * 执行器侧：创建远程审批并等待结果；拒绝、过期、超时都返回 false。
   */
  async request(
    runId: string,
    req: { hostId: string; hostName?: string; command: string; risk: string; reasons: string[]; explanation?: string | null },
    timeoutMs: number,
  ): Promise<boolean> {
    const r = await this.link.request<{ approvalId: string; expiresAt?: string | number }>('POST', `/api/v1/sched/runs/${encodeURIComponent(runId)}/approvals`, req);
    if (!r?.approvalId) return false;
    const early = this.early.get(r.approvalId);
    if (early) {
      this.early.delete(r.approvalId);
      return early.decision === 'APPROVED';
    }
    const until = Math.min(toMs(r.expiresAt, this.now() + timeoutMs), this.now() + timeoutMs);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(r.approvalId);
        resolve(false);
      }, Math.max(0, until - this.now()));
      this.waiters.set(r.approvalId, (d) => {
        clearTimeout(timer);
        resolve(d === 'APPROVED');
      });
    });
  }
}
