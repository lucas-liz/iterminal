import { AGENT_POLICY_STRICTNESS, type AgentPolicy, type EffectiveHostPolicy, type Folder, type Host } from '@itm/protocol';

/**
 * 有效配置解析（文档一 6.5 继承规则）：主机自身 → 所在分组 → 逐级父分组 → 全局默认，第一个非空值生效；
 * 说明逐级拼接，默认 Skill 合并。chain 是从所在分组到顶层（从近到远）。
 *
 * Agent 权限（第二十轮起）也是就近生效：主机设置了用主机的，否则用最近一个设置了的分组，都没有用全局默认。
 * 团队主机仍然取整条链（主机 → 分组 → 全局）上最严格的，本机的分组设置只能收紧、不能放宽；
 * 生产环境分组在审批引擎里另外收紧（applyPolicy），不受这里影响。
 */
export function resolveHostPolicy(
  host: Pick<Host, 'id' | 'authMethod' | 'credentialId' | 'jumpHostIds' | 'jumpInherit' | 'agentPolicy'> & { team?: Host['team'] },
  chain: Folder[],
  globalAgentPolicy: AgentPolicy,
): EffectiveHostPolicy {
  const from = (f: Folder) => ({ kind: 'folder' as const, folderId: f.id, folderName: f.name });

  let credentialId: string | null = null;
  let credentialFrom: EffectiveHostPolicy['credentialFrom'] = null;
  if (host.authMethod === 'CREDENTIAL') {
    if (host.credentialId) {
      credentialId = host.credentialId;
      credentialFrom = { kind: 'host' };
    } else {
      const f = chain.find((x) => x.defaultCredentialId);
      if (f) {
        credentialId = f.defaultCredentialId;
        credentialFrom = from(f);
      }
    }
  }

  let jumpHostIds: string[] = [];
  let jumpFrom: EffectiveHostPolicy['jumpFrom'] = null;
  if (host.jumpHostIds.length > 0) {
    jumpHostIds = host.jumpHostIds;
    jumpFrom = { kind: 'host' };
  } else if (host.jumpInherit) {
    // 跳板机自己也在这个分组里时，不能经过自己
    const f = chain.find((x) => x.defaultJumpHostId && x.defaultJumpHostId !== host.id);
    if (f) {
      jumpHostIds = [f.defaultJumpHostId!];
      jumpFrom = from(f);
    }
  }

  // 全局默认相当于最顶层的父级。候选按从近到远排列：普通主机取第一个；团队主机取最严格的（同样严格时离主机近的优先）
  const candidates: { p: AgentPolicy; src: EffectiveHostPolicy['agentPolicyFrom'] }[] = [];
  if (host.agentPolicy) candidates.push({ p: host.agentPolicy, src: { kind: 'host' } });
  for (const f of chain) if (f.agentPolicy) candidates.push({ p: f.agentPolicy, src: from(f) });
  candidates.push({ p: globalAgentPolicy, src: { kind: 'global' } });
  const picked = host.team ? candidates.reduce((a, b) => (AGENT_POLICY_STRICTNESS[b.p] > AGENT_POLICY_STRICTNESS[a.p] ? b : a)) : candidates[0];
  const agentPolicy = picked.p;
  const agentPolicyFrom = picked.src;

  const topDown = [...chain].reverse();
  return {
    credentialId,
    credentialFrom,
    jumpHostIds,
    jumpFrom,
    agentPolicy,
    agentPolicyFrom,
    aiNotes: topDown.filter((f) => f.aiNote).map((f) => ({ folderName: f.name, note: f.aiNote! })),
    defaultSkills: [...new Set(topDown.flatMap((f) => f.defaultSkills))],
    production: chain.some((f) => f.production),
    folderPath: topDown.map((f) => f.name).join(' / '),
  };
}
