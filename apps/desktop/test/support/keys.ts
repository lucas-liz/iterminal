import { utils } from 'ssh2';

type KeyOptions = Parameters<typeof utils.generateKeyPairSync>[1];

/**
 * ssh2 的 generateKeyPairSync('ed25519') 约有 0.2% 的概率生成它自己解析不了的私钥（上游问题），
 * 测试里生成后校验一次，解析失败就重新生成，避免偶发失败。
 */
export function generateEd25519(opts?: KeyOptions & { passphrase?: string }): { private: string; public: string } {
  for (let i = 0; i < 20; i++) {
    const keys = opts ? utils.generateKeyPairSync('ed25519', opts) : utils.generateKeyPairSync('ed25519');
    if (!(utils.parseKey(keys.private, opts?.passphrase) instanceof Error)) {
      return keys;
    }
  }
  throw new Error('无法生成可用的测试密钥');
}
