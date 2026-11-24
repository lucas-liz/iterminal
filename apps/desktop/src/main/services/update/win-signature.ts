/** electron-updater NsisUpdater 的签名校验函数：通过返回 null，不通过返回原因 */
export type VerifySignature = (publisherNames: string[], file: string) => Promise<string | null>;

/**
 * Windows（第十九轮）：electron-updater 下载完安装包后用 app-update.yml 里的 publisherName 校验 Authenticode 签名。
 * 内测包没有签名，以前的打包配置里又写死了 publisherName，所以新版本一律「is not signed by the application owner」。
 * 这里改成：当前程序自己没有用这些发布者的证书签名时，不要求新版本签名；当前程序是签了名的正式版时照常校验。
 */
export function relaxUnsignedUpdateCheck(u: { verifyUpdateCodeSignature: VerifySignature }, selfExe: string, log?: (msg: string) => void): void {
  const verify = u.verifyUpdateCodeSignature;
  let self: Promise<string | null> | null = null;
  u.verifyUpdateCodeSignature = async (names, file) => {
    self ??= verify(names, selfExe).catch((e: Error) => e?.message ?? String(e));
    if ((await self) !== null) {
      log?.(`当前程序没有用 ${names.join(' | ')} 的证书签名，不校验新版本的签名`);
      return null;
    }
    return verify(names, file);
  };
}
