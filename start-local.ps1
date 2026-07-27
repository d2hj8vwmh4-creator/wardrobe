# 本地运行 + 公网穿透 一键脚本（Windows PowerShell）
# 用法：在 wardrobe 目录下，右键此文件 ->「使用 PowerShell 运行」
# 作用：启动生产服务器（前端+AI接口一体），再用 cloudflared 暴露成公网 https 地址

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# 1) 找到 node（优先 PATH，回退到 WorkBuddy 管理的 node）
$node = (Get-Command node -ErrorAction SilentlyContinue)?.Source
if (-not $node) {
  $node = "C:\Users\29849\.workbuddy\binaries\node\versions\22.22.2\node.exe"
}
Write-Host "使用 node: $node"

# 2) 后台启动 prod-server
Write-Host "启动 prod-server (http://localhost:4173) ..."
Start-Process -FilePath $node -ArgumentList "prod-server.mjs" -WindowStyle Hidden

# 等几秒让服务起来
Start-Sleep -Seconds 3
try {
  $r = Invoke-WebRequest -Uri "http://localhost:4173/api/import/config" -UseBasicParsing -TimeoutSec 5
  Write-Host "prod-server 已就绪 (HTTP $($r.StatusCode))"
} catch {
  Write-Host "警告：prod-server 似乎没起来，请确认已执行过 npm install，且 node 路径正确"
}

# 3) 启动 cloudflared 穿透（临时公网地址，每次重启会变化）
Write-Host ""
Write-Host "正在启动 cloudflared 穿透，稍候下方会显示一个 https://xxxx.trycloudflare.com 地址"
Write-Host "把这个地址发给安卓同事即可（Chrome 打开 -> 菜单『加到主屏幕』）"
Write-Host "（关闭此窗口即停止穿透；要彻底停止服务，在任务管理器结束 node prod-server.mjs 进程）"
Write-Host ""
& cloudflared tunnel --url http://localhost:4173
