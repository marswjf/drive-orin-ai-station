#!/usr/bin/env bash
# 从本仓库的 Releases 附件区下载已编译的运行时归档。
#
# 这六个文件单个超过 GitHub 对仓库文件 100 MB 的上限，无法直接放进仓库，
# 因此存放在标签 runtime-v1 之下。该标签只用于存放大文件，不代表软件版本。
#
# 用法：  bash baseline/fetch-runtime.sh
# 依赖：  GitHub CLI（https://cli.github.com/），并已执行 gh auth login

set -euo pipefail

TAG="runtime-v1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$ROOT/baseline"

# 仓库地址取自 git remote；未在 git 仓库内时回落到默认值
REPO="$(git -C "$ROOT" remote get-url origin 2>/dev/null \
        | sed -E 's#(git@|https://)github\.com[:/]##; s#\.git$##' || true)"
REPO="${REPO:-marswjf/drive-orin-ai-station}"

# 文件名 → 存放目录
FILES="
cuda-runtime-libs.tar.gz|runtime
comfyui313-env.tar.gz|runtime
py313.tar.gz|runtime
llama-b10498-5ecbe1ac1-cuda-cpu.tar.gz|llama
torch-2.11.0-cp313-cp313-linux_aarch64.whl|wheels
node|bin
"

command -v gh >/dev/null 2>&1 || {
  echo "未找到 gh 命令。请先安装 GitHub CLI：https://cli.github.com/" >&2
  exit 1
}

echo "仓库：$REPO"
echo "标签：$TAG"
echo "存放位置：$BASE"
echo

for entry in $FILES; do
  name="${entry%%|*}"
  subdir="${entry##*|}"
  dest="$BASE/$subdir"
  mkdir -p "$dest"

  if [ -f "$dest/$name" ]; then
    echo "[已存在] $subdir/$name"
    continue
  fi

  echo "[下载中] $subdir/$name"
  gh release download "$TAG" --repo "$REPO" --pattern "$name" --dir "$dest"
done

chmod +x "$BASE/bin/node" 2>/dev/null || true

echo
echo "校验 llama.cpp 归档的 SHA-256"

if command -v sha256sum >/dev/null 2>&1; then
  SHA="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  SHA="shasum -a 256"
else
  echo "未找到 sha256sum 或 shasum，跳过校验。" >&2
  SHA=""
fi

if [ -n "$SHA" ]; then
  cd "$BASE/llama"
  for f in *.sha256; do
    [ -f "$f" ] || continue
    # 校验文件对应的归档不存在时跳过，不作为失败
    [ -f "${f%.sha256}" ] || continue
    if $SHA -c "$f" >/dev/null 2>&1; then
      echo "  通过  ${f%.sha256}"
    else
      echo "  失败  ${f%.sha256}  文件可能未下载完整，请删除后重新执行本脚本" >&2
      exit 1
    fi
  done
fi

echo
echo "全部完成。接下来按 .claude/skills/iecu-provision/WORKFLOW.md 开始部署。"
