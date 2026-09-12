# 从上一块板（批次A __BOARD_LAN_IP__）把 llama.cpp 整套搬到新板（这块板 __BOARD_LAN_IP__），
# 顺路归档进 baseline/llama/ —— 这是 baseline 目前唯一还缺的东西，
# 补上之后装第三块板就不需要重新交叉编译了。
#
# 前提：上一块板已上电且在 __BOARD_LAN_IP__ 可达（它的地址由自己的 iecu-lan-ip.service 配在 eth.254）。
# 上一块板全程只读，不改它任何东西。
$OutputEncoding = [Console]::OutputEncoding = [Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'

$proj  = "__WORKSPACE__\Desktop\开发项目\IECU3.1"
$dir   = "$proj\.claude\skills\iecu\scripts"
$arc   = "$proj\baseline\llama"
$node  = "__OPERATOR_HOME__\scoop\apps\nodejs\current\node.exe"
$OLD   = "__BOARD_LAN_IP__"
$NEW   = "__BOARD_LAN_IP__"

Write-Output "############ 1. 上一块板是否在线 ############"
$ping = Test-Connection -TargetName $OLD -Count 2 -Quiet -ErrorAction SilentlyContinue
if (-not $ping) { Write-Output "  ★ $OLD ping 不通 —— 上一块板还没上电？"; exit 1 }
Write-Output "  ping 通"
& $node "$dir\portscan.js" $OLD 22,9000 2000
Write-Output ""

Write-Output "############ 2. 看上一块板上 llama 目录的构成（只读）############"
$env:IECU_HOST = $OLD; $env:IECU_PORT = "22"; $env:IECU_USER = "root"; $env:IECU_PASS = "nvidia"
& $node "$dir\exec.js" --file "$dir\inspect-old-llama.sh" 120
Write-Output ""

Write-Output "############ 3. 拉到本机归档 baseline\llama ############"
New-Item -ItemType Directory -Path $arc -Force | Out-Null
& $node "$dir\pull.js" "/var/lib/llm/llama" $arc
Write-Output ""
Write-Output "--- 归档结果 ---"
$f = Get-ChildItem $arc -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum
"  {0} 个文件 / {1:N2} GB" -f $f.Count, ($f.Sum / 1GB)
Get-ChildItem $arc -Recurse -File -ErrorAction SilentlyContinue |
  Sort-Object Length -Descending | Select-Object -First 12 @{N='相对路径';E={$_.FullName.Replace($arc,'')}}, @{N='MB';E={[math]::Round($_.Length/1MB,1)}} |
  Format-Table -AutoSize

Write-Output "############ 4. 推到新板 ############"
$env:IECU_HOST = $NEW
& $node "$dir\exec.js" "mkdir -p /var/lib/llm/llama && echo ok" 60
$files = Get-ChildItem $arc -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne '_manifest.json' }
foreach ($x in $files) {
  $rel = $x.FullName.Replace($arc, '').TrimStart('\').Replace('\', '/')
  & $node "$dir\push.js" $x.FullName "/var/lib/llm/llama/$rel"
}
Write-Output ""

Write-Output "############ 5. 新板上验证二进制 ############"
& $node "$dir\exec.js" --file "$dir\verify-llama-binaries.sh" 240
