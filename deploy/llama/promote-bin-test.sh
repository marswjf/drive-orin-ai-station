#!/bin/sh
# 把 bin-test 提升为生产二进制（或回滚）。全靠改名，不复制不删除，秒级可逆。
#
# 用法:
#   sh promote-bin-test.sh promote     bin-cuda → bin-cuda-<旧build>，bin-test → bin-cuda
#   sh promote-bin-test.sh rollback    反向操作
#   sh promote-bin-test.sh status      看现在是哪个版本在跑
#
# ⚠ 动手前先过 UPGRADE-CHECKLIST.md。性能持平只是第一关，
#   面板的 /metrics 字段名、日志汉化规则、工具调用、向量数值都要验。
# ⚠ 向量服务在 CPU 档用的是 llama/bin（纯 CPU 版），不是 bin-cuda；
#   只换 bin-cuda 时它不受影响。但若把 embeddingBackend 切到 cuda 就会用上新版，
#   那时必须先跑 embed-fingerprint.js diff 确认向量等价（陷阱 34）。
set -u
L=/var/lib/llm/llama
OLD_TAG=${OLD_TAG:-b1-dd1ea52}

ver() { # $1=目录
  [ -x "$1/llama-server" ] || { echo "（无）"; return; }
  LD_LIBRARY_PATH="$1:/usr/lib" "$1/llama-server" --version 2>&1 | head -1
}

case "${1:-status}" in
  status)
    echo "bin-cuda        : $(ver $L/bin-cuda)"
    echo "bin-test        : $(ver $L/bin-test)"
    echo "bin-cuda-$OLD_TAG : $(ver $L/bin-cuda-$OLD_TAG)"
    echo "bin (CPU 版)    : $(ver $L/bin)"
    echo
    echo "正在跑的进程:"
    for p in $(pidof llama-server 2>/dev/null); do
      port=$(tr '\0' '\n' < /proc/$p/cmdline 2>/dev/null | grep -A1 -x -- '--port' | tail -1)
      echo "  pid=$p port=$port exe=$(readlink -f /proc/$p/exe 2>/dev/null)"
    done
    ;;

  promote)
    [ -x "$L/bin-test/llama-server" ] || { echo "★ bin-test 不存在"; exit 1; }
    [ -d "$L/bin-cuda-$OLD_TAG" ] && { echo "★ $L/bin-cuda-$OLD_TAG 已存在，先处理它再来"; exit 1; }
    echo "旧: $(ver $L/bin-cuda)"
    echo "新: $(ver $L/bin-test)"
    systemctl stop llm-server
    mv "$L/bin-cuda" "$L/bin-cuda-$OLD_TAG" || exit 1
    mv "$L/bin-test" "$L/bin-cuda"           || exit 1
    systemctl start llm-server
    echo "已切换。现在 bin-cuda = $(ver $L/bin-cuda)"
    echo "回滚: sh $0 rollback"
    ;;

  rollback)
    [ -d "$L/bin-cuda-$OLD_TAG" ] || { echo "★ 没有 $L/bin-cuda-$OLD_TAG，无法回滚"; exit 1; }
    systemctl stop llm-server
    mv "$L/bin-cuda" "$L/bin-test"           || exit 1
    mv "$L/bin-cuda-$OLD_TAG" "$L/bin-cuda"  || exit 1
    systemctl start llm-server
    echo "已回滚。现在 bin-cuda = $(ver $L/bin-cuda)"
    ;;

  *) echo "用法: $0 promote|rollback|status"; exit 2 ;;
esac
