import type { Client } from 'ssh2';
import type { DeployResult, RotateReport } from '@itm/protocol';
import { UserError } from '../../util/errors';
import { shQuote } from '../../util/shell';
import type { Emit } from '../connection/emitter';
import { execCommand } from '../connection/exec';
import type { SshPool } from '../connection/ssh-pool';
import type { HostRepo } from '../hosts/host-repo';
import { generateKeyPair, type CredentialRepo } from './credential-repo';

/**
 * 把公钥追加到 ~/.ssh/authorized_keys（ssh-copy-id 的等价实现）：已存在则跳过；
 * 原文件末尾没有换行时先补一个，避免和最后一行粘在一起。
 */
export function installKeyScript(publicKey: string): string {
  const line = shQuote(publicKey.trim());
  const blob = shQuote(publicKey.trim().split(/\s+/)[1] ?? '');
  return [
    'umask 077',
    'mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys || exit 3',
    `if grep -qF ${blob} ~/.ssh/authorized_keys; then echo ITM_EXISTS; exit 0; fi`,
    '[ -s ~/.ssh/authorized_keys ] && [ -n "$(tail -c 1 ~/.ssh/authorized_keys)" ] && echo >> ~/.ssh/authorized_keys',
    `echo ${line} >> ~/.ssh/authorized_keys && echo ITM_ADDED`,
  ].join('\n');
}

/** 从 authorized_keys 里删掉某把公钥（按公钥数据匹配，带 from= 等选项的行也能删掉）；保留文件的 inode 和权限 */
export function revokeKeyScript(publicKey: string): string {
  const blob = shQuote(publicKey.trim().split(/\s+/)[1] ?? '');
  return [
    'f=~/.ssh/authorized_keys',
    '[ -f "$f" ] || { echo ITM_ABSENT; exit 0; }',
    `grep -qF ${blob} "$f" || { echo ITM_ABSENT; exit 0; }`,
    `grep -vF ${blob} "$f" > "$f.itm.tmp"; cat "$f.itm.tmp" > "$f" && rm -f "$f.itm.tmp" && echo ITM_REMOVED`,
  ].join('\n');
}

const ALGO: Record<string, 'ed25519' | 'rsa'> = { 'ssh-ed25519': 'ed25519', 'ssh-rsa': 'rsa' };

/**
 * 凭证管理里的批量部署公钥和轮换向导（文档一 6.6）。登录各台主机用的是主机现有的认证方式。
 */
export class KeyDeployService {
  constructor(
    private readonly pool: SshPool,
    private readonly hosts: HostRepo,
    private readonly credentials: CredentialRepo,
    private readonly emit: Emit,
  ) {}

  async deploy(owner: number, credentialId: string, hostIds: string[]): Promise<DeployResult[]> {
    const cred = this.credentials.require(credentialId);
    if (!cred.publicKey) throw new UserError('这个凭证没有公钥');
    const results: DeployResult[] = [];
    for (const hostId of hostIds) {
      results.push(await this.runOn(owner, hostId, installKeyScript(cred.publicKey), { ITM_ADDED: '已添加公钥', ITM_EXISTS: '公钥已存在，跳过' }));
    }
    return results;
  }

  /**
   * 轮换：生成新密钥 → 用旧密钥登录，把新公钥部署到每台主机 → 用新密钥逐台验证登录 →
   * 全部通过后替换凭证并从主机上删除旧公钥；有任何一台验证失败就回滚（删掉已部署的新公钥），凭证保持不变。
   */
  async rotate(owner: number, credentialId: string, hostIds: string[]): Promise<RotateReport> {
    const cred = this.credentials.require(credentialId);
    if (cred.type !== 'SSH_KEY') throw new UserError('只有 SSH 密钥可以轮换');
    const old = this.credentials.secrets(credentialId);
    if (!old.privateKey || !cred.publicKey) throw new UserError('这个凭证没有私钥，不能轮换');
    if (hostIds.length === 0) throw new UserError('请选择要轮换的主机');
    const algorithm = ALGO[cred.keyType ?? ''] ?? 'ed25519';
    const comment = cred.publicKey.split(/\s+/).slice(2).join(' ') || 'iterminal';
    const fresh = generateKeyPair(algorithm, { bits: 4096, comment, passphrase: old.passphrase });
    const steps: RotateReport['steps'] = hostIds.map((hostId) => ({
      hostId,
      hostName: this.hosts.get(hostId)?.name ?? hostId,
      deploy: 'skipped',
      verify: 'skipped',
      revoke: 'skipped',
      message: '',
    }));
    const progress = (hostId: string, stage: 'deploy' | 'verify' | 'revoke', status: 'running' | 'ok' | 'error', message?: string): void =>
      this.emit(owner, 'credential.rotateProgress', { credentialId, hostId, stage, status, message });

    for (const s of steps) {
      progress(s.hostId, 'deploy', 'running');
      const r = await this.runOn(owner, s.hostId, installKeyScript(fresh.info.publicKey), { ITM_ADDED: '已部署新公钥', ITM_EXISTS: '新公钥已存在' });
      s.deploy = r.status === 'error' ? 'error' : 'ok';
      s.message = r.message;
      progress(s.hostId, 'deploy', s.deploy === 'ok' ? 'ok' : 'error', r.message);
      if (s.deploy !== 'ok') continue;
      progress(s.hostId, 'verify', 'running');
      try {
        const info = this.hosts.connectInfo(s.hostId);
        const client = await this.pool.connectDedicated(
          { ...info, auth: { ...info.auth, method: 'KEY', privateKey: fresh.privateKey, passphrase: old.passphrase, password: undefined, rememberable: false, credentialId: null } },
          owner,
        );
        client.end();
        s.verify = 'ok';
        progress(s.hostId, 'verify', 'ok');
      } catch (e) {
        s.verify = 'error';
        s.message = `新密钥登录失败：${(e as Error).message}`;
        progress(s.hostId, 'verify', 'error', s.message);
      }
    }

    const replaced = steps.every((s) => s.deploy === 'ok' && s.verify === 'ok');
    if (!replaced) {
      // 回滚：删除已经部署上去的新公钥
      for (const s of steps.filter((x) => x.deploy === 'ok')) {
        await this.runOn(owner, s.hostId, revokeKeyScript(fresh.info.publicKey), {});
        s.message ||= '其他主机验证失败，已撤回新公钥';
      }
      return { credentialId, fingerprint: fresh.info.fingerprint, steps, replaced: false };
    }
    this.credentials.replaceKey(credentialId, fresh.privateKey, old.passphrase);
    for (const s of steps) {
      progress(s.hostId, 'revoke', 'running');
      const r = await this.runOn(owner, s.hostId, revokeKeyScript(cred.publicKey), { ITM_REMOVED: '已删除旧公钥', ITM_ABSENT: '主机上没有旧公钥' });
      s.revoke = r.status === 'error' ? 'error' : 'ok';
      s.message = r.message;
      progress(s.hostId, 'revoke', s.revoke === 'ok' ? 'ok' : 'error', r.message);
    }
    return { credentialId, fingerprint: fresh.info.fingerprint, steps, replaced: true };
  }

  private async runOn(owner: number, hostId: string, script: string, markers: Record<string, string>): Promise<DeployResult> {
    const host = this.hosts.get(hostId);
    if (!host) return { hostId, hostName: hostId, status: 'error', message: '主机不存在或已被删除' };
    if (host.protocol !== 'SSH') return { hostId, hostName: host.name, status: 'skipped', message: '不是 SSH 主机' };
    let conn;
    try {
      conn = await this.pool.acquire(hostId, owner);
    } catch (e) {
      return { hostId, hostName: host.name, status: 'error', message: (e as Error).message };
    }
    try {
      const r = await execOrFail(conn.client, script);
      const hit = Object.keys(markers).find((m) => r.includes(m));
      if (hit) return { hostId, hostName: host.name, status: hit.endsWith('EXISTS') || hit.endsWith('ABSENT') ? 'skipped' : 'ok', message: markers[hit] };
      return { hostId, hostName: host.name, status: 'ok', message: '完成' };
    } catch (e) {
      return { hostId, hostName: host.name, status: 'error', message: (e as Error).message };
    } finally {
      this.pool.release(conn);
    }
  }
}

async function execOrFail(client: Client, script: string): Promise<string> {
  const r = await execCommand(client, `sh -c ${shQuote(script)}`, { timeoutMs: 20_000, maxBytes: 16 * 1024 });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `退出码 ${r.code}`);
  return r.stdout;
}

