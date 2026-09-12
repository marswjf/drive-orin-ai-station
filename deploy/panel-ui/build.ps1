# 构建面板前端。
#
# 为什么要把源码复制出去再构建：项目目录是同步盘，node_modules 有两三百 MB，
# 不能放进去。所以源码留在项目里（跟着同步，换台机器也能改），
# 依赖和中间产物落在 D:\tmp\iecu-panel-build（不同步），产物再拷回 deploy/panel/dist。
#
# 用法：  pwsh -File deploy\panel-ui\build.ps1  [-Push]
#   -Push  构建完直接推到板子（需要先开好 SSH 隧道，见 HANDOVER）

param([switch]$Push)

$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8

$Src   = $PSScriptRoot
$Proj  = Split-Path (Split-Path $Src -Parent) -Parent
$Work  = 'D:\tmp\iecu-panel-build'
$Dist  = Join-Path $Proj 'deploy\panel\dist'
$Node  = '__OPERATOR_HOME__\scoop\apps\nodejs\current'
$env:Path = "$Node;$env:Path"

Write-Host "源码: $Src"
Write-Host "构建: $Work"

New-Item -ItemType Directory -Force -Path $Work | Out-Null

# 只同步源文件，不碰 node_modules
foreach ($f in 'package.json', 'vite.config.js', 'index.html') {
    Copy-Item (Join-Path $Src $f) $Work -Force
}
$srcDir = Join-Path $Work 'src'
if (Test-Path $srcDir) { Remove-Item $srcDir -Recurse -Force }
Copy-Item (Join-Path $Src 'src') $srcDir -Recurse -Force

Push-Location $Work
try {
    if (-not (Test-Path (Join-Path $Work 'node_modules'))) {
        Write-Host "`n首次构建，安装依赖…"
        npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
    }
    Write-Host "`n开始构建…"
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "vite build 失败" }
} finally { Pop-Location }

# 产物回收到项目里，跟着同步走，也方便直接推板子
if (Test-Path $Dist) { Remove-Item $Dist -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Dist | Out-Null
Copy-Item (Join-Path $Work 'dist\*') $Dist -Recurse -Force

Write-Host "`n产物已输出到 $Dist"
Get-ChildItem $Dist -Recurse -File | ForEach-Object {
    "  {0,-46} {1,8:N1} KB" -f $_.FullName.Substring($Dist.Length + 1), ($_.Length / 1KB)
}

if ($Push) {
    Write-Host "`n推送到板子…"
    $env:IECU_HOST = if ($env:IECU_HOST) { $env:IECU_HOST } else { '127.0.0.1' }
    $env:IECU_PORT = if ($env:IECU_PORT) { $env:IECU_PORT } else { '<PANEL_JUMP_PORT>' }
    # 注意变量名不能叫 $push——PowerShell 变量不分大小写，会撞上 -Push 开关参数
    $pushJs = Join-Path $Proj '.claude\skills\iecu\scripts\push.js'
    & "$Node\node.exe" $pushJs (Join-Path $Dist 'index.html') /var/lib/llm/panel/index.html
    Get-ChildItem (Join-Path $Dist 'assets') -File | ForEach-Object {
        & "$Node\node.exe" $pushJs $_.FullName ('/var/lib/llm/panel/assets/' + $_.Name)
    }
    Write-Host "推送完成。"
}
