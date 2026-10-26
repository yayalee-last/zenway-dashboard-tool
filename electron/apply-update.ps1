$ErrorActionPreference = 'Stop'
$installTarget = $null
$stagingPath = $null
$backupPath = $null
$parentExited = $false
$swapped = $false

function Write-UpdateLog([string]$message) {
  try { [IO.File]::AppendAllText($env:ZT_LOG, ((Get-Date).ToString('o') + ' ' + $message + [Environment]::NewLine)) } catch {}
}

function Remove-UpdatePath([string]$candidate) {
  $absolute = [IO.Path]::GetFullPath($candidate)
  $parentPrefix = [IO.Path]::GetDirectoryName($installTarget).TrimEnd('\') + '\'
  if (-not $absolute.StartsWith($parentPrefix, [StringComparison]::OrdinalIgnoreCase) -or $absolute -notin @($installTarget, $stagingPath, $backupPath)) {
    throw 'Refusing to remove a path outside the update target.'
  }
  if (Test-Path -LiteralPath $absolute) { Remove-Item -LiteralPath $absolute -Recurse -Force }
}

try {
  $installTarget = [IO.Path]::GetFullPath($env:ZT_TARGET).TrimEnd('\')
  $source = [IO.Path]::GetFullPath($env:ZT_SRC).TrimEnd('\')
  $launch = [IO.Path]::GetFullPath($env:ZT_LAUNCH)
  $parentFolder = [IO.Path]::GetDirectoryName($installTarget)
  if (-not $parentFolder -or $installTarget -eq [IO.Path]::GetPathRoot($installTarget).TrimEnd('\')) { throw 'Cannot replace a filesystem root.' }
  if ($source -eq $installTarget -or $source.StartsWith($installTarget + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Update source must be outside the installed folder.' }
  if (-not (Test-Path -LiteralPath $source -PathType Container) -or -not (Test-Path -LiteralPath $installTarget -PathType Container)) { throw 'Update source or installed folder is missing.' }
  $suffix = [Guid]::NewGuid().ToString('N')
  $folderName = [IO.Path]::GetFileName($installTarget)
  $stagingPath = Join-Path $parentFolder ($folderName + '.update-stage-' + $suffix)
  $backupPath = Join-Path $parentFolder ($folderName + '.update-backup-' + $suffix)

  [IO.File]::WriteAllText($env:ZT_READY, 'ready')
  $parentProcess = Get-Process -Id ([int]$env:ZT_PARENT_PID) -ErrorAction SilentlyContinue
  if ($parentProcess -and -not $parentProcess.WaitForExit(30000)) { throw 'Timed out waiting for the updating process to exit.' }
  $parentExited = $true

  Copy-Item -LiteralPath $source -Destination $stagingPath -Recurse
  Move-Item -LiteralPath $installTarget -Destination $backupPath
  try {
    Move-Item -LiteralPath $stagingPath -Destination $installTarget
    $swapped = $true
  } catch {
    Move-Item -LiteralPath $backupPath -Destination $installTarget
    throw
  }

  Start-Process -FilePath $launch -WorkingDirectory ([IO.Path]::GetDirectoryName($launch)) -WindowStyle Hidden
  Write-UpdateLog 'Update applied successfully.'
  try { Remove-UpdatePath $backupPath } catch { Write-UpdateLog ('Backup cleanup: ' + $_.Exception.Message) }
  exit 0
} catch {
  Write-UpdateLog ('Update failed: ' + $_.Exception.Message)
  if ($swapped -and (Test-Path -LiteralPath $backupPath)) {
    try {
      Remove-UpdatePath $installTarget
      Move-Item -LiteralPath $backupPath -Destination $installTarget
      Write-UpdateLog 'Previous version restored.'
    } catch { Write-UpdateLog ('Rollback failed: ' + $_.Exception.Message) }
  }
  if ($parentExited -and (Test-Path -LiteralPath $env:ZT_LAUNCH -PathType Leaf)) {
    try { Start-Process -FilePath $env:ZT_LAUNCH -WorkingDirectory ([IO.Path]::GetDirectoryName($env:ZT_LAUNCH)) -WindowStyle Hidden } catch {}
  }
  exit 1
} finally {
  if ($stagingPath) { try { Remove-UpdatePath $stagingPath } catch {} }
}
