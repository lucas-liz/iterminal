import type { Db } from '../../src/main/services/db/database';
import { CredentialRepo } from '../../src/main/services/vault/credential-repo';
import { TagRepo } from '../../src/main/services/hosts/tag-repo';
import { HostRepo } from '../../src/main/services/hosts/host-repo';
import { FolderRepo } from '../../src/main/services/hosts/folder-repo';
import { SettingsRepo } from '../../src/main/services/settings/settings-repo';

/** 和 ProfileContext 一样把各个仓库连起来（测试用） */
export function createRepos(db: Db, vaultKey: Buffer, now: () => number = Date.now) {
  const settings = new SettingsRepo(db, now);
  const credentials = new CredentialRepo(db, vaultKey, now);
  const tags = new TagRepo(db, now);
  const hosts = new HostRepo(db, vaultKey, { credentials, tags, globalAgentPolicy: () => settings.get('ai.defaultAgentPolicy') }, now);
  const folders = new FolderRepo(db, now, {
    beforeDeleteHosts: (ids, path) => hosts.ensureNotUsedAsJump(ids, path),
    deleteHostCredentials: (ids) => credentials.deleteDedicatedOf(ids),
    requireSharedCredential: (id) => void credentials.requireShared(id),
    requireHost: (id) => void hosts.require(id),
  });
  hosts.attachFolders(folders);
  return { settings, credentials, tags, hosts, folders };
}
