# 启动本地服务：先跑迁移，再起 HTTP 服务
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

node server/src/db/migrate.ts
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

node server/src/index.ts
