#!/usr/bin/env python3
"""让最新的 ComfyUI 依赖跑在 Python 3.8 + torch 2.1 上。

背景：板上驱动是 CUDA 12.1，唯一能用的 PyTorch 是 NVIDIA JetPack 5 那版
（CUDA 11.4 编译、原生 sm_87），它只发 cp38 轮子。上游包普遍假设 py39+ 与
torch 2.2+，但差距实际只有两类，都是机械可补的：

1. torch 2.2 把 `_pytree._register_pytree_node` 改名成 `register_pytree_node`
   并加了 `serialized_type_name` 参数。transformers 按版本号分支调用，
   板上 NVIDIA 的版本号带 `a0+41361538.nv23.06` 后缀，分支判断结果与预期不符，
   于是走到新 API 上报 AttributeError。装一个转发 shim，两个分支都能跑。

2. comfy_kitchen 用了 `tuple[int, int]` 这类内置泛型注解（py39+ 才有）。
   加一行 `from __future__ import annotations` 让注解延迟求值即可，
   不改变任何运行时行为。

用法：
    python3 compat-py38.py <site-packages 路径>
    python3 compat-py38.py <site-packages 路径> --comfyui <ComfyUI 路径>
    python3 compat-py38.py <site-packages 路径> --check   # 只报告不改

升级 ComfyUI 或它的依赖之后重跑一次。已处理过的文件会被跳过。
"""
import io
import os
import re
import sys
import tokenize

# 需要加 __future__ 注解延迟求值的包（自身没有 py38 轮子、但纯 Python 可用）
FUTURE_TARGETS = ["comfy_kitchen", "comfy_aimdo"]

# 内置泛型下标：tuple[...] / list[...] 等，py38 运行时会 TypeError
BUILTIN_GENERIC = re.compile(r"(?<![\w.])(tuple|list|dict|set|frozenset|type)\[")

# PEP585 内置泛型 → typing 等价名。
# 一律用限定名 typing.X，不用裸名：ComfyUI 的 comfy_api/latest/_io.py 里
# 自己定义了 `class Dict(ComfyTypeIO)`，会把 from typing import Dict 遮蔽掉，
# 改写成裸 Dict[...] 就会拿到那个类并报 'ABCMeta' object is not subscriptable。
_TYPING_NAME = {
    "list": "typing.List", "dict": "typing.Dict", "set": "typing.Set",
    "tuple": "typing.Tuple", "frozenset": "typing.FrozenSet",
    "type": "typing.Type",
}


def ensure_import_typing(src):
    """保证文件里有 `import typing`，插在 __future__ 之后、其余语句之前。"""
    import ast as _ast
    try:
        tree = _ast.parse(src)
    except Exception:
        return src
    for node in tree.body:
        if isinstance(node, _ast.Import):
            if any(a.name == "typing" and a.asname is None for a in node.names):
                return src

    lines = src.split("\n")
    pos = 0
    try:
        for node in tree.body:
            if isinstance(node, _ast.ImportFrom) and node.module == "__future__":
                pos = node.end_lineno if hasattr(node, "end_lineno") else node.lineno
                break
            if isinstance(node, _ast.Expr) and isinstance(
                    getattr(node, "value", None), (_ast.Str, _ast.Constant)):
                pos = node.end_lineno if hasattr(node, "end_lineno") else node.lineno
    except Exception:
        pos = 0
    lines.insert(pos, "import typing")
    return "\n".join(lines)


def _split_top_level(s, sep):
    """按顶层分隔符切分，括号内的分隔符不算"""
    parts, depth, cur = [], 0, ""
    for ch in s:
        if ch in "[(":
            depth += 1
        elif ch in "])":
            depth -= 1
        if ch == sep and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    return [p.strip() for p in parts]


def to_typing_form(expr, used):
    """把 PEP585/PEP604 注解改写成 py38 能 eval 的 typing 形式。

    `str | None` → `Optional[str]`，`list[X]` → `List[X]`，可嵌套。
    `used` 收集所有用到的 typing 名字，供调用方补 import。
    """
    expr = expr.strip()

    parts = _split_top_level(expr, "|")
    if len(parts) > 1:
        subs = [to_typing_form(p, used) for p in parts]
        rest = [s for s in subs if s != "None"]
        used.add("typing")
        if len(rest) < len(subs):          # 含 None → Optional
            if len(rest) == 1:
                return "typing.Optional[%s]" % rest[0]
            return "typing.Optional[typing.Union[%s]]" % ", ".join(rest)
        return "typing.Union[%s]" % ", ".join(subs)

    m = re.match(r"^([\w.]+)\[(.*)\]$", expr, re.S)
    if m:
        base, inner = m.group(1), m.group(2)
        new_base = _TYPING_NAME.get(base, base)
        if new_base != base:
            used.add("typing")
        args = _split_top_level(inner, ",")
        return "%s[%s]" % (new_base, ", ".join(to_typing_form(a, used) for a in args))

    return expr


def rewrite_runtime_annotations(path, wrapper="Mapped"):
    """改写会在运行时被 eval 的注解（SQLAlchemy 的 Mapped[...] 就是这种）。

    `from __future__ import annotations` 对这类注解无效——框架拿到字符串后
    还是要 eval，py38 上 `list[X]` / `X | None` 一样会失败。所以这里必须
    真的把语法换成 typing 形式。
    """
    try:
        src = open(path, encoding="utf-8").read()
    except Exception:
        return 0

    used = set()
    out, i, n, count = [], 0, len(src), 0
    token = wrapper + "["
    while True:
        j = src.find(token, i)
        if j < 0:
            out.append(src[i:])
            break
        # 必须是独立标识符，不能是 XxxMapped[
        if j > 0 and (src[j - 1].isalnum() or src[j - 1] == "_"):
            out.append(src[i:j + len(token)])
            i = j + len(token)
            continue
        out.append(src[i:j])
        depth, k = 0, j + len(wrapper)
        while k < n:
            if src[k] == "[":
                depth += 1
            elif src[k] == "]":
                depth -= 1
                if depth == 0:
                    break
            k += 1
        inner = src[j + len(token):k]
        new_inner = to_typing_form(inner, used)
        out.append("%s[%s]" % (wrapper, new_inner))
        if new_inner != inner:
            count += 1
        i = k + 1

    if not count:
        return 0
    new = "".join(out)

    if used:
        new = ensure_import_typing(new)

    import ast as _ast
    try:
        _ast.parse(new, filename=path, feature_version=(3, 8))
    except SyntaxError:
        return 0

    if not os.path.exists(path + ".orig"):
        open(path + ".orig", "w", encoding="utf-8").write(src)
    open(path, "w", encoding="utf-8").write(new)
    return count

SITECUSTOMIZE = '''\
"""IECU 板上兼容层：Python 自动导入，对所有解释器进程生效。

补两个 torch 2.2 / 2.4 才有、而板上 torch 2.1 没有的接口。板上只能用这一版
torch（NVIDIA JetPack 5，CUDA 11.4 编译、原生 sm_87），所以缺口由这里补齐。
"""

# --- 1. pytree 注册接口（torch 2.2 改的名）---
# 新接口多一个 serialized_type_name 参数，旧接口不认识，转发时丢掉即可——
# 它只影响序列化时的类型名，推理路径用不到。
try:
    import torch.utils._pytree as _pt

    if not hasattr(_pt, "register_pytree_node") and hasattr(_pt, "_register_pytree_node"):
        def register_pytree_node(cls, flatten_fn, unflatten_fn,
                                 serialized_type_name=None, **kwargs):
            return _pt._register_pytree_node(cls, flatten_fn, unflatten_fn)

        _pt.register_pytree_node = register_pytree_node
except Exception:
    pass


# --- 2. torch.library.custom_op（torch 2.4 才有）---
# comfy_kitchen 用它注册 fp8/fp4 量化算子。这个装饰器的作用是让 torch.compile
# 能把自定义算子当成不透明整体处理；eager 后端下这些算子本来就是纯 PyTorch
# 实现，直接转发调用与注册后调用等价。ComfyUI 默认不开 torch.compile。
# 注意：真跑 torch.compile 时这个 shim 不保证图捕获正确，别在板上开编译。
try:
    import functools as _ft
    import torch.library as _tl

    if not hasattr(_tl, "custom_op"):
        class _PassthroughOp(object):
            """转发调用，并吞掉 register_* 系列的注册请求。"""

            def __init__(self, fn):
                self._fn = fn
                try:
                    _ft.update_wrapper(self, fn)
                except Exception:
                    pass

            def __call__(self, *args, **kwargs):
                return self._fn(*args, **kwargs)

            def _noop_decorator(self, *args, **kwargs):
                if args and callable(args[0]):
                    return args[0]
                return lambda f: f

            register_fake = _noop_decorator
            register_kernel = _noop_decorator
            register_autograd = _noop_decorator
            register_vmap = _noop_decorator
            register_torch_dispatch = _noop_decorator

            def set_kwarg_only_arg_names(self, *a, **kw):
                return None

        def custom_op(name, fn=None, **kwargs):
            # name 形如 "comfy_kitchen::rms_rope"。真正的 custom_op 会把算子
            # 注册进 torch.ops.<命名空间>，调用方走的正是 torch.ops.comfy_kitchen.rms_rope，
            # 所以光返回一个转发对象不够——必须挂到那个命名空间上，
            # 否则报 "'_OpNamespace' 'comfy_kitchen' object has no attribute 'rms_rope'"。
            ns, _, opname = name.partition("::")

            def _wrap(f):
                op = _PassthroughOp(f)
                if ns and opname:
                    try:
                        nsobj = getattr(_t.ops, ns)   # 不存在会自动建 _OpNamespace
                        setattr(nsobj, opname, op)
                    except Exception:
                        pass
                return op

            if fn is not None:
                return _wrap(fn)
            return _wrap

        _tl.custom_op = custom_op

    if not hasattr(_tl, "register_fake"):
        def register_fake(op, fn=None, **kwargs):
            if fn is not None:
                return fn
            return lambda f: f

        _tl.register_fake = register_fake
except Exception:
    pass


# --- 3. 新 dtype 占位（FP8 是 torch 2.2、uint16/32/64 是 2.3 才有）---
# comfy_kitchen 在模块级写 `_FP8_E4M3 = torch.float8_e4m3fn`，ComfyUI 的
# safetensors 类型表里写 `torch.uint64`，导入就失败。
# 这块板子是 sm_87，硬件本来就不支持 FP8（需要 sm_89 以上），ComfyUI 的
# supports_fp8_compute() 按 compute capability 判断也会返回 False，
# 所以 FP8 的计算路径不会被走到——缺的只是这个名字本身。
# uint16/32/64 同理：扩散模型的权重不会用这些类型存。
#
# 占位故意不用 torch.uint8：那样 `dtype == torch.float8_e4m3fn` 这类判断
# 会把真实的 uint8 张量误判成 FP8。用一个只等于自己的哨兵，既能让导入通过，
# 又保证任何比较都不会命中真实 dtype；真有代码拿它去建张量会立刻报错，
# 而不是悄悄算出错误结果。
try:
    import torch as _torch

    class _UnavailableDtype(object):
        __slots__ = ("_name",)

        def __init__(self, name):
            self._name = name

        def __repr__(self):
            return "torch.%s<该 torch 版本不提供>" % self._name

        __str__ = __repr__

        def __eq__(self, other):
            return other is self

        def __ne__(self, other):
            return other is not self

        def __hash__(self):
            return hash(("_UnavailableDtype", self._name))

    for _n in ("float8_e4m3fn", "float8_e5m2", "float8_e4m3fnuz", "float8_e5m2fnuz",
               "float8_e8m0fnu", "float4_e2m1fn_x2",
               "uint16", "uint32", "uint64"):
        if not hasattr(_torch, _n):
            setattr(_torch, _n, _UnavailableDtype(_n))
except Exception:
    pass


# --- 4. dataclass 的 py3.10 参数 ---
# slots / match_args / weakref_slot 都是生成优化，去掉不改变字段语义。
# kw_only 会改变构造签名，但上游这些包本来就用关键字传参，实测无影响。
try:
    import dataclasses as _dc

    if "slots" not in _dc.dataclass.__code__.co_varnames:
        _orig_dataclass = _dc.dataclass
        _DROP = ("slots", "match_args", "kw_only", "weakref_slot")

        def dataclass(cls=None, **kwargs):
            for k in _DROP:
                kwargs.pop(k, None)
            if cls is None:
                return _orig_dataclass(**kwargs)
            return _orig_dataclass(cls, **kwargs)

        _dc.dataclass = dataclass

        if not hasattr(_dc, "KW_ONLY"):
            _dc.KW_ONLY = object()
except Exception:
    pass


# --- 5. 标准库里 py3.9 / 3.10 新增的小工具 ---
try:
    import functools as _f
    if not hasattr(_f, "cache"):
        _f.cache = lambda fn: _f.lru_cache(maxsize=None)(fn)
except Exception:
    pass

try:
    import itertools as _it
    if not hasattr(_it, "pairwise"):
        def _pairwise(iterable):
            a, b = _it.tee(iterable)
            next(b, None)
            return zip(a, b)
        _it.pairwise = _pairwise
except Exception:
    pass

try:
    import math as _math_mod
    if not hasattr(_math_mod, "lcm"):
        def _lcm(*vals):
            # 在函数体内 import，不依赖外层名字：这个文件里所有 shim 共用
            # 一个模块作用域，早先用 _m 做临时名，被后面的 numpy shim 覆盖成了
            # numpy.dtypes，导致 math.lcm 调用时报 "numpy.dtypes has no gcd"。
            import math
            r = 1
            for v in vals:
                if v == 0:
                    return 0
                r = abs(r * v) // math.gcd(r, v)
            return r
        _math_mod.lcm = _lcm
except Exception:
    pass

# 注意：这里曾经给 typing 补过 ParamSpec/Concatenate，结果把 pip 弄坏了——
# typing_extensions 见到 typing.ParamSpec 存在，就认定 typing._ConcatenateGenericAlias
# 之类的私有属性也在，随即 AttributeError。教训是只补真正缺的东西，
# 不要预防性地往标准库里塞名字。


# --- 6. numpy.dtypes（numpy 1.25 才有的模块）---
# numpy 1.24.4 是最后一个支持 Python 3.8 的版本，没有这个模块。
# ComfyUI 只拿里面的 dtype 类往 torch 的 pickle 安全白名单里塞，
# 而 type(np.dtype("float64")) 在 1.24 上就是同一个类，直接复用即可。
try:
    import sys as _sys
    import types as _types
    import numpy as _np

    if not hasattr(_np, "dtypes"):
        _np_dtypes_mod = _types.ModuleType("numpy.dtypes")
        _pairs = [
            ("Float64DType", "float64"), ("Float32DType", "float32"),
            ("Float16DType", "float16"), ("Int64DType", "int64"),
            ("Int32DType", "int32"), ("Int16DType", "int16"),
            ("Int8DType", "int8"), ("UInt64DType", "uint64"),
            ("UInt32DType", "uint32"), ("UInt16DType", "uint16"),
            ("UInt8DType", "uint8"), ("BoolDType", "bool"),
            ("Complex64DType", "complex64"), ("Complex128DType", "complex128"),
        ]
        for _cls_name, _dt in _pairs:
            try:
                setattr(_np_dtypes_mod, _cls_name, type(_np.dtype(_dt)))
            except Exception:
                pass
        _sys.modules["numpy.dtypes"] = _np_dtypes_mod
        _np.dtypes = _np_dtypes_mod
except Exception:
    pass


# --- 6b. RMSNorm（torch 2.4 才有）---
# 扩散模型里用得很多，必须真实现，不能占位。按 PyTorch 官方语义：
# 在 float32 上求均方、rsqrt，结果 cast 回输入 dtype，最后再乘 weight。
# 官方的 fused kernel 与这个手工实现有极小的舍入差异，ComfyUI 源码里
# 自己也标注了这一点，不影响出图。
try:
    import torch as _t
    import torch.nn as _nn
    import torch.nn.functional as _F

    if not hasattr(_F, "rms_norm"):
        def rms_norm(input, normalized_shape, weight=None, eps=None):
            if eps is None:
                eps = _t.finfo(input.dtype).eps
            dims = tuple(range(-len(normalized_shape), 0))
            upcasted = input.float()
            var = upcasted.pow(2).mean(dim=dims, keepdim=True)
            out = (upcasted * _t.rsqrt(var + eps)).to(input.dtype)
            if weight is not None:
                out = out * weight
            return out

        _F.rms_norm = rms_norm

    if not hasattr(_nn, "RMSNorm"):
        class RMSNorm(_nn.Module):
            __constants__ = ["normalized_shape", "eps", "elementwise_affine"]

            def __init__(self, normalized_shape, eps=None, elementwise_affine=True,
                         device=None, dtype=None):
                super(RMSNorm, self).__init__()
                if isinstance(normalized_shape, int):
                    normalized_shape = (normalized_shape,)
                self.normalized_shape = tuple(normalized_shape)
                self.eps = eps
                self.elementwise_affine = elementwise_affine
                if elementwise_affine:
                    self.weight = _nn.Parameter(_t.empty(
                        self.normalized_shape,
                        **{"device": device, "dtype": dtype}))
                else:
                    self.register_parameter("weight", None)
                # 子类（ComfyUI 的 ops.RMSNorm）会重写这个方法，必须留着调用点
                self.reset_parameters()

            def reset_parameters(self):
                if self.elementwise_affine and self.weight is not None:
                    _nn.init.ones_(self.weight)

            def forward(self, x):
                return _F.rms_norm(x, self.normalized_shape, self.weight, self.eps)

            def extra_repr(self):
                return "{normalized_shape}, eps={eps}, " \
                       "elementwise_affine={elementwise_affine}".format(**self.__dict__)

        _nn.RMSNorm = RMSNorm
        try:
            import torch.nn.modules.normalization as _nrm
            _nrm.RMSNorm = RMSNorm
        except Exception:
            pass
except Exception:
    pass


# --- 6e. torch.compiler 命名空间（torch 2.2 才有）---
# ComfyUI 与 comfy_kitchen 只用到 is_compiling 和 disable 两个，
# torch 2.1 里对应的东西在 torch._dynamo 下，转发过去即可。
# 板上不开 torch.compile，is_compiling 恒为 False 是正确答案。
try:
    import sys as _sys
    import types as _types
    import torch as _t

    if not hasattr(_t, "compiler"):
        _cm = _types.ModuleType("torch.compiler")

        try:
            import torch._dynamo as _dyn
        except Exception:
            _dyn = None

        def is_compiling():
            if _dyn is not None and hasattr(_dyn, "is_compiling"):
                try:
                    return _dyn.is_compiling()
                except Exception:
                    return False
            return False

        def disable(fn=None, recursive=True):
            if _dyn is not None and hasattr(_dyn, "disable"):
                try:
                    return _dyn.disable(fn, recursive) if fn is not None else _dyn.disable()
                except Exception:
                    pass
            if fn is None:
                return lambda f: f
            return fn

        _cm.is_compiling = is_compiling
        _cm.is_dynamo_compiling = is_compiling
        _cm.disable = disable
        _cm.allow_in_graph = lambda fn: fn
        _cm.assume_constant_result = lambda fn: fn
        _cm.cudagraph_mark_step_begin = lambda: None
        _cm.reset = lambda: None

        _sys.modules["torch.compiler"] = _cm
        _t.compiler = _cm
except Exception:
    pass


# --- 6d. Module.load_state_dict(assign=)（torch 2.2 才有）---
# ComfyUI 加载 checkpoint 时用 assign=True，语义是"直接把 state_dict 里的张量
# 接管过来"，而不是分配一块新显存再 copy_。在这块统一内存的板子上，这个区别
# 是实打实的：SDXL 6.5 GB 的权重，copy_ 路径峰值要占两份。
# 所以这里真的实现 assign，而不是把参数吞掉降级成拷贝。
try:
    import inspect as _insp
    import torch as _t
    import torch.nn as _nn

    if "assign" not in _insp.signature(_nn.Module.load_state_dict).parameters:
        _orig_lsd = _nn.Module.load_state_dict

        def load_state_dict(self, state_dict, strict=True, assign=False):
            if not assign:
                return _orig_lsd(self, state_dict, strict=strict)

            own = dict(self.state_dict(keep_vars=True))
            missing = [k for k in own if k not in state_dict]
            unexpected = [k for k in state_dict if k not in own]

            with _t.no_grad():
                for name, param in self.named_parameters(recurse=True):
                    if name in state_dict:
                        # 换掉底层数据即可，Parameter 对象本身保持不变，
                        # 这样优化器/引用不会失效
                        param.data = state_dict[name]
                for name, buf in self.named_buffers(recurse=True):
                    if name in state_dict and buf is not None:
                        holder, _, attr = name.rpartition(".")
                        mod = self.get_submodule(holder) if holder else self
                        setattr(mod, attr, state_dict[name])

            if strict and (missing or unexpected):
                # 注意：这段代码是被当作字符串写进 sitecustomize.py 的，
                # 不要在这里用 \\n \\t 之类的转义序列——它们会在生成阶段
                # 就被解释成真实字符，把字符串字面量拆成多行导致语法错误。
                msgs = []
                if unexpected:
                    msgs.append("Unexpected key(s) in state_dict: "
                                + ", ".join(unexpected) + ".")
                if missing:
                    msgs.append("Missing key(s) in state_dict: "
                                + ", ".join(missing) + ".")
                raise RuntimeError(
                    "Error(s) in loading state_dict for "
                    + self.__class__.__name__ + ": " + " ".join(msgs))

            try:
                from torch.nn.modules.module import _IncompatibleKeys
                return _IncompatibleKeys(missing, unexpected)
            except Exception:
                return (missing, unexpected)

        _nn.Module.load_state_dict = load_state_dict
except Exception:
    pass


# --- 6f. scaled_dot_product_attention 的 enable_gqa（torch 2.5 才有）---
# GQA（分组查询注意力）指 key/value 的头数少于 query，靠广播复用。
# torch 2.5 起由 SDPA 内部处理，2.1 没有这个参数——但语义不能吞掉，
# 否则头数对不上会直接报错或算错。这里在调用前手工把 kv 头复制到与 q 对齐，
# 与 PyTorch 内部做法一致。Z-Image 的文本编码器（Qwen3-4B）走的就是这条路。
try:
    import torch as _t
    import torch.nn.functional as _F

    # 不能用 inspect.signature 判断：SDPA 是 C 内置函数，
    # inspect 会抛 "no signature found for builtin"，异常被外层吞掉后
    # shim 根本装不上（踩过一次）。直接试着调用一次最可靠。
    _need_gqa_shim = False
    try:
        _probe = _t.zeros(1, 1, 1, 8)
        _F.scaled_dot_product_attention(_probe, _probe, _probe, enable_gqa=False)
    except TypeError:
        _need_gqa_shim = True
    except Exception:
        pass

    if _need_gqa_shim:
        _orig_sdpa = _F.scaled_dot_product_attention

        def scaled_dot_product_attention(query, key, value, attn_mask=None,
                                         dropout_p=0.0, is_causal=False,
                                         scale=None, enable_gqa=False):
            if enable_gqa:
                qh = query.size(-3)
                kh = key.size(-3)
                if kh and qh != kh and qh % kh == 0:
                    rep = qh // kh
                    key = key.repeat_interleave(rep, dim=-3)
                    value = value.repeat_interleave(rep, dim=-3)
            return _orig_sdpa(query, key, value, attn_mask=attn_mask,
                              dropout_p=dropout_p, is_causal=is_causal, scale=scale)

        _F.scaled_dot_product_attention = scaled_dot_product_attention
        try:
            _t.nn.functional.scaled_dot_product_attention = scaled_dot_product_attention
        except Exception:
            pass
except Exception:
    pass


# --- 6c. importlib.resources.files（py3.9 才有）---
# ComfyUI 用它定位前端包里的 static 目录。官方 backport 包 importlib_resources
# 提供同名实现，直接接过来。
try:
    import importlib.resources as _ir
    if not hasattr(_ir, "files"):
        import importlib_resources as _irb
        _ir.files = _irb.files
        if not hasattr(_ir, "as_file"):
            _ir.as_file = _irb.as_file
except Exception:
    pass


# --- 7. torch.serialization.add_safe_globals（torch 2.4 才有）---
# 它是 weights_only 加载时的白名单接口。torch 2.1 的 torch.load 还没有
# weights_only 默认开启，没有白名单可注册，收下调用直接忽略即可。
try:
    import torch.serialization as _ts
    if not hasattr(_ts, "add_safe_globals"):
        _ts.add_safe_globals = lambda *a, **kw: None
    if not hasattr(_ts, "safe_globals"):
        import contextlib as _ctx

        @_ctx.contextmanager
        def _safe_globals(*a, **kw):
            yield

        _ts.safe_globals = _safe_globals
except Exception:
    pass
'''


def has_future_annotations(src):
    """判断文件是否真的有 future 注解声明。

    不能用字符串匹配：ComfyUI 的 comfy_api/internal/async_to_sync.py 是个
    代码生成器，它要生成的代码模板里就带着这行字面量，字符串匹配会误判成
    "已经加过"，于是整个文件被跳过。
    """
    import ast as _ast
    try:
        tree = _ast.parse(src)
    except Exception:
        return False
    for node in tree.body:
        if isinstance(node, _ast.ImportFrom) and node.module == "__future__":
            if any(a.name == "annotations" for a in node.names):
                return True
    return False


def add_future_import(path):
    """在文件头部插入 from __future__ import annotations。

    要插在 docstring 和注释之后、第一条真实语句之前，否则是 SyntaxError。
    """
    with open(path, "rb") as f:
        raw = f.read()
    src = raw.decode("utf-8")
    if has_future_annotations(src):
        return False

    # 用 tokenize 找到第一条真实语句的行号，绕开 docstring / 注释 / 编码声明
    insert_line = 0
    try:
        toks = list(tokenize.tokenize(io.BytesIO(raw).readline))
        seen_doc = False
        for t in toks:
            if t.type in (tokenize.ENCODING, tokenize.NL, tokenize.NEWLINE,
                          tokenize.COMMENT, tokenize.INDENT, tokenize.DEDENT):
                continue
            if t.type == tokenize.STRING and not seen_doc:
                seen_doc = True          # 模块 docstring，跳过它
                insert_line = t.end[0]
                continue
            insert_line = t.start[0] - 1
            break
    except Exception:
        insert_line = 0

    lines = src.split("\n")
    lines.insert(insert_line, "from __future__ import annotations")
    new = "\n".join(lines)

    # 改完必须仍能按 3.8 解析
    import ast
    try:
        ast.parse(new, filename=path, feature_version=(3, 8))
    except SyntaxError:
        return False

    if not os.path.exists(path + ".orig"):
        with open(path + ".orig", "w", encoding="utf-8") as f:
            f.write(src)
    with open(path, "w", encoding="utf-8") as f:
        f.write(new)
    return True


def rewrite_dict_merge(path):
    """把 py3.9 的字典合并 `a | b` 改写成 `{**a, **b}`。

    这是运行时表达式，不是注解——`__future__` 完全帮不上忙，py38 直接
    `TypeError: unsupported operand type(s) for |: 'dict' and 'dict'`。

    ComfyUI 的节点 schema 定义里大量用这个模式
    （`comfy_api/latest/_io.py` 的 `super().as_dict() | prune_dict({...})`），
    不改就没法提交任何用新版 schema 的节点（症状是提交工作流报
    "Exception when validating inner node"）。

    只改能确定是字典合并的：一侧是字典字面量/字典推导，或者调用名里带 dict。
    位运算（两个整数、flag 常量）绝不能碰。
    """
    import ast as _ast
    try:
        src = open(path, encoding="utf-8").read()
        tree = _ast.parse(src)
    except Exception:
        return 0

    def dictish(n):
        if isinstance(n, (_ast.Dict, _ast.DictComp)):
            return True
        # prune_dict(...) / as_dict() / xxx_dict(...) 这类调用
        if isinstance(n, _ast.Call):
            f = n.func
            name = getattr(f, "id", None) or getattr(f, "attr", None) or ""
            return "dict" in name.lower()
        return False

    edits = []

    class V(_ast.NodeVisitor):
        def __init__(self):
            self._ann = 0

        def visit_FunctionDef(self, node):
            for a in node.args.args + node.args.kwonlyargs:
                if a.annotation:
                    self._ann += 1; self.visit(a.annotation); self._ann -= 1
            if node.returns:
                self._ann += 1; self.visit(node.returns); self._ann -= 1
            for s in node.body:
                self.visit(s)
        visit_AsyncFunctionDef = visit_FunctionDef

        def visit_AnnAssign(self, node):
            if node.annotation:
                self._ann += 1; self.visit(node.annotation); self._ann -= 1
            if node.value:
                self.visit(node.value)

        def visit_BinOp(self, node):
            if (isinstance(node.op, _ast.BitOr) and not self._ann
                    and (dictish(node.left) or dictish(node.right))
                    and hasattr(node, "end_lineno")):
                edits.append(node)
            self.generic_visit(node)

    V().visit(tree)
    if not edits:
        return 0

    lines = src.split("\n")
    count = 0
    # 从后往前改，避免偏移错位
    for node in sorted(edits, key=lambda n: (n.lineno, n.col_offset), reverse=True):
        l0, c0, l1, c1 = node.lineno, node.col_offset, node.end_lineno, node.end_col_offset
        seg = ("\n".join(lines[l0 - 1:l1]))
        # 段内相对偏移
        start = c0
        end = len(seg) - (len(lines[l1 - 1]) - c1)
        expr = seg[start:end]
        # 只处理顶层恰好一个 | 的情形，嵌套的留给下一轮（改完会再扫一遍）
        parts = _split_top_level(expr, "|")
        if len(parts) != 2:
            continue
        new_expr = "{**(%s), **(%s)}" % (parts[0].strip(), parts[1].strip())
        new_seg = seg[:start] + new_expr + seg[end:]
        lines[l0 - 1:l1] = new_seg.split("\n")
        count += 1

    if not count:
        return 0
    new_src = "\n".join(lines)
    try:
        _ast.parse(new_src, filename=path, feature_version=(3, 8))
    except SyntaxError:
        return 0
    if not os.path.exists(path + ".orig"):
        open(path + ".orig", "w", encoding="utf-8").write(src)
    open(path, "w", encoding="utf-8").write(new_src)
    return count


def rewrite_type_aliases(path):
    """改写模块级的类型别名赋值，例如：

        UserMetadata = dict[str, Any] | None

    这是真实的表达式求值，不是注解，`__future__` 帮不上忙，py38 直接 TypeError。
    只处理顶层语句，且只在右侧确实长得像类型表达式时才动。
    """
    import ast as _ast
    try:
        src = open(path, encoding="utf-8").read()
        tree = _ast.parse(src)
    except Exception:
        return 0

    def looks_like_type(node):
        if isinstance(node, _ast.BinOp) and isinstance(node.op, _ast.BitOr):
            return looks_like_type(node.left) and looks_like_type(node.right)
        if isinstance(node, _ast.Subscript):
            base = node.value
            if isinstance(base, _ast.Name) and base.id in _TYPING_NAME:
                return True
            return isinstance(base, (_ast.Name, _ast.Attribute))
        if isinstance(node, (_ast.Name, _ast.Attribute)):
            return True
        if isinstance(node, _ast.Constant) and node.value is None:
            return True
        return False

    def has_new_syntax(node):
        for n in _ast.walk(node):
            if isinstance(n, _ast.BinOp) and isinstance(n.op, _ast.BitOr):
                return True
            if isinstance(n, _ast.Subscript) and isinstance(n.value, _ast.Name) \
                    and n.value.id in _TYPING_NAME:
                return True
        return False

    # 模块级和类体内的赋值都要看：ComfyUI 的 comfy_api/latest/_io.py 就在
    # 类体里写 `Type = list[str]`，那同样是运行时求值。
    stmts = list(tree.body)
    for node in _ast.walk(tree):
        if isinstance(node, _ast.ClassDef):
            stmts.extend(node.body)

    edits, used = [], set()
    for stmt in stmts:
        if isinstance(stmt, _ast.Assign) and len(stmt.targets) == 1 \
                and isinstance(stmt.targets[0], _ast.Name):
            val = stmt.value
        elif isinstance(stmt, _ast.AnnAssign) and stmt.value is not None:
            val = stmt.value
        else:
            continue
        if not looks_like_type(val) or not has_new_syntax(val):
            continue
        if not hasattr(val, "end_lineno"):
            continue
        edits.append((val.lineno, val.col_offset, val.end_lineno, val.end_col_offset))

    if not edits:
        return 0

    lines = src.split("\n")
    count = 0
    # 从后往前改，避免前面的编辑影响后面的偏移
    for ln, col, eln, ecol in sorted(edits, reverse=True):
        if ln != eln:
            continue                     # 跨行的别名少见，保守跳过
        line = lines[ln - 1]
        old = line[col:ecol]
        new = to_typing_form(old, used)
        if new == old:
            continue
        lines[ln - 1] = line[:col] + new + line[ecol:]
        count += 1

    if not count:
        return 0
    new_src = "\n".join(lines)

    new_src = ensure_import_typing(new_src) if used else new_src

    try:
        _ast.parse(new_src, filename=path, feature_version=(3, 8))
    except SyntaxError:
        return 0

    if not os.path.exists(path + ".orig"):
        open(path + ".orig", "w", encoding="utf-8").write(src)
    open(path, "w", encoding="utf-8").write(new_src)
    return count


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    sp = sys.argv[1]
    check_only = "--check" in sys.argv

    if not os.path.isdir(sp):
        print("site-packages 不存在: %s" % sp)
        return 1

    # --- 1. sitecustomize：各种 torch / 标准库缺口的 shim ---
    sc = os.path.join(sp, "sitecustomize.py")
    if check_only:
        print("sitecustomize.py : %s" % ("已存在" if os.path.exists(sc) else "缺失"))
    else:
        # 先自检再落盘：SITECUSTOMIZE 是当字符串拼出来的，里面若混进
        # \n \t 这类转义序列，会在生成阶段被解释掉、把代码写坏。
        # sitecustomize 一旦有语法错误，整个解释器的所有 shim 都会静默失效。
        import ast as _ast
        try:
            _ast.parse(SITECUSTOMIZE, filename=sc)
        except SyntaxError as e:
            print("✗ 兼容层自身有语法错误（行 %s: %s），未写入" % (e.lineno, e.msg))
            print("  出错行: %r" % ((e.text or "").rstrip()[:100]))
            return 1
        with open(sc, "w", encoding="utf-8") as f:
            f.write(SITECUSTOMIZE)
        print("✓ 写入 %s（torch / 标准库兼容层）" % sc)

    # --- 2. 给用了内置泛型注解的包加 __future__ ---
    for pkg in FUTURE_TARGETS:
        root = os.path.join(sp, pkg)
        if not os.path.isdir(root):
            print("  跳过（未安装）: %s" % pkg)
            continue
        need, done = [], 0
        for dp, dn, fns in os.walk(root):
            dn[:] = [d for d in dn if d != "__pycache__"]
            for fn in fns:
                if not fn.endswith(".py"):
                    continue
                p = os.path.join(dp, fn)
                try:
                    src = open(p, encoding="utf-8").read()
                except Exception:
                    continue
                if has_future_annotations(src):
                    continue
                # 无条件加：这些包普遍用 py39+ 的注解写法（内置泛型 tuple[int]、
                # PEP604 联合 X | None），逐个特征去判断会漏。future 只改变注解
                # 求值时机，对真实的位运算与运行时逻辑没有影响。
                need.append(os.path.relpath(p, root))
                if not check_only and add_future_import(p):
                    done += 1
        if check_only:
            print("%-14s 需要处理 %d 个文件" % (pkg, len(need)))
        else:
            print("✓ %-12s 处理 %d/%d 个文件" % (pkg, done, len(need)))

    # --- 3. ComfyUI 本体 ---
    if "--comfyui" in sys.argv:
        i = sys.argv.index("--comfyui")
        if i + 1 >= len(sys.argv):
            print("--comfyui 后面要跟路径")
            return 1
        croot = sys.argv[i + 1]
        if not os.path.isdir(croot):
            print("ComfyUI 目录不存在: %s" % croot)
            return 1
        # web/ 是前端资源，custom_nodes 归用户自己管，tests 不参与运行
        skip = {".git", "tests", "tests-unit", "custom_nodes", "web", "venv",
                "__pycache__", "models", "output", "input", "temp"}
        need, done, failed = [], 0, []
        for dp, dn, fns in os.walk(croot):
            dn[:] = [d for d in dn if d not in skip and not d.startswith(".")]
            for fn in fns:
                if not fn.endswith(".py"):
                    continue
                p = os.path.join(dp, fn)
                try:
                    src = open(p, encoding="utf-8").read()
                except Exception:
                    continue
                if has_future_annotations(src):
                    continue
                if not BUILTIN_GENERIC.search(src) and " | " not in src:
                    continue
                rel = os.path.relpath(p, croot)
                need.append(rel)
                if not check_only:
                    if add_future_import(p):
                        done += 1
                    else:
                        failed.append(rel)
        if check_only:
            print("ComfyUI       需要处理 %d 个文件" % len(need))
        else:
            print("✓ ComfyUI     处理 %d/%d 个文件" % (done, len(need)))
            if failed:
                print("  未能处理 %d 个（已跳过，保持原样）:" % len(failed))
                for f in failed[:8]:
                    print("    " + f)

        # 下面两类是 __future__ 救不了的：它们在运行时真的会被求值。
        if not check_only:
            n_ann, n_alias, n_merge = 0, 0, 0
            for dp, dn, fns in os.walk(croot):
                dn[:] = [d for d in dn if d not in skip and not d.startswith(".")]
                for fn in fns:
                    if not fn.endswith(".py"):
                        continue
                    p = os.path.join(dp, fn)
                    try:
                        src = open(p, encoding="utf-8").read()
                    except Exception:
                        continue
                    # SQLAlchemy 的 Mapped[...] 由 ORM 自己 eval
                    if "Mapped[" in src:
                        c = rewrite_runtime_annotations(p, "Mapped")
                        if c:
                            print("  ↳ %s：Mapped 注解 %d 处" %
                                  (os.path.relpath(p, croot), c))
                            n_ann += c
                    # 模块级类型别名赋值，本来就是求值语句
                    c2 = rewrite_type_aliases(p)
                    if c2:
                        print("  ↳ %s：类型别名 %d 处" %
                              (os.path.relpath(p, croot), c2))
                        n_alias += c2
                    # py3.9 的字典合并 a | b，同样是运行时表达式
                    # 反复扫到不再变化为止：一行里可能嵌套多个
                    while True:
                        c3 = rewrite_dict_merge(p)
                        if not c3:
                            break
                        print("  ↳ %s：字典合并 %d 处" %
                              (os.path.relpath(p, croot), c3))
                        n_merge += c3
            if n_ann or n_alias or n_merge:
                print("✓ 运行时求值处改写：Mapped 注解 %d 处，类型别名 %d 处，字典合并 %d 处"
                      % (n_ann, n_alias, n_merge))

    # ── 单个自定义节点包 ───────────────────────────────────────────
    # custom_nodes 不在上面那轮里（那轮跳过它，因为节点包由用户自己增删）。
    # 装新节点包时对它单独跑一次：社区包普遍按 py3.10 写，语法扫描往往全过，
    # 却在导入时死在运行时求值的 py3.9 特性上——实测两个典型症状：
    #   rgthree     unsupported operand type(s) for |: 'dict' and 'dict'   ← 字典合并
    #   Comfyroll   'type' object is not subscriptable                     ← list[str] 注解
    # 两者都是本文件已有的改写器能解决的，只是之前没让它扫到这里。
    if "--custom-node" in sys.argv:
        i = sys.argv.index("--custom-node")
        if i + 1 >= len(sys.argv):
            print("--custom-node 后面要跟节点包路径")
            return 2
        nroot = sys.argv[i + 1]
        if not os.path.isdir(nroot):
            print("节点包目录不存在: %s" % nroot)
            return 1
        nskip = {".git", "__pycache__", "web", "js", "node_modules", "tests", ".github"}
        n_fut = n_ann = n_alias = n_merge = 0
        files = []
        for dp, dn, fns in os.walk(nroot):
            dn[:] = [d for d in dn if d not in nskip and not d.startswith(".")]
            for fn in fns:
                if fn.endswith(".py"):
                    files.append(os.path.join(dp, fn))
        for p in files:
            try:
                src = open(p, encoding="utf-8").read()
            except Exception:
                continue
            # 注解层：加 __future__ 就够（注解不再在定义时求值）
            if not has_future_annotations(src) and (BUILTIN_GENERIC.search(src) or " | " in src):
                if add_future_import(p):
                    n_fut += 1
            # 下面三类 __future__ 救不了，必须真改写
            if "Mapped[" in src:
                n_ann += rewrite_runtime_annotations(p, "Mapped") or 0
            n_alias += rewrite_type_aliases(p) or 0
            while True:
                c = rewrite_dict_merge(p)
                if not c:
                    break
                n_merge += c
        print("✓ 节点包 %s：扫 %d 个文件，加 __future__ %d 个，"
              "类型别名 %d 处，字典合并 %d 处，Mapped 注解 %d 处"
              % (os.path.basename(nroot.rstrip("/")), len(files), n_fut,
                 n_alias, n_merge, n_ann))

    return 0


if __name__ == "__main__":
    sys.exit(main())
