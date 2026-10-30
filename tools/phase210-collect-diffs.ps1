$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$out = 'E:\rustpro\cad-viewer\reports\phase210'

$sourceDiff = git -C E:\rustpro\cad-viewer diff --no-index --src-prefix=a/ --dst-prefix=b/ `
  "E:\rustpro\_cv-baseline\packages\cad-simple-viewer\src\view\AcTrView2d.ts" `
  "E:\rustpro\cad-viewer\packages\cad-simple-viewer\src\view\AcTrView2d.ts"
$sourceDiff | Out-File -FilePath "$out\cadviewer-phase210-source.diff" -Encoding utf8

$realdwgDiff = git -C E:\rustpro\realdwg-web diff
$realdwgDiff | Out-File -FilePath "$out\realdwg-web-phase210.diff" -Encoding utf8

$cvDiff = git -C E:\rustpro\cad-viewer diff
$cvDiff | Out-File -FilePath "$out\cadviewer-worktree.diff" -Encoding utf8

Get-Item "$out\cadviewer-phase210-source.diff", "$out\realdwg-web-phase210.diff", "$out\cadviewer-worktree.diff" |
  Select-Object Name, Length
