#!/usr/bin/env python3
"""把 ComfyUI 里的 match/case 改写成 if/elif，让它能在 Python 3.8 上跑。

为什么需要：板上驱动是 CUDA 12.1，能用的 PyTorch 只有 NVIDIA JetPack 5 那版
（CUDA 11.4 编译、原生 sm_87），而它只发 cp38 轮子。ComfyUI 主体本身兼容 3.8，
唯一的例外是 LTX-Video 音频 autoencoder 用了 3.10 才有的 match 语法。

改写是等价的：`case X.Y:` 在 match 里对枚举成员做的就是相等比较，
or-pattern `case A | B:` 等于 `in (A, B)`，`case _:` 等于 else。

升级 ComfyUI 之后重跑本脚本即可。已经改过的文件会被识别并跳过。

用法：
    python3 patch-py38.py /var/lib/llm/comfyui
    python3 patch-py38.py /var/lib/llm/comfyui --check   # 只检查不改
"""
import ast
import os
import sys

# (相对路径, [(原文, 替换后), ...])
PATCHES = [
    # ── PyAV 版本差异 ───────────────────────────────────────────────
    # ComfyUI 新版读图统一走 PyAV（PNG 也走），代码里直接取 frame.rotation，
    # 那是 av 13+ 才有的属性。板上是 av 12.3.0（py3.8 能装到的最高版），
    # 于是任何 LoadImage 都报 'VideoFrame' object has no attribute 'rotation'。
    # 这个不能靠 shim 绕：VideoFrame 是 C 扩展类型，给它设类属性直接 TypeError，
    # 只能改调用点。取不到就按 0 处理，等价于"没有旋转元数据"，
    # 对 PNG/JPG 静态图恒真，对带旋转元数据的视频才有差别。
    (
        "comfy_api/latest/_input_impl/video_types.py",
        [
            (
                """                        if frame.rotation != 0:
                            k = int(round(frame.rotation // 90))""",
                """                        _rot = getattr(frame, "rotation", 0) or 0
                        if _rot != 0:
                            k = int(round(_rot // 90))""",
            ),
            (
                """                            rotation_k = int(round(frame.rotation // 90)) % 4 if frame.rotation else 0""",
                """                            _rot2 = getattr(frame, "rotation", 0) or 0
                            rotation_k = int(round(_rot2 // 90)) % 4 if _rot2 else 0""",
            ),
        ],
    ),
    (
        "comfy/ldm/lightricks/vae/causal_audio_autoencoder.py",
        [
            (
                """        match self.causality_axis:
            case CausalityAxis.NONE:
                self.padding = (pad_w // 2, pad_w - pad_w // 2, pad_h // 2, pad_h - pad_h // 2)
            case CausalityAxis.WIDTH | CausalityAxis.WIDTH_COMPATIBILITY:
                self.padding = (pad_w, 0, pad_h // 2, pad_h - pad_h // 2)
            case CausalityAxis.HEIGHT:
                self.padding = (pad_w // 2, pad_w - pad_w // 2, pad_h, 0)
            case _:
                raise ValueError(f"Invalid causality_axis: {causality_axis}")""",
                """        if self.causality_axis == CausalityAxis.NONE:
            self.padding = (pad_w // 2, pad_w - pad_w // 2, pad_h // 2, pad_h - pad_h // 2)
        elif self.causality_axis in (CausalityAxis.WIDTH, CausalityAxis.WIDTH_COMPATIBILITY):
            self.padding = (pad_w, 0, pad_h // 2, pad_h - pad_h // 2)
        elif self.causality_axis == CausalityAxis.HEIGHT:
            self.padding = (pad_w // 2, pad_w - pad_w // 2, pad_h, 0)
        else:
            raise ValueError(f"Invalid causality_axis: {causality_axis}")""",
            ),
            (
                """            match self.causality_axis:
                case CausalityAxis.NONE:
                    pass  # x remains unchanged
                case CausalityAxis.HEIGHT:
                    x = x[:, :, 1:, :]
                case CausalityAxis.WIDTH:
                    x = x[:, :, :, 1:]
                case CausalityAxis.WIDTH_COMPATIBILITY:
                    pass  # x remains unchanged
                case _:
                    raise ValueError(f"Invalid causality_axis: {self.causality_axis}")""",
                """            if self.causality_axis == CausalityAxis.NONE:
                pass  # x remains unchanged
            elif self.causality_axis == CausalityAxis.HEIGHT:
                x = x[:, :, 1:, :]
            elif self.causality_axis == CausalityAxis.WIDTH:
                x = x[:, :, :, 1:]
            elif self.causality_axis == CausalityAxis.WIDTH_COMPATIBILITY:
                pass  # x remains unchanged
            else:
                raise ValueError(f"Invalid causality_axis: {self.causality_axis}")""",
            ),
            (
                """            match self.causality_axis:
                case CausalityAxis.NONE:
                    pad = (0, 1, 0, 1)
                case CausalityAxis.WIDTH:
                    pad = (2, 0, 0, 1)
                case CausalityAxis.HEIGHT:
                    pad = (0, 1, 2, 0)
                case CausalityAxis.WIDTH_COMPATIBILITY:
                    pad = (1, 0, 0, 1)
                case _:
                    raise ValueError(f"Invalid causality_axis: {self.causality_axis}")""",
                """            if self.causality_axis == CausalityAxis.NONE:
                pad = (0, 1, 0, 1)
            elif self.causality_axis == CausalityAxis.WIDTH:
                pad = (2, 0, 0, 1)
            elif self.causality_axis == CausalityAxis.HEIGHT:
                pad = (0, 1, 2, 0)
            elif self.causality_axis == CausalityAxis.WIDTH_COMPATIBILITY:
                pad = (1, 0, 0, 1)
            else:
                raise ValueError(f"Invalid causality_axis: {self.causality_axis}")""",
            ),
            (
                """    match attn_type:
        case AttentionType.VANILLA:
            return AttnBlock(in_channels, norm_type=norm_type)
        case AttentionType.NONE:
            return nn.Identity(in_channels)
        case AttentionType.LINEAR:
            raise NotImplementedError(f"Attention type {attn_type.value} is not supported yet.")
        case _:
            raise ValueError(f"Unknown attention type: {attn_type}")""",
                """    if attn_type == AttentionType.VANILLA:
        return AttnBlock(in_channels, norm_type=norm_type)
    elif attn_type == AttentionType.NONE:
        return nn.Identity(in_channels)
    elif attn_type == AttentionType.LINEAR:
        raise NotImplementedError(f"Attention type {attn_type.value} is not supported yet.")
    else:
        raise ValueError(f"Unknown attention type: {attn_type}")""",
            ),
        ],
    ),
]


def scan(root):
    """返回所有 py3.8 语法不兼容的文件"""
    skip = {".git", "tests", "tests-unit", "custom_nodes", "web", "venv", "__pycache__"}
    bad = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in skip and not d.startswith(".")]
        for fn in filenames:
            if not fn.endswith(".py"):
                continue
            p = os.path.join(dirpath, fn)
            try:
                src = open(p, encoding="utf-8").read()
            except Exception:
                continue
            try:
                ast.parse(src, filename=p, feature_version=(3, 8))
            except SyntaxError as e:
                bad.append((os.path.relpath(p, root), e.lineno, e.msg))
            except Exception:
                pass
    return bad


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    root = sys.argv[1]
    check_only = "--check" in sys.argv

    if not os.path.isdir(root):
        print("目录不存在: %s" % root)
        return 1

    print("扫描 %s" % root)
    bad = scan(root)
    print("  py3.8 不兼容的文件: %d" % len(bad))
    for f, ln, msg in bad:
        print("    %s:%s  %s" % (f, ln, str(msg)[:70]))

    if check_only:
        return 0 if not bad else 2

    # ⚠ 这里以前是「bad 为空就直接 return」，那是错的：
    # PATCHES 里除了 match/case 那类语法问题，还有 frame.rotation 这类
    # **运行时**不兼容——语法扫描永远看不见它们，scan() 返回 0 是正常的。
    # 一旦提前返回，补丁静默不应用，现场表现是「脚本说无需改写，服务照样报错」。
    # 所以扫描结果只用于打印，PATCHES 一律走一遍（每条自己判断是否已应用，幂等）。
    if not bad:
        print("  语法层面无需改写；继续检查运行时兼容补丁")

    changed = 0
    for rel, subs in PATCHES:
        path = os.path.join(root, rel)
        if not os.path.isfile(path):
            print("  跳过（文件不存在）: %s" % rel)
            continue
        src = open(path, encoding="utf-8").read()
        orig = src
        applied = 0
        for old, new in subs:
            n = src.count(old)
            if n == 0:
                if new.split("\n")[0].strip() in src:
                    continue  # 已经改过
                print("  ⚠ 未匹配到片段（上游可能改了代码）: %s" % rel)
                print("    片段首行: %s" % old.split("\n")[0].strip())
                continue
            if n > 1:
                print("  ⚠ 片段出现 %d 次，跳过以免误改: %s" % (n, rel))
                continue
            src = src.replace(old, new)
            applied += 1
        if src == orig:
            continue
        # 改完必须能按 3.8 解析，否则不落盘
        try:
            ast.parse(src, filename=path, feature_version=(3, 8))
        except SyntaxError as e:
            print("  ✗ 改写后仍不兼容，放弃: %s:%s %s" % (rel, e.lineno, e.msg))
            continue
        if not os.path.exists(path + ".orig"):
            open(path + ".orig", "w", encoding="utf-8").write(orig)
        open(path, "w", encoding="utf-8").write(src)
        print("  ✓ 改写 %s（%d 处，原文件备份为 .orig）" % (rel, applied))
        changed += 1

    print("")
    print("复查：")
    bad2 = scan(root)
    if bad2:
        print("  仍有 %d 个文件不兼容:" % len(bad2))
        for f, ln, msg in bad2:
            print("    %s:%s  %s" % (f, ln, str(msg)[:70]))
        return 2
    print("  全部 py3.8 兼容")
    return 0


if __name__ == "__main__":
    sys.exit(main())
