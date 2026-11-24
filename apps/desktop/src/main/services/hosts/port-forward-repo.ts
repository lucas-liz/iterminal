import { randomUUID } from 'node:crypto';
import type { PortForward, PortForwardInput, PortForwardType } from '@itm/protocol';
import type { Db } from '../db/database';
import { UserError } from '../../util/errors';

const TYPES: PortForwardType[] = ['LOCAL', 'REMOTE', 'DYNAMIC'];
const MAX_PER_HOST = 50;

interface Row {
  id: string;
  host_id: string;
  type: PortForwardType;
  bind_addr: string;
  bind_port: number;
  target_addr: string | null;
  target_port: number | null;
  auto_start: number;
}

const toForward = (r: Row): PortForward => ({
  id: r.id,
  hostId: r.host_id,
  type: r.type,
  bindAddr: r.bind_addr,
  bindPort: r.bind_port,
  targetAddr: r.target_addr,
  targetPort: r.target_port,
  autoStart: !!r.auto_start,
});

const validPort = (p: unknown, allowZero: boolean): p is number => Number.isInteger(p) && (p as number) >= (allowZero ? 0 : 1) && (p as number) <= 65535;

/** 端口转发配置（主机的附属数据；删除打墓碑，参与云同步和备份） */
export class PortForwardRepo {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  list(hostId: string | null): PortForward[] {
    const sql = `SELECT p.id, p.host_id, p.type, p.bind_addr, p.bind_port, p.target_addr, p.target_port, p.auto_start
                   FROM port_forward p JOIN host h ON h.id = p.host_id AND h.deleted = 0
                  WHERE p.deleted = 0 ${hostId ? 'AND p.host_id = ?' : ''} ORDER BY p.updated_at`;
    const stmt = this.db.prepare<unknown[], Row>(sql);
    return (hostId ? stmt.all(hostId) : stmt.all()).map(toForward);
  }

  get(id: string): PortForward | null {
    const r = this.db
      .prepare<[string], Row>('SELECT id, host_id, type, bind_addr, bind_port, target_addr, target_port, auto_start FROM port_forward WHERE id = ? AND deleted = 0')
      .get(id);
    return r ? toForward(r) : null;
  }

  require(id: string): PortForward {
    const f = this.get(id);
    if (!f) throw new UserError('端口转发不存在');
    return f;
  }

  save(id: string | null, hostId: string, input: PortForwardInput): PortForward {
    const type = input.type;
    if (!TYPES.includes(type)) throw new UserError('不支持的转发类型');
    const bindAddr = String(input.bindAddr ?? '').trim() || '127.0.0.1';
    if (!validPort(input.bindPort, true)) throw new UserError('监听端口必须在 0–65535 之间（0 表示自动分配）');
    let targetAddr: string | null = null;
    let targetPort: number | null = null;
    if (type !== 'DYNAMIC') {
      targetAddr = String(input.targetAddr ?? '').trim();
      if (!targetAddr) throw new UserError('请填写目标地址');
      if (!validPort(input.targetPort, false)) throw new UserError('目标端口必须在 1–65535 之间');
      targetPort = input.targetPort;
    }
    if (input.bindPort !== 0) {
      const dup = this.db
        .prepare<[string, string, string, number, string], { id: string }>(
          'SELECT id FROM port_forward WHERE host_id = ? AND type = ? AND bind_addr = ? AND bind_port = ? AND deleted = 0 AND id != ?',
        )
        .get(hostId, type, bindAddr, input.bindPort, id ?? '');
      if (dup) throw new UserError(`已经有监听 ${bindAddr}:${input.bindPort} 的转发`);
    }
    const now = this.now();
    if (id) {
      const r = this.db
        .prepare('UPDATE port_forward SET type = ?, bind_addr = ?, bind_port = ?, target_addr = ?, target_port = ?, auto_start = ?, updated_at = ? WHERE id = ? AND deleted = 0')
        .run(type, bindAddr, input.bindPort, targetAddr, targetPort, input.autoStart ? 1 : 0, now, id);
      if (r.changes === 0) throw new UserError('端口转发不存在');
      return this.require(id);
    }
    const n = this.db.prepare<[string], { n: number }>('SELECT count(*) AS n FROM port_forward WHERE host_id = ? AND deleted = 0').get(hostId)!.n;
    if (n >= MAX_PER_HOST) throw new UserError(`每台主机最多 ${MAX_PER_HOST} 条端口转发`);
    const newId = randomUUID();
    this.db
      .prepare('INSERT INTO port_forward (id, host_id, type, bind_addr, bind_port, target_addr, target_port, auto_start, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newId, hostId, type, bindAddr, input.bindPort, targetAddr, targetPort, input.autoStart ? 1 : 0, now);
    return this.require(newId);
  }

  delete(id: string): void {
    this.db.prepare('UPDATE port_forward SET deleted = 1, updated_at = ? WHERE id = ?').run(this.now(), id);
  }
}
