# 隔离连接一块"IP 撞了网关/家网"的板子，并在隔离窗口内执行一段命令/脚本。
#
# 场景：板子的静态 IP 和路由器或家网某设备撞了（例：板子和路由器都是 __ROUTER_IP__），
#   直接连它会被网关截走。做法是给本机网卡配同段地址、写死 ARP 指向板子 MAC、
#   加一条 /32 主机路由，把发往板子 IP 的包强制送到本网卡。
#
# 安全铁律（全部内建）：
#   - 不配网关、不改默认路由、抬高本网卡跃点数（9000）——不抢默认路由，不断本机的网
#   - try/finally：无论中途出什么错，最后都还原网卡地址/路由/邻居/跃点数
#   - 先 TCP 探端口通了再发 SSH（ARP 表项生效有延迟，太早连会 EHOSTUNREACH）
#
# 用法：
#   powershell -File isolated-connect.ps1 -BoardIP __ROUTER_IP__ -BoardMAC 02-80-5E-XX-XX-XX `
#       -IfIndex 23 -HostIP __ROUTER_IP__00 `
#       -User root -Pass root -RemoteScript C:\path\to\onboard.sh
#   不传 -RemoteScript 则只做端口探测 + 登录自检。
#   还原用的原地址/跃点数：脚本会自动记录当前值并在 finally 恢复。
param(
  [Parameter(Mandatory=$true)][string]$BoardIP,
  [Parameter(Mandatory=$true)][string]$BoardMAC,      # 形如 02-80-5E-XX-XX-XX
  [Parameter(Mandatory=$true)][int]$IfIndex,          # 直连网卡的 ifIndex（Get-NetAdapter）
  [string]$HostIP = "__ROUTER_IP__00",
  [int]$HostPrefix = 24,
  [string]$User = "root",
  [string]$Pass = "root",
  [int[]]$Ports = @(22,23,80,443,8080,9000,111),
  [string]$RemoteScript = "",
  [string]$SanityHost = "__SWITCH_IP__",                # finally 里自检连通性的目标（路由器/交换机）
  [int]$SanityPort = 80
)
$ErrorActionPreference = 'Continue'
$node    = "__OPERATOR_HOME__\scoop\apps\nodejs\current\node.exe"
$scripts = "__WORKSPACE__\Desktop\开发项目\IECU3.1\.claude\skills\iecu\scripts"

# 记录网卡当前地址与跃点数，finally 还原
$curIp   = Get-NetIPAddress -InterfaceIndex $IfIndex -AddressFamily IPv4 -EA SilentlyContinue | Select -First 1
$curMet  = (Get-NetIPInterface -InterfaceIndex $IfIndex -AddressFamily IPv4 -EA SilentlyContinue).InterfaceMetric

function Log($m){ "$(Get-Date -Format 'HH:mm:ss')  $m" | Write-Output }

try {
    Log "抬高跃点数（不抢默认路由）"
    Set-NetIPInterface -InterfaceIndex $IfIndex -AddressFamily IPv4 -InterfaceMetric 9000 -EA SilentlyContinue
    if ($curIp) { Remove-NetIPAddress -InterfaceIndex $IfIndex -IPAddress $curIp.IPAddress -Confirm:$false -EA SilentlyContinue }
    New-NetIPAddress -InterfaceIndex $IfIndex -IPAddress $HostIP -PrefixLength $HostPrefix -EA SilentlyContinue | Out-Null
    Log "写死 ARP $BoardIP -> $BoardMAC"
    Remove-NetNeighbor -InterfaceIndex $IfIndex -IPAddress $BoardIP -Confirm:$false -EA SilentlyContinue
    New-NetNeighbor -InterfaceIndex $IfIndex -IPAddress $BoardIP -LinkLayerAddress $BoardMAC -State Permanent -EA SilentlyContinue | Out-Null
    New-NetRoute -DestinationPrefix "$BoardIP/32" -InterfaceIndex $IfIndex -NextHop 0.0.0.0 -RouteMetric 1 -Confirm:$false -EA SilentlyContinue | Out-Null

    Log "端口探测（顺便等 ARP 生效）"
    $open = @()
    foreach ($p in $Ports) {
        $reach = $false
        for ($w=0; $w -lt 6; $w++) {
            $c = New-Object Net.Sockets.TcpClient
            try { $iar=$c.BeginConnect($BoardIP,$p,$null,$null); if($iar.AsyncWaitHandle.WaitOne(800)){$c.EndConnect($iar);$reach=$true} } catch {}
            $c.Close(); if ($reach) { break }; Start-Sleep -Milliseconds 400
        }
        if ($reach) { $open += $p; Log "   开放 $p" }
    }
    Log "开放端口: $($open -join ', ')"

    if ($open -contains 22) {
        $env:IECU_HOST=$BoardIP; $env:IECU_PORT="22"; $env:IECU_USER=$User; $env:IECU_PASS=$Pass
        if ($RemoteScript -and (Test-Path $RemoteScript)) {
            Log "执行远程脚本:"
            & $node "$scripts\exec.js" --file $RemoteScript 40 2>&1 | Write-Output
        } else {
            Log "登录自检:"
            & $node "$scripts\exec.js" "echo OK=`$(id -un)@`$(hostname); uname -a" 15 2>&1 | Write-Output
        }
    }
}
catch { Log "!! 异常: $($_.Exception.Message)" }
finally {
    Log "还原本机网络"
    Remove-NetRoute -DestinationPrefix "$BoardIP/32" -InterfaceIndex $IfIndex -Confirm:$false -EA SilentlyContinue
    Remove-NetNeighbor -InterfaceIndex $IfIndex -IPAddress $BoardIP -Confirm:$false -EA SilentlyContinue
    Remove-NetIPAddress -InterfaceIndex $IfIndex -IPAddress $HostIP -Confirm:$false -EA SilentlyContinue
    if ($curIp) { New-NetIPAddress -InterfaceIndex $IfIndex -IPAddress $curIp.IPAddress -PrefixLength $curIp.PrefixLength -EA SilentlyContinue | Out-Null }
    if ($curMet) { Set-NetIPInterface -InterfaceIndex $IfIndex -AddressFamily IPv4 -InterfaceMetric $curMet -EA SilentlyContinue }
    Start-Sleep -Seconds 2
    $t = Test-NetConnection -ComputerName $SanityHost -Port $SanityPort -WarningAction SilentlyContinue
    Log "还原完成，连通性($SanityHost:$SanityPort)=$($t.TcpTestSucceeded)"
}
