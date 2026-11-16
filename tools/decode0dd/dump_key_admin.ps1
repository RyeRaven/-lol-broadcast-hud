# Elevated helper: dump the LoL game process command line (contains the
# per-game "riot:<hex>" spectator key) plus readable LCU lockfile copies.
# Output: C:/Temp/live-cmdline-elevated.txt and C:/Temp/lcu-lockfile-elevated.txt
$ErrorActionPreference = "Continue"
$keyOut = "C:/Temp/live-cmdline-elevated.txt"
$lockOut = "C:/Temp/lcu-lockfile-elevated.txt"
$lines = @()
try {
    $procs = Get-CimInstance Win32_Process -Filter "name='League of Legends.exe'"
    if ($procs) {
        foreach ($p in $procs) { $lines += ("CIM: " + $p.CommandLine) }
    } else {
        $lines += "CIM: no League of Legends.exe process found"
    }
} catch {
    $lines += ("CIM-ERROR: " + $_.Exception.Message)
}
try {
    $wmicOut = & cmd /c "wmic process where name='League of Legends.exe' get commandline /format:list" 2>$null
    if ($wmicOut) { $lines += ("WMIC: " + ($wmicOut | Out-String)) }
} catch {}
$lines | Out-File -Encoding utf8 $keyOut

# lockfile copies (elevated may read the exclusively-locked file)
$lockLines = @()
foreach ($root in @("D:/WeGameApps", "C:/Riot Games", "D:/Riot Games", "C:/Program Files/Riot Games")) {
    if (Test-Path $root) {
        Get-ChildItem -Path $root -Recurse -Filter "lockfile" -ErrorAction SilentlyContinue |
            ForEach-Object {
                try {
                    $content = [System.IO.File]::ReadAllText($_.FullName)
                    $lockLines += ($_.FullName + " => " + $content)
                } catch {
                    $lockLines += ($_.FullName + " => READ-FAILED: " + $_.Exception.Message)
                }
            }
    }
}
$lockLines | Out-File -Encoding utf8 $lockOut
Write-Host "dumped: $keyOut"
