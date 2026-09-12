# Windows 自带 pktmon 抓包(无需装 Wireshark/npcap)，转文本读源 IP。
# 用途：接交换机端口镜像口，抓"只发不收/IP撞网关"的板子报文。pktmon 在 NDIS 层，
# 可作独立于网卡计数器的第二个仪表交叉验证"到底有没有帧"。⚠ 需管理员。
# 用法: pktmon-capture.ps1 -AdapterName "以太网" -Seconds 30 [-MacFilter 02-80-5E-XX-XX-XX]
param([Parameter(Mandatory=$true)][string]$AdapterName,[int]$Seconds=30,
  [string]$MacFilter="",[string]$OutDir="$env:TEMP\pktcap")
$OutputEncoding=New-Object Text.UTF8Encoding $false
New-Item -ItemType Directory -Force -Path $OutDir|Out-Null
$etl=Join-Path $OutDir "cap.etl"; $txt=Join-Path $OutDir "cap.txt"
Remove-Item "$OutDir\cap.*" -EA SilentlyContinue
$comp=((pktmon list|Select-String $AdapterName) -split '\s+'|Where-Object{$_ -match '^\d+$'}|Select -First 1)
if(-not $comp){Write-Output "找不到 $AdapterName 的组件 ID，先看 pktmon list";exit 1}
Write-Output "组件 ID = $comp"
pktmon stop 2>&1|Out-Null; pktmon filter remove 2>&1|Out-Null
if($MacFilter){pktmon filter add board -m $MacFilter 2>&1|Out-Null;Write-Output "MAC 过滤 $MacFilter"}
pktmon start --capture --comp $comp --pkt-size 512 --file-name $etl 2>&1|Out-Null
Write-Output "抓 $Seconds 秒(同时发广播做阳性对照)..."
Start-Sleep 2; ping -n 2 -w 500 255.255.255.255 2>&1|Out-Null; Start-Sleep $Seconds
Write-Output "--- 计数器(Rx=收到 Tx=自己发的对照) ---"
pktmon counters 2>&1|Select-String -Pattern "$AdapterName|Rx|Tx|$comp"
pktmon stop 2>&1|Out-Null; pktmon filter remove 2>&1|Out-Null
pktmon etl2txt $etl -o $txt -v 2>&1|Out-Null
if(-not(Test-Path $txt)){Write-Output "转文本失败";exit 1}
Write-Output "`n=== 源 IP -> 目标 流量汇总(前20) ==="
$lines=Get-Content $txt; $flows=@{}
foreach($l in $lines){ if($l -match '(\d+\.\d+\.\d+\.\d+)\.(\d+)\s*>\s*(\d+\.\d+\.\d+\.\d+)\.(\d+)'){
  $k="$($Matches[1]) -> $($Matches[3]):$($Matches[4])"; $flows[$k]=1+$flows[$k]}}
$flows.GetEnumerator()|Sort-Object Value -Descending|Select -First 20|ForEach-Object{"{0,5}  {1}" -f $_.Value,$_.Key}
Write-Output "`n全文: $txt"
