Set-Location E:\rustpro\realdwg-web
$log = 'E:\rustpro\cad-viewer\reports\phase210\d-full-data-model-suite.log'
npx jest packages/data-model 2>&1 | Out-File -FilePath $log -Encoding utf8
Write-Output "EXIT=$LASTEXITCODE"
Get-Content $log -Tail 12
