# 差分找新设备：存"接入前"MAC 基线，接入后再采，多出来的就是它。源=路由器网桥FDB+DHCP租约(只读)。
# 网桥学习表 ageing = 多久前发过帧，小=正在活跃。用法:
#   diff-newmac.ps1 -Mode baseline   # 接入前存基线
#   diff-newmac.ps1 -Mode diff       # 接入后对比，打印新增 MAC
param([ValidateSet("baseline","diff")][string]$Mode="diff",[string]$Router="__ROUTER_IP__",
  [string]$Key="<你的SSH私钥路径>",[string]$Store="$env:TEMP\macbaseline.txt")
function Get-Macs {
  $out=ssh -i $Key -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new root@$Router "brctl showmacs br-lan 2>/dev/null; echo ---; cat /tmp/dhcp.leases 2>/dev/null" 2>&1
  $macs=@{}
  foreach($l in $out){ if($l -match '([0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5})'){
    $m=$Matches[1].ToLower(); if(-not $macs[$m]){$macs[$m]=($l.Trim() -replace '\s+',' ')}}}
  return $macs }
$now=Get-Macs
if($Mode -eq "baseline"){ $now.Keys|Sort-Object|Out-File $Store -Encoding ascii
  Write-Output "基线已存 $($now.Count) 个 MAC -> $Store" }
else { if(-not(Test-Path $Store)){Write-Output "没有基线，先跑 -Mode baseline";exit 1}
  $base=Get-Content $Store; Write-Output "=== 基线里没有的 MAC(新接入) ==="; $found=$false
  foreach($m in ($now.Keys|Sort-Object)){ if($base -notcontains $m){Write-Output "  ★ $m   $($now[$m])";$found=$true}}
  if(-not $found){Write-Output "  (暂无新增——板子可能没发帧或没上电)"} }
