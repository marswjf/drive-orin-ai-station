# QSS 系网管交换机只读查询：登录 → MAC表/端口/镜像。管理口常只开 80/443 无 SSH。
# 前端是 SPA，API 在 /api/v3。登录 POST /api/v3/users/login body{username,password:base64}
# 返回 result.AccessToken(JWT)，后续带 Authorization: Bearer <token>。
# 用法: qnap-qss.ps1 -SwitchIP __SWITCH_IP__ -User admin -Pass __REMOVED_CURRENT_PASSWORD__ -Action fdb|ports|mirror|vlan [-MacFilter 02:80:5E]
# ⚠ 端口镜像要在 Web 界面手动开(源=板子口 目标=空闲口)，抓完关(Mode:false)。本脚本只读不改配置。
param([Parameter(Mandatory=$true)][string]$SwitchIP,[string]$User="admin",
  [Parameter(Mandatory=$true)][string]$Pass,
  [ValidateSet("fdb","ports","mirror","vlan")][string]$Action="fdb",[string]$MacFilter="")
[Net.ServicePointManager]::ServerCertificateValidationCallback = {$true}
$B="http://$SwitchIP/api/v3"
$pw64=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Pass))
$body=@{username=$User;password=$pw64;rememberme=$false}|ConvertTo-Json -Compress
try { $login=Invoke-RestMethod -Uri "$B/users/login" -Method POST -ContentType "application/json" -Body $body -TimeoutSec 15 }
catch { Write-Output "登录失败(401=密码错,别猜别爆破,问用户核对): $($_.Exception.Message)"; if($_.ErrorDetails.Message){Write-Output $_.ErrorDetails.Message}; exit 1 }
$tok=$login.result.AccessToken
if(-not $tok){Write-Output "无 token: $($login|ConvertTo-Json -Compress)";exit 1}
$H=@{Authorization="Bearer $tok"}; Write-Output "登录成功。"
switch ($Action) {
  "fdb" { $r=Invoke-RestMethod -Uri "$B/mac/fdb/status" -Headers $H -TimeoutSec 20
    Write-Output "=== MAC 表 [VLAN,MAC]->端口 (共 $($r.result.Count)) ==="
    $r.result|ForEach-Object{ $v=$_.key[0];$m=$_.key[1];$p=$_.val.Port
      if(-not $MacFilter -or $m -match [regex]::Escape($MacFilter)){"{0,-18} VLAN {1,-5} 端口 {2}" -f $m,$v,$p}} }
  "ports" { $r=Invoke-RestMethod -Uri "$B/ports/status" -Headers $H -TimeoutSec 20
    $r.result|ForEach-Object{"端口 {0,-3} Link={1,-6} Speed={2}" -f $_.key,$_.val.Link,$_.val.Speed}|Sort-Object }
  "mirror" { (Invoke-RestMethod -Uri "$B/mirror" -Headers $H -TimeoutSec 20)|ConvertTo-Json -Depth 6 }
  "vlan" { $r=Invoke-RestMethod -Uri "$B/vlan" -Headers $H -TimeoutSec 20
    $r.result|ForEach-Object{"VLAN {0}: {1}" -f $_.key,(($_.val|ForEach-Object{"$($_.Port)$(if($_.Tagged){'(T)'})"}) -join ' ')} }
}
