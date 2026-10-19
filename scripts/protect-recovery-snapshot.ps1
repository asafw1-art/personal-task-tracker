param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [switch]$RemoveGeneratedPlaintext
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$inputFull = (Resolve-Path -LiteralPath $InputPath).Path
$outputFull = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $outputFull) { throw 'Protected output already exists; refusing to overwrite.' }
if ($RemoveGeneratedPlaintext -and -not $inputFull.EndsWith('.raw.json')) {
  throw 'Cleanup is limited to the generated .raw.json file.'
}
$bytes = [IO.File]::ReadAllBytes($inputFull)
$data = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
if ($data.format -ne 'task-tracker-account-recovery' -or $data.version -ne 1) { throw 'Unsupported snapshot format.' }
$sha = [Security.Cryptography.SHA256]::Create()
try {
  $plainHash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
  $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $stream = [IO.File]::Open($outputFull, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($encrypted, 0, $encrypted.Length) } finally { $stream.Dispose() }
  $roundTrip = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($outputFull), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $roundTripHash = [BitConverter]::ToString($sha.ComputeHash($roundTrip)).Replace('-', '').ToLowerInvariant()
  if ($roundTripHash -ne $plainHash) { throw 'Encrypted round-trip verification failed; plaintext retained.' }
  $counts = [ordered]@{}
  foreach ($property in $data.data.PSObject.Properties) { $counts[$property.Name] = @($property.Value).Count }
  $manifest = [ordered]@{
    format = 'task-tracker-protected-local-copy'
    version = 1
    protection = 'Windows DPAPI CurrentUser'
    capturedAt = $data.captured_at
    plaintextSha256 = $plainHash
    protectedSha256 = [BitConverter]::ToString($sha.ComputeHash($encrypted)).Replace('-', '').ToLowerInvariant()
    counts = $counts
    limitation = 'Requires this Windows user protection context. Not a portable off-device disaster recovery copy.'
  }
  $manifestPath = "$outputFull.manifest.json"
  $manifestBytes = [Text.UTF8Encoding]::new($false).GetBytes(($manifest | ConvertTo-Json -Depth 5))
  $stream = [IO.File]::Open($manifestPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($manifestBytes, 0, $manifestBytes.Length) } finally { $stream.Dispose() }
  if ($RemoveGeneratedPlaintext) { Remove-Item -LiteralPath $inputFull }
  Write-Output "Protected local copy verified; plaintext SHA-256: $plainHash"
  Write-Output "Manifest: $manifestPath"
} finally {
  [Array]::Clear($bytes, 0, $bytes.Length)
  if ($roundTrip) { [Array]::Clear($roundTrip, 0, $roundTrip.Length) }
  $sha.Dispose()
}
