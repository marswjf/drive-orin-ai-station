#!/usr/bin/env python3
"""在板上安装一个 torchaudio 占位包。

为什么需要：ComfyUI 的 comfy/sd.py 裸 import LTX-Video 的音频 VAE，
那个文件顶层 `import torchaudio`，跳不过去。而 PyPI 的 torchaudio 与板上
NVIDIA 版 torch 的 C++ ABI 不匹配（libtorchaudio.so 报 undefined symbol），
NVIDIA 也没有为 JetPack 5 发对应的 aarch64 轮子。

占位包只保证导入成功。任何真正的音频处理调用都会抛出明确异常，
而不是悄悄返回错误结果——板子用来生图，音频链路本来就不该被走到。

用法：
    python3 torchaudio_stub.py <site-packages 路径>
"""
import os
import shutil
import sys

STUB_INIT = '''\
"""torchaudio 占位实现（IECU 板专用）。

板上是 NVIDIA JetPack 5 版 torch，PyPI 的 torchaudio 与它 ABI 不兼容，
而 NVIDIA 没有发对应轮子。ComfyUI 只在 LTX-Video 的音频 VAE 里用到它，
生图链路完全不涉及，所以这里只提供导入所需的最小结构。

任何实际调用都会抛 RuntimeError —— 宁可明确失败，也不要静默算错。
"""

__version__ = "0.0.0+iecu-stub"
_REASON = (
    "这块板子上没有可用的 torchaudio 原生库："
    "NVIDIA 未为 JetPack 5 发布 aarch64 轮子，PyPI 版本与板上 torch 的 C++ ABI 不兼容。"
    "音频相关功能（如 LTX-Video 的音频 VAE）在本机不可用；图像生成不受影响。"
)


def _unavailable(name):
    def _fn(*args, **kwargs):
        raise RuntimeError("torchaudio.%s 不可用。%s" % (name, _REASON))
    _fn.__name__ = name
    return _fn


class _UnavailableModule(object):
    """按需生成会报错的函数，避免为每个接口写一遍。"""

    def __init__(self, prefix):
        self.__name__ = "torchaudio." + prefix
        self._prefix = prefix

    def __getattr__(self, item):
        if item.startswith("_"):
            raise AttributeError(item)
        return _unavailable("%s.%s" % (self._prefix, item))


class _UnavailableClass(object):
    def __init__(self, *args, **kwargs):
        raise RuntimeError("torchaudio.transforms 不可用。%s" % _REASON)


class _TransformsModule(_UnavailableModule):
    def __getattr__(self, item):
        if item.startswith("_"):
            raise AttributeError(item)
        # transforms 里都是类，返回一个构造即报错的类，
        # 这样 `T.MelSpectrogram(...)` 的失败点更贴近调用处
        if item[:1].isupper():
            return _UnavailableClass
        return _unavailable("transforms.%s" % item)


functional = _UnavailableModule("functional")
transforms = _TransformsModule("transforms")

load = _unavailable("load")
save = _unavailable("save")
info = _unavailable("info")

__all__ = ["functional", "transforms", "load", "save", "info", "__version__"]
'''

SUBMODULE = '''\
from torchaudio import {name} as _m
import sys as _sys

_sys.modules[__name__] = _m
'''


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    sp = sys.argv[1]
    if not os.path.isdir(sp):
        print("site-packages 不存在: %s" % sp)
        return 1

    pkg = os.path.join(sp, "torchaudio")

    # 先清掉装坏的真包（它的 .so 加载不了）
    if os.path.isdir(pkg):
        marker = os.path.join(pkg, "_iecu_stub")
        if not os.path.exists(marker):
            print("移除 ABI 不兼容的 torchaudio 实包")
            shutil.rmtree(pkg, ignore_errors=True)
        else:
            print("占位包已存在，覆盖更新")
            shutil.rmtree(pkg, ignore_errors=True)
    for d in os.listdir(sp):
        if d.startswith("torchaudio-") and d.endswith(".dist-info"):
            shutil.rmtree(os.path.join(sp, d), ignore_errors=True)

    os.makedirs(pkg)
    with open(os.path.join(pkg, "__init__.py"), "w", encoding="utf-8") as f:
        f.write(STUB_INIT)
    open(os.path.join(pkg, "_iecu_stub"), "w").close()

    # torchaudio.functional / torchaudio.transforms 也可能被直接 import
    for name in ("functional", "transforms"):
        with open(os.path.join(pkg, name + ".py"), "w", encoding="utf-8") as f:
            f.write(SUBMODULE.format(name=name))

    print("✓ 已写入占位包 %s" % pkg)

    # 自检
    sys.path.insert(0, sp)
    for m in list(sys.modules):
        if m.startswith("torchaudio"):
            del sys.modules[m]
    import torchaudio
    print("  import torchaudio 成功，版本 %s" % torchaudio.__version__)
    import torchaudio.functional as F
    import torchaudio.transforms as T
    print("  子模块导入成功")
    try:
        F.resample(None, 1, 2)
        print("  ✗ 调用居然没报错")
        return 2
    except RuntimeError as e:
        print("  调用时正确抛错：%s" % str(e)[:48])
    try:
        T.MelSpectrogram(sample_rate=16000)
        print("  ✗ 构造居然没报错")
        return 2
    except RuntimeError:
        print("  transforms 构造时正确抛错")
    return 0


if __name__ == "__main__":
    sys.exit(main())
