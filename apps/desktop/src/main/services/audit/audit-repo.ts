import { randomUUID } from 'node:crypto';
import type { AuditEntry, AuditFilter } from '@itm/protocol';
import type { Db } from '../db/database';

interface Row {
  id: number;
  kind: 'COMMAND' | 'EVENT';
  source: AuditEntry['source'];
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
  uploaded: number;
}

export type AuditSource = 'USER' | 'AGENT' | 'SKILL' | 'SCHEDULE' | 'MCP_EXTERNAL';

export interface CommandAudit {
  source: AuditSource;
  hostId: string | null;
  hostName: string | null;
  sessionId?: string | null;
  command: string;
  risk?: string | null;
  decision?: 'AUTO' | 'APPROVED' | 'REJECTED' | 'DENIED' | null;
  exitCode?: number | null;
  detail?: Record<string, unknown>;
}

/**
 * 本地审计（文档一 6.12）。所有采集点都只往这里写；登录后由上报任务把 uploaded = 0 的记录批量发给服务端。
 */
export class AuditRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  event(type: string, detail: Record<string, unknown> = {}, source: AuditSource = 'USER'): void {
    this.db
      .prepare('INSERT INTO audit_log (event_id, kind, source, event_type, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), 'EVENT', source, type, JSON.stringify(detail), this.now());
  }

  command(c: CommandAudit): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (event_id, kind, source, host_id, host_name, session_id, command, risk, decision, exit_code, detail, created_at)
         VALUES (?, 'COMMAND', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(), c.source, c.hostId, c.hostName, c.sessionId ?? null, c.command.slice(0, 8000), c.risk ?? null, c.decision ?? null,
        c.exitCode ?? null, c.detail ? JSON.stringify(c.detail) : null, this.now(),
      );
  }

  /**
   * 某个会话在一段时间里执行的命令（录像回放右侧的命令列表）：手动输入、Agent、Skill 等都算，按时间排序，最多 2000 条
   */
  sessionCommands(sessionId: string, from: number, to: number): { command: string; source: AuditSource | null; exitCode: number | null; createdAt: number }[] {
    return this.db
      .prepare<[string, number, number], { command: string; source: AuditSource | null; exit_code: number | null; created_at: number }>(
        "SELECT command, source, exit_code, created_at FROM audit_log WHERE kind = 'COMMAND' AND session_id = ? AND created_at BETWEEN ? AND ? AND command IS NOT NULL ORDER BY created_at, id LIMIT 2000",
      )
      .all(sessionId, from, to)
      .map((r) => ({ command: r.command, source: r.source, exitCode: r.exit_code, createdAt: r.created_at }));
  }

  /** 某台主机最近执行过的命令（AI 汇总主机，第三十轮）：同一条命令只取最近一次，按时间倒序 */
  hostCommands(hostId: string, since: number, limit: number): { command: string; source: AuditSource | null; exitCode: number | null; createdAt: number }[] {
    const rows = this.db
      .prepare<[string, number], { command: string; source: AuditSource | null; exit_code: number | null; created_at: number }>(
        "SELECT command, source, exit_code, created_at FROM audit_log WHERE kind = 'COMMAND' AND host_id = ? AND created_at >= ? AND command IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 2000",
      )
      .all(hostId, since);
    const seen = new Set<string>();
    const out: { command: string; source: AuditSource | null; exitCode: number | null; createdAt: number }[] = [];
    for (const r of rows) {
      const key = r.command.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ command: r.command, source: r.source, exitCode: r.exit_code, createdAt: r.created_at });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** 本地审计查询（审计页） */
  list(f: AuditFilter): { items: AuditEntry[]; total: number } {
    const where: string[] = ['a.kind = ?'];
    const args: (string | number)[] = [f.kind];
    const esc = (v: string): string => `%${v.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    if (f.source) {
      where.push('a.source = ?');
      args.push(f.source);
    }
    if (f.risk) {
      where.push('a.risk = ?');
      args.push(f.risk);
    }
    if (f.hostId) {
      where.push('a.host_id = ?');
      args.push(f.hostId);
    }
    if (f.command?.trim()) {
      where.push("a.command LIKE ? ESCAPE '\\'");
      args.push(esc(f.command));
    }
    if (f.q?.trim()) {
      const like = esc(f.q);
      where.push("(a.command LIKE ? ESCAPE '\\' OR a.host_name LIKE ? ESCAPE '\\' OR a.event_type LIKE ? ESCAPE '\\' OR a.detail LIKE ? ESCAPE '\\')");
      args.push(like, like, like, like);
    }
    if (f.from) {
      where.push('a.created_at >= ?');
      args.push(f.from);
    }
    if (f.to) {
      where.push('a.created_at < ?');
      args.push(f.to);
    }
    const w = where.join(' AND ');
    const total = this.db.prepare<(string | number)[], { n: number }>(`SELECT count(*) AS n FROM audit_log a WHERE ${w}`).get(...args)?.n ?? 0;
    // 运维审计（第三十五轮）：登录账号取对应会话录像里记下的用户名，没有录像时取主机设置里的用户名；同时带上录像 ID 方便直接回放
    const items = this.db
      .prepare<(string | number)[], Row & { rec_id: string | null; rec_user: string | null; host_user: string | null }>(
        `SELECT a.*,
           (SELECT r.id FROM session_recording r WHERE r.session_id = a.session_id ORDER BY r.started_at DESC LIMIT 1) AS rec_id,
           (SELECT r.username FROM session_recording r WHERE r.session_id = a.session_id ORDER BY r.started_at DESC LIMIT 1) AS rec_user,
           (SELECT h.username FROM host h WHERE h.id = a.host_id) AS host_user
         FROM audit_log a WHERE ${w} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, Math.min(f.limit ?? 50, 500), Math.max(0, f.offset ?? 0))
      .map((r) => ({
        id: r.id,
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
        detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
        createdAt: r.created_at,
        uploaded: !!r.uploaded,
        account: r.rec_user || r.host_user || null,
        recordingId: r.rec_id,
      }));
    return { items, total };
  }

  /**
   * 清理超过保留天数的记录（文档一 6.12：本地保留 30 天）。登录后还没上报的记录（uploaded = 0）由上报任务处理，
   * keepUnuploaded = true 时不删。
   */
  cleanup(retentionDays: number, keepUnuploaded = false): number {
    const before = this.now() - retentionDays * 86_400_000;
    return this.db.prepare(`DELETE FROM audit_log WHERE created_at < ?${keepUnuploaded ? ' AND uploaded = 1' : ''}`).run(before).changes;
  }
}
