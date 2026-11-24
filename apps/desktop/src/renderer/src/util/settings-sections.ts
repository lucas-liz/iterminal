/** 设置页的分区（不依赖其他模块，设置搜索的索引和单元测试也用） */
export type SettingsSectionKey = 'appearance' | 'terminal' | 'transfer' | 'security' | 'shortcuts' | 'storage' | 'models' | 'agent' | 'skills' | 'cmdsec' | 'mcp' | 'sync' | 'data' | 'feedback' | 'about';

/** 左侧导航的一项（第二十六轮合并后）：一个分组可以有几页，页面顶部用标签切换 */
export type SettingsGroupKey = 'account' | 'general' | 'terminal' | 'security' | 'models' | 'agent' | 'ext' | 'storage' | 'about';

export interface SettingsGroup {
  key: SettingsGroupKey;
  label: string;
  band: '账户与偏好' | 'AI 与服务' | '系统信息';
  /** 需要登录才能使用 AI 的分组 */
  ai?: boolean;
  sections: { key: SettingsSectionKey; label: string }[];
}

/**
 * 设置的分组（第二十六轮，参考 NewMax）：原来 15 个入口合并成 9 个——
 * 外观 + 快捷键 = 通用；终端 + 文件传输 = 终端；Agent 与审批 + 命令安全 = Agent 与安全；Skill + MCP = 扩展；
 * 云同步 + 账号 = 账户；存储位置 + 数据目录 = 数据；关于 + 问题反馈 = 关于。
 */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  { key: 'account', label: '账户', band: '账户与偏好', sections: [{ key: 'sync', label: '账户与同步' }] },
  {
    key: 'general',
    label: '通用',
    band: '账户与偏好',
    sections: [
      { key: 'appearance', label: '外观' },
      { key: 'shortcuts', label: '快捷键' },
    ],
  },
  {
    key: 'terminal',
    label: '终端',
    band: '账户与偏好',
    sections: [
      { key: 'terminal', label: '终端' },
      { key: 'transfer', label: '文件传输' },
    ],
  },
  { key: 'security', label: '安全与锁定', band: '账户与偏好', sections: [{ key: 'security', label: '安全与锁定' }] },
  { key: 'models', label: '模型', band: 'AI 与服务', ai: true, sections: [{ key: 'models', label: 'AI 模型' }] },
  {
    key: 'agent',
    label: 'Agent 与安全',
    band: 'AI 与服务',
    ai: true,
    sections: [
      { key: 'agent', label: '执行与审批' },
      { key: 'cmdsec', label: '命令安全' },
    ],
  },
  {
    key: 'ext',
    label: '扩展',
    band: 'AI 与服务',
    ai: true,
    sections: [
      { key: 'skills', label: 'Skill' },
      { key: 'mcp', label: 'MCP' },
    ],
  },
  { key: 'storage', label: '数据', band: '系统信息', sections: [{ key: 'storage', label: '数据' }] },
  {
    key: 'about',
    label: '关于',
    band: '系统信息',
    sections: [
      { key: 'about', label: '关于' },
      { key: 'feedback', label: '问题反馈' },
    ],
  },
];

/** 旧的分区合并到了别的页面：「数据与账号」→ 账户 */
export function normalizeSection(key: SettingsSectionKey): SettingsSectionKey {
  return key === 'data' ? 'sync' : key;
}

/** 分区所在的分组 */
export function groupOfSection(key: SettingsSectionKey): SettingsGroup {
  const k = normalizeSection(key);
  return SETTINGS_GROUPS.find((g) => g.sections.some((s) => s.key === k)) ?? SETTINGS_GROUPS[1];
}
