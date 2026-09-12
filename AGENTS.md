# IECU 3.1 公开发布包
## 先做什么

1. 阅读 [`README.md`](README.md) 。
2. 新板从 `.agents/skills/iecu-provision/WORKFLOW.md` 开始。
3. 已部署板的维护读 `.agents/skills/iecu/SKILL.md`。
4. 导入 ComfyUI 工作流读 `.agents/skills/comfyui-import/SKILL.md`。

## 安全边界

- 发布包不包含外网域名、frp token、私钥、证书、面板认证文件或作者环境地址。
- SSH 工具默认使用 `root` / `iecupassword`；这是公开临时部署口令，部署完成后必须更换。首次出厂板仍可能是厂商 `root` / `nvidia`，见部署工作流。
- 面板没有默认密码。外网入口默认关闭，需自行配置 `deploy/edge/.env`。
- 不把板子的 SSH 端口暴露到公网。

## 项目约束

- 这是 DRIVE OS Guest VM，不是 Jetson。
- 不执行 `/app/shutdown_service.sh kill`，不向 `/dev/vblkdev*` 写入，不修改厂商主路由、救命直连地址或厂商启动脚本。
- 所有改动先落到 `deploy/`，再推送到板上；板子是副本。

## ComfyUI 档位

- `deploy/comfyui/comfy-profile.sh image`：单模型生图，模型全常驻，速度最快。
- `deploy/comfyui/comfy-profile.sh video`：MiniMax-H3 长视频，DynamicVRAM。

两档共享同一个服务。video 档依赖 `deploy/torch-py313/sitecustomize.py`；删掉它必须切回 image 档。
