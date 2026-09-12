# 摘除/还原网卡 VLAN tag（残留 tag 会在硬件层过滤帧，表现为"链路 Up 但 Rx 恒 0"）。
# 需管理员权限。用法:
#   nic-vlan.ps1 -AdapterName "以太网 2" -Action clear   # 关闭 VLAN 处理，帧原样上送
#   nic-vlan.ps1 -AdapterName "以太网 2" -Action show    # 只看当前值
#   nic-vlan.ps1 -AdapterName "以太网 2" -Action restore -VlanId 254 -PriorityMode 3  # 还原
param([Parameter(Mandatory=$true)][string]$AdapterName,
  [ValidateSet("show","clear","restore")][string]$Action="show",
  [int]$VlanId=0,[int]$PriorityMode=3)
function Show { Get-NetAdapterAdvancedProperty -Name $AdapterName -RegistryKeyword 'RegVlanID','*PriorityVLANTag' |
    Select DisplayName,RegistryValue,DisplayValue | Format-Table -AutoSize }
Write-Output "=== 改动前 ==="; Show
switch ($Action) {
  "clear"   { Set-NetAdapterAdvancedProperty -Name $AdapterName -RegistryKeyword 'RegVlanID' -RegistryValue 0
              Set-NetAdapterAdvancedProperty -Name $AdapterName -RegistryKeyword '*PriorityVLANTag' -RegistryValue 0
              Write-Output "已关闭 VLAN 处理（tag=0, priority=0），帧原样上送" }
  "restore" { Set-NetAdapterAdvancedProperty -Name $AdapterName -RegistryKeyword 'RegVlanID' -RegistryValue $VlanId
              Set-NetAdapterAdvancedProperty -Name $AdapterName -RegistryKeyword '*PriorityVLANTag' -RegistryValue $PriorityMode
              Write-Output "已还原 VLAN=$VlanId, PriorityMode=$PriorityMode" }
}
if ($Action -ne "show") {
  for ($i=0;$i -lt 20;$i++){ Start-Sleep 1; $n=Get-NetAdapter -Name $AdapterName -EA SilentlyContinue; if($n -and $n.Status -eq 'Up'){break} }
  Write-Output "=== 改动后 ==="; Show
  Write-Output "网卡状态: $((Get-NetAdapter -Name $AdapterName).Status)"
}
