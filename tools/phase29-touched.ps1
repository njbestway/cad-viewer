# Lists the files touched on 2026-10-29 (phase 2.9 working day) so the closeout
# can separate phase 2.9 edits from the carried-over 2.6-2.8 work in the tree.
$cut = Get-Date '2026-10-29 00:00'
$roots = @(
  'packages\three-renderer\src',
  'packages\three-renderer\__tests__',
  'packages\cad-simple-viewer\src',
  'packages\cad-simple-viewer\__tests__',
  'packages\cad-editor-demo\e2e',
  'tools'
)
$files = foreach ($root in $roots) {
  if (Test-Path $root) {
    Get-ChildItem -Recurse -File -Path $root -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -ge $cut }
  }
}
$files += Get-ChildItem -File -Filter '*.md' | Where-Object { $_.LastWriteTime -ge $cut }
$files += Get-ChildItem -File -Filter '*.ps1' | Where-Object { $_.LastWriteTime -ge $cut }
$files |
  Sort-Object LastWriteTime |
  ForEach-Object { $_.LastWriteTime.ToString('HH:mm') + '  ' + $_.FullName.Replace('E:\rustpro\cad-viewer\', '') }