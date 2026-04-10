param(
    [string]$Model = "cline/openai/gpt-oss-120b:free",
    [string]$FallbackModel = "cline/nvidia/nemotron-3-nano-30b-a3b:free",
    [ValidateSet("smoke", "quick", "all", "flags", "edge", "parallel")]
    [string]$Mode = "smoke"
)

$ErrorActionPreference = "Continue"
$PSNativeCommandUseErrorActionPreference = $false

$repoRoot   = Split-Path -Parent $PSScriptRoot
$resultsDir = Join-Path $repoRoot "results"
$runId      = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir     = Join-Path $resultsDir $runId

New-Item -ItemType Directory -Force -Path $runDir | Out-Null

$prompt = @"
Run the GreedySearch test suite now by executing: bash test.sh $Mode
Wait for it to finish, then report:
- Total passed, failed, warnings, skipped counts (from the summary line)
- List every FAILED test by name
- List every WARNING by name
- Overall result: PASS or FAIL
Reply with a JSON object: { "passed": N, "failed": N, "warnings": N, "skipped": N, "failures": [...], "warningsList": [...], "result": "PASS"|"FAIL", "durationSec": N }
"@

function Invoke-PiRun {
    param([string]$Model, [string]$Suffix)

    $stdoutPath = Join-Path $runDir ("greedysearch-$Suffix-{0}.jsonl" -f ($Model -replace "[^a-zA-Z0-9._-]", "_"))
    $stderrPath = Join-Path $runDir ("greedysearch-$Suffix-{0}.stderr.log" -f ($Model -replace "[^a-zA-Z0-9._-]", "_"))

    Push-Location $repoRoot
    try {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        & pi -p --no-session --mode json --thinking off --model $Model $prompt 1> $stdoutPath 2> $stderrPath
        $exitCode = $LASTEXITCODE
        $sw.Stop()
    } finally {
        Pop-Location
    }

    return @{
        ExitCode    = $exitCode
        DurationSec = [math]::Round($sw.Elapsed.TotalSeconds, 2)
        StdoutPath  = $stdoutPath
        StderrPath  = $stderrPath
        Model       = $Model
    }
}

function Parse-JsonEvents {
    param([string]$Path)

    $assistantText = ""

    foreach ($line in Get-Content -Path $Path) {
        $obj = $null
        try { $obj = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }

        if ($obj.type -eq "message_end" -and $obj.message -and $obj.message.role -eq "assistant") {
            foreach ($content in $obj.message.content) {
                if ($content.type -eq "text" -and $content.text) {
                    $assistantText += [string]$content.text
                }
            }
        }
    }

    # Extract the JSON block Pi returns
    $jsonMatch = [regex]::Match($assistantText, '\{[\s\S]*\}')
    $parsed = $null
    if ($jsonMatch.Success) {
        try { $parsed = $jsonMatch.Value | ConvertFrom-Json -ErrorAction Stop } catch {}
    }

    return @{
        AssistantText = $assistantText
        Parsed        = $parsed
    }
}

# Run with primary model, fall back if non-zero exit
Write-Output "Running GreedySearch tests (mode: $Mode) via pi ..."
Write-Output "Model: $Model"

$result = Invoke-PiRun -Model $Model -Suffix "primary"

if ($result.ExitCode -ne 0) {
    Write-Output "Primary model failed (exit $($result.ExitCode)), retrying with fallback ..."
    $result = Invoke-PiRun -Model $FallbackModel -Suffix "fallback"
}

$parsed = Parse-JsonEvents -Path $result.StdoutPath
$summary = $parsed.Parsed

$stderr = ""
if (Test-Path $result.StderrPath) {
    $stderr = (Get-Content -Path $result.StderrPath -Raw)
}

# Build report
$mdLines = @()
$mdLines += "# GreedySearch Test Run"
$mdLines += ""
$mdLines += ("Run ID : {0}" -f $runId)
$mdLines += ("Mode   : {0}" -f $Mode)
$mdLines += ("Model  : {0}" -f $result.Model)
$mdLines += ("Pi exit: {0}" -f $result.ExitCode)
$mdLines += ("Pi time: {0}s" -f $result.DurationSec)
$mdLines += ""

if ($summary) {
    $mdLines += "## Results"
    $mdLines += ""
    $mdLines += ("| Passed | Failed | Warnings | Skipped | Overall |")
    $mdLines += ("|--------|--------|----------|---------|---------|")
    $mdLines += ("| {0} | {1} | {2} | {3} | **{4}** |" -f $summary.passed, $summary.failed, $summary.warnings, $summary.skipped, $summary.result)
    $mdLines += ""

    if ($summary.failures -and $summary.failures.Count -gt 0) {
        $mdLines += "### Failures"
        foreach ($f in $summary.failures) { $mdLines += ("- $f") }
        $mdLines += ""
    }

    if ($summary.warningsList -and $summary.warningsList.Count -gt 0) {
        $mdLines += "### Warnings"
        foreach ($w in $summary.warningsList) { $mdLines += ("- $w") }
        $mdLines += ""
    }
} else {
    $mdLines += "## Raw Pi Output"
    $mdLines += ""
    $mdLines += $parsed.AssistantText
}

$mdPath  = Join-Path $runDir "summary.md"
$csvPath = Join-Path $runDir "summary.csv"

Set-Content -Path $mdPath -Value ($mdLines -join [Environment]::NewLine)

# CSV row
[pscustomobject]@{
    RunId       = $runId
    Mode        = $Mode
    Model       = $result.Model
    ExitCode    = $result.ExitCode
    DurationSec = $result.DurationSec
    Passed      = if ($summary) { $summary.passed }   else { "?" }
    Failed      = if ($summary) { $summary.failed }   else { "?" }
    Warnings    = if ($summary) { $summary.warnings } else { "?" }
    Skipped     = if ($summary) { $summary.skipped }  else { "?" }
    Result      = if ($summary) { $summary.result }   else { "?" }
    Has429      = [bool]($stderr -match "429")
} | Export-Csv -NoTypeInformation -Path $csvPath

# Print summary to console
Write-Output ""
if ($summary) {
    Write-Output ("Result  : {0}" -f $summary.result)
    Write-Output ("Passed  : {0}" -f $summary.passed)
    Write-Output ("Failed  : {0}" -f $summary.failed)
    Write-Output ("Warnings: {0}" -f $summary.warnings)
    Write-Output ("Skipped : {0}" -f $summary.skipped)
    if ($summary.failures -and $summary.failures.Count -gt 0) {
        Write-Output ""
        Write-Output "Failures:"
        foreach ($f in $summary.failures) { Write-Output ("  - $f") }
    }
} else {
    Write-Output "Could not parse structured output from pi. Check raw output:"
    Write-Output $parsed.AssistantText
}

Write-Output ""
Write-Output ("Results dir: {0}" -f $runDir)
Write-Output ("Report     : {0}" -f $mdPath)
