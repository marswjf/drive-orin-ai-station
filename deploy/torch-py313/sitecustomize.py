# IECU-TLS-FIX 2026-09-02
# 板上落点：/var/lib/llm/comfyui313/venv/lib/python3.13/site-packages/sitecustomize.py
#
# 为什么需要这个文件
# ------------------
# 去掉 ComfyUI 的 --highvram 之后，cli_args.py 的 enables_dynamic_vram() 返回 True
# （它的判据是 `not args.highvram and not args.gpu_only and not args.novram and
#  not args.cpu`，--highvram 是一票否决项），main.py 随即调用
# comfy_aimdo.control.init() 启用 DynamicVRAM。
#
# aimdo 的 C 扩展用 initial-exec TLS 模型，会吃掉 glibc 的 static TLS 余量。
# 板子是 Ubuntu focal / glibc 2.31，surplus static TLS 是编译期固定值，
# 且 2.31 还没有 glibc.rtld.optional_static_tls 这个 tunable 可以调大
# （该 tunable 是 glibc 2.32 之后才有的，实测在本板设了也无效）。
# 于是随后 import torch 时 libc10.so 再申请 static TLS 就失败：
#
#   ImportError: /var/lib/llm/comfyui313/venv/lib/python3.13/site-packages/
#   torch/lib/libc10.so: cannot allocate memory in static TLS block
#
# 表现是 ComfyUI 起不来、systemd 按 Restart=on-failure 每 15 秒重试一次。
# ⚠ 这个报错和显存、和内存余量都没有关系（实测发生时 used 仅 4.3 GB）。
# 不知道这一层的人会得出"去掉 --highvram 就起不来"的结论，
# 从而永远用不上 DynamicVRAM —— 这块板子从 2026-08-16 升到 ComfyUI 0.33.0 起
# 就一直是这个状态，comfy-aimdo 0.4.13 装着但从未生效。
#
# 解法
# ----
# 让 torch 在 aimdo 之前拿到 static TLS 额度。Python 解释器启动时会自动
# import sitecustomize（如果它在 sys.path 上），时机早于 main.py 的任何一行，
# 所以不必改 ComfyUI 源码，升级 ComfyUI 也不会冲掉。
#
# 回滚
# ----
# 删掉这个文件即可。但删掉之后必须同时把 --highvram 加回 comfyui.service，
# 否则 ComfyUI 起不来。两者是绑定的。
try:
    import torch  # noqa: F401
except Exception:
    # 预加载失败不能让解释器起不来——真正需要 torch 的地方会自己报错，
    # 那里的报错信息比这里清楚。
    pass
