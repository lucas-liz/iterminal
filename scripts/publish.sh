#!/usr/bin/env bash
# 把构建产物上传到后端发布服务并登记版本（文档一 11.4 / 文档二 5.12）。
#
#   ./scripts/publish.sh --channel stable --rollout 10 --dir apps/desktop/release [--min-version 0.3.0] [--dry-run]
#
# 需要环境变量：
#   ITM_SERVER         后端地址，例如 https://ops.iterminal.corp
#   ITM_RELEASE_TOKEN  管理后台签发的发布令牌（只有「版本发布」权限）
#   ITM_GPG_KEY_ID     可选：给 Linux 安装包生成 .asc 签名
#
# 每个安装包调用一次 POST /api/admin/v1/releases（multipart：meta + file），服务端计算 sha512、写 client_release，
# 并按 rollout_percent 生成 electron-updater 读取的 latest*.yml（stagingPercentage）。
set -euo pipefail

CHANNEL=stable
ROLLOUT=100
DIR=apps/desktop/release
MIN_VERSION=''
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2 ;;
    --rollout) ROLLOUT="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --min-version) MIN_VERSION="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

if [[ "$CHANNEL" != "stable" && "$CHANNEL" != "beta" ]]; then
  echo "渠道只能是 stable 或 beta" >&2
  exit 2
fi
if ! [[ "$ROLLOUT" =~ ^[0-9]+$ ]] || (( ROLLOUT < 1 || ROLLOUT > 100 )); then
  echo "灰度比例必须是 1–100" >&2
  exit 2
fi
if (( DRY_RUN == 0 )); then
  : "${ITM_SERVER:?需要设置 ITM_SERVER}"
  : "${ITM_RELEASE_TOKEN:?需要设置 ITM_RELEASE_TOKEN}"
fi

shopt -s nullglob
files=("$DIR"/*/*.{dmg,zip,exe,msi,AppImage,deb,rpm})
if (( ${#files[@]} == 0 )); then
  echo "在 $DIR 下没有找到安装包" >&2
  exit 1
fi

meta_for() {
  local f="$1" name os arch kind version
  name="$(basename "$f")"
  version="$(basename "$(dirname "$f")")"
  case "$name" in
    *.dmg|*-mac.zip|*mac*.zip) os=mac ;;
    *.exe|*.msi) os=win ;;
    *) os=linux ;;
  esac
  case "$name" in
    *arm64*|*aarch64*) arch=arm64 ;;
    *) arch=x64 ;;
  esac
  kind="${name##*.}"
  jq -n --arg v "$version" --arg ch "$CHANNEL" --arg os "$os" --arg arch "$arch" --arg kind "$kind" \
        --argjson rollout "$ROLLOUT" --arg min "$MIN_VERSION" --arg build "${CI_PIPELINE_ID:-local}" \
    '{version:$v, channel:$ch, os:$os, arch:$arch, packageType:$kind, rolloutPercent:$rollout,
      minSupportedVersion:(if $min == "" then null else $min end), buildNumber:$build}'
}

for f in "${files[@]}"; do
  meta="$(meta_for "$f")"
  echo "上传 $(basename "$f")：$meta"
  if [[ -n "${ITM_GPG_KEY_ID:-}" && "$f" =~ \.(AppImage|deb|rpm)$ ]]; then
    gpg --batch --yes --local-user "$ITM_GPG_KEY_ID" --armor --detach-sign "$f"
  fi
  (( DRY_RUN == 1 )) && continue
  curl --fail-with-body -sS -X POST "$ITM_SERVER/api/admin/v1/releases" \
    -H "Authorization: Bearer $ITM_RELEASE_TOKEN" \
    -F "meta=$meta;type=application/json" \
    -F "file=@$f;type=application/octet-stream" \
    | jq -e '.code == 0' > /dev/null
  # 差分更新需要 blockmap
  if [[ -f "$f.blockmap" ]]; then
    curl --fail-with-body -sS -X POST "$ITM_SERVER/api/admin/v1/releases/blockmaps" \
      -H "Authorization: Bearer $ITM_RELEASE_TOKEN" \
      -F "meta=$meta;type=application/json" \
      -F "file=@$f.blockmap;type=application/octet-stream" > /dev/null
  fi
done
echo "发布完成：渠道 $CHANNEL，灰度 $ROLLOUT%"
