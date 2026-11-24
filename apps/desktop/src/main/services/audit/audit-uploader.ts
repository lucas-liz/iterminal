import type { Db } from '../db/database';
import type { RecordingStore } from './recording-store';

interface Row {
  id: number;
  event_id: string;
  kind: string;
  source: string | null;
  event_type: string | null;
  host_id: string | null;
  host_name: string | null;
  session_id: string | null;
  command: string | null;
  risk: string | null;
  decision: string | null;
  exit_code: number | null;
  detail: string | null;
  created_at: number;
}

interface RecRow {
  id: string;
  session_id: string;
  kind: string;
  host_id: string | null;
  host_name: string;
  cols: number;
  rows: number;
  started_at: number;
  ended_at: number;
}

const BATCH = 100;
const CHUNK = 1024 * 1024;

/**
 * 审计上报（文档一 6.12、文档二 5.10）：本地 audit_log 里 uploaded = 0 的记录每 5 秒（或满 100 条）批量上报，
 * 用 client_event_id 做幂等；失败按指数退避重试（5 秒起，最长 5 分钟）。结束的会话录像按 1MB 分片上传。
 * 只在账号模式下运行。
 */
export class AuditUploader {
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private busy = false;
  private stopped = true;

  constructor(
    private readonly d: {
      db: Db;
      request<T>(method: 'POST', path: string, body: unknown): Promise<T>;
      recordings: Pick<RecordingStore, 'readCast'>;
      /** 服务端策略：是否上传会话录像 */
      uploadRecordings(): boolean;
      intervalMs?: number;
    },
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(this.d.intervalMs ?? 5000);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  /** 上报一轮；返回这一轮上报的条数（测试用） */
  async tick(): Promise<{ commands: number; recordings: number }> {
    if (this.busy) return { commands: 0, recordings: 0 };
    this.busy = true;
    let commands = 0;
    let recordings = 0;
    try {
      for (;;) {
        const rows = this.d.db.prepare<[number], Row>('SELECT * FROM audit_log WHERE uploaded = 0 ORDER BY id LIMIT ?').all(BATCH);
        if (!rows.length) break;
        await this.d.request('POST', '/api/v1/audit/commands:batch', {
          items: rows.map((r) => ({
            clientEventId: r.event_id,
            kind: r.kind,
            source: r.source,
            eventType: r.event_type,
            hostId: r.host_id,
            hostName: r.host_name,
            sessionId: r.session_id,
            command: r.command,
            risk: r.risk,
            decision: r.decision,
            exitCode: r.exit_code,
            detail: r.detail ? (JSON.parse(r.detail) as unknown) : null,
            occurredAt: new Date(r.created_at).toISOString(),
          })),
        });
        const mark = this.d.db.prepare('UPDATE audit_log SET uploaded = 1 WHERE id = ?');
        this.d.db.transaction(() => rows.forEach((r) => mark.run(r.id)))();
        commands += rows.length;
        if (rows.length < BATCH) break;
      }
      if (this.d.uploadRecordings()) {
        const recs = this.d.db.prepare<[], RecRow>('SELECT * FROM session_recording WHERE uploaded = 0 AND ended_at IS NOT NULL ORDER BY started_at LIMIT 5').all();
        for (const r of recs) {
          const cast = this.d.recordings.readCast(r.id);
          const total = Math.max(1, Math.ceil(cast.length / CHUNK));
          for (let i = 0; i < total; i++) {
            await this.d.request('POST', `/api/v1/audit/sessions/${encodeURIComponent(r.id)}/chunks`, {
              index: i,
              final: i === total - 1,
              content: cast.slice(i * CHUNK, (i + 1) * CHUNK),
              ...(i === 0
                ? {
                    meta: {
                      sessionId: r.session_id,
                      kind: r.kind,
                      hostId: r.host_id,
                      hostName: r.host_name,
                      cols: r.cols,
                      rows: r.rows,
                      startedAt: new Date(r.started_at).toISOString(),
                      endedAt: new Date(r.ended_at).toISOString(),
                    },
                  }
                : {}),
            });
          }
          this.d.db.prepare('UPDATE session_recording SET uploaded = 1 WHERE id = ?').run(r.id);
          recordings++;
        }
      }
      this.failures = 0;
      this.schedule(this.d.intervalMs ?? 5000);
    } catch {
      // 失败：指数退避（5 秒、10 秒、20 秒……最长 5 分钟）
      this.failures++;
      this.d.db.prepare('UPDATE audit_log SET tries = tries + 1 WHERE uploaded = 0 AND id IN (SELECT id FROM audit_log WHERE uploaded = 0 ORDER BY id LIMIT ?)').run(BATCH);
      this.schedule(Math.min(300_000, (this.d.intervalMs ?? 5000) * 2 ** this.failures));
    } finally {
      this.busy = false;
    }
    return { commands, recordings };
  }

  /** 当前的退避次数（测试用） */
  get failureCount(): number {
    return this.failures;
  }
}
