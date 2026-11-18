#requires -Version 7.5
<#
.SYNOPSIS
Read-only, local Codex rollout collector. No API calls, no auth/config reads.
.DESCRIPTION
Reads ordinary rollout-*.jsonl files only. Keeps a whitelist of metadata,
usage and action boundaries; excludes prompts, arguments, outputs and cwd.
Writes its own bounded capture and an offline HTML report. -Watch is foreground
polling, not a service or scheduled task. The report is a snapshot; refresh it.
PowerShell 7.5 is required for ConvertFrom-Json -DateKind String.
#>
[CmdletBinding()]
param(
    [string]$CodexHome = $(if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }),
    [string]$OutputRoot = (Join-Path (Get-Location) 'Codex-Observation'),
    [ValidateRange(0,3650)][int]$SinceDays = 7,
    [ValidateRange(1,200)][int]$MaxFiles = 50,
    [ValidateRange(100,100000)][int]$MaxEvents = 50000,
    [ValidateRange(1,64)][int]$MaxFileMiB = 32,
    [ValidateRange(1,60)][int]$IntervalSeconds = 5,
    [switch]$Watch,
    [ValidateRange(0,100000)][int]$MaxPolls = 0
)
$ErrorActionPreference = 'Stop'
$Utf8 = [System.Text.UTF8Encoding]::new($false, $true)
$Cache = @{}
$Notices = [System.Collections.Generic.List[string]]::new()
$Base = [System.IO.Path]::GetFullPath($CodexHome)
$TemplatePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'dist/Assistant_Desk.html'
if (-not [System.IO.Directory]::Exists($Base)) { throw 'CODEX_HOME does not exist. Specify -CodexHome with the intended profile. No settings were changed.' }
if (-not [System.IO.File]::Exists($TemplatePath)) { throw 'Missing dist/Assistant_Desk.html. Extract the complete package first.' }
$Template = [System.IO.File]::ReadAllText($TemplatePath, $Utf8)
$RunFolder = Join-Path ([System.IO.Path]::GetFullPath($OutputRoot)) ('capture-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,6))
# Never write into a Codex profile, including a user-selected output path.
$Separator = [System.IO.Path]::DirectorySeparatorChar
if (($RunFolder + $Separator).StartsWith(($Base.TrimEnd($Separator) + $Separator), [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Output must be outside CODEX_HOME.' }
[System.IO.Directory]::CreateDirectory($RunFolder) | Out-Null
$Lock = [System.IO.File]::Open((Join-Path $RunFolder '.collector.lock'), [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
function Hash-Text([string]$Value) {
    [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($Value))).ToLowerInvariant()
}
function Short-String($Value) {
    if ($Value -isnot [string]) { return $null }
    return $Value.Substring(0, [Math]::Min(300, $Value.Length))
}
function Safe-Number($Value) {
    if ($null -eq $Value -or $Value -is [bool]) { return $null }
    if ($Value -isnot [ValueType] -and $Value -isnot [string]) { return $null }
    [double]$n = 0
    if ([double]::TryParse([string]$Value, [System.Globalization.NumberStyles]::Float, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$n) -and [double]::IsFinite($n) -and $n -ge 0 -and $n -le 9007199254740991) { return $n }
    return $null
}
function Usage-Fields($U) {
    if ($U -isnot [System.Collections.IDictionary]) { return $null }
    return [ordered]@{input=(Safe-Number $U['input_tokens']);cached=(Safe-Number $U['cached_input_tokens']);output=(Safe-Number $U['output_tokens']);reasoning=(Safe-Number $U['reasoning_output_tokens']);total=(Safe-Number $U['total_tokens'])}
}
function Convert-Event($Record, [string]$Source, [int]$Index, [string]$EventId) {
    if ($Record -isnot [System.Collections.IDictionary]) { return $null }
    $p = $Record['payload']; if ($p -isnot [System.Collections.IDictionary]) { $p = @{} }
    $e = [ordered]@{schema='codex-observer-event/1';source=$Source;seq=$Index;eventId=$EventId;timestamp=(Short-String $Record['timestamp']);kind='other';sessionId=$null;turnId=(Short-String $p['turn_id']);callId=(Short-String $p['call_id'])}
    switch ($Record['type']) {
        'session_meta' { $e.kind='session';$e.sessionId=Short-String $p['id'];$e['forkedFrom']=Short-String $p['forked_from_id'];$e['version']=Short-String $p['cli_version'];if($p['cwd'] -is [string]){$e['project']=Hash-Text $p['cwd']} }
        'turn_context' { $e.kind='context';$e['model']=Short-String $p['model'] }
        'token_usage_record' { $e.kind='usage-record';$e.sessionId=Short-String $p['thread_id'];$e['responseId']=Short-String $p['response_id'];$e['usage']=Usage-Fields $p['usage'] }
        'event_msg' {
            switch ($p['type']) {
                {$_ -in 'task_started','turn_started'} { $e.kind='turn-start' }
                {$_ -in 'task_complete','turn_complete'} { $e.kind='turn-end';$e['status']=if($p['error']){'failed'}else{'completed'};$e['reportedDurationMs']=Safe-Number $p['duration_ms'];$e['reportedTtftMs']=Safe-Number $p['time_to_first_token_ms'];$e['startedAt']=Safe-Number $p['started_at'];$e['completedAt']=Safe-Number $p['completed_at'] }
                'turn_aborted' { $e.kind='turn-end';$e['status']='interrupted' }
                'token_count' {
                    $e.kind='usage-total';$i=$p['info'];if($i -is [System.Collections.IDictionary]){$e['usage']=Usage-Fields $i['total_token_usage'];$e['last']=Usage-Fields $i['last_token_usage'];$e['contextWindow']=Safe-Number $i['model_context_window']}
                    $r=$p['rate_limits'];if($r -is [System.Collections.IDictionary]){$pr=$r['primary'];$sr=$r['secondary'];$e['rateLimits']=[ordered]@{primary=$(if($pr -is [System.Collections.IDictionary]){Safe-Number $pr['used_percent']}else{$null});secondary=$(if($sr -is [System.Collections.IDictionary]){Safe-Number $sr['used_percent']}else{$null})}}
                }
                'token_usage_record' { $e.kind='usage-record';$e['responseId']=Short-String $p['response_id'];$e['usage']=Usage-Fields $p['usage'] }
                {$_ -in 'exec_command_begin','mcp_tool_call_begin','patch_apply_begin'} {
                    $e.kind='tool-start';$e['tool']=switch($p['type']){'exec_command_begin'{'command'} 'patch_apply_begin'{'apply_patch'} default{'mcp'}}
                }
                {$_ -in 'exec_command_end','mcp_tool_call_end','patch_apply_end'} {
                    $e.kind='tool-end';$e['durationMs']=Safe-Number $p['duration_ms'];$d=$p['duration'];if($null -eq $e.durationMs -and $d -is [System.Collections.IDictionary] -and $null -ne (Safe-Number $d['secs'])){$e.durationMs=1000.0*(Safe-Number $d['secs'])+((Safe-Number $d['nanos']) ?? 0)/1000000.0}
                }
                'agent_message' { $e.kind='agent-message' }
                'agent_message_delta' { $e.kind='output-delta' }
                {$_ -in 'stream_error','error'} { $e.kind='error' }
                'context_compacted' { $e.kind='compaction' }
                'thread_settings_applied' { $e.kind='context';$e.sessionId=Short-String $p['thread_id'];$ts=$p['thread_settings'];if($ts -is [System.Collections.IDictionary]){$e['model']=Short-String $ts['model']} }
                default { $e['eventType']=Short-String $p['type'] }
            }
        }
        'response_item' {
            switch ($p['type']) {
                {$_ -in 'function_call','custom_tool_call'} { $e.kind='tool-start';$e['tool']=Short-String $p['name'] }
                {$_ -in 'function_call_output','custom_tool_call_output'} { $e.kind='tool-end' }
                'message' { if($p['role'] -eq 'assistant'){$e.kind='agent-message'} }
            }
        }
        default { $e['eventType']=Short-String $Record['type'] }
    }
    return $e
}
function Find-Rollouts([string]$Root) {
    $stack = [System.Collections.Generic.Stack[string]]::new()
    foreach($name in @('sessions','archived_sessions')) {
        $dir=Join-Path $Root $name
        if([System.IO.Directory]::Exists($dir)) {
            if(([System.IO.File]::GetAttributes($dir) -band [System.IO.FileAttributes]::ReparsePoint) -eq 0){$stack.Push($dir)}
            else{$Notices.Add('A session directory is a reparse point and was skipped.')}
        }
    }
    while($stack.Count -gt 0) {
        $dir=$stack.Pop()
        try {
            foreach($child in [System.IO.Directory]::EnumerateDirectories($dir)) {
                if(([System.IO.File]::GetAttributes($child) -band [System.IO.FileAttributes]::ReparsePoint) -eq 0){$stack.Push($child)}
            }
            foreach($file in [System.IO.Directory]::EnumerateFiles($dir,'rollout-*.jsonl')) {
                if(([System.IO.File]::GetAttributes($file) -band [System.IO.FileAttributes]::ReparsePoint) -eq 0){[System.IO.FileInfo]::new($file)}
            }
            if(@([System.IO.Directory]::EnumerateFiles($dir,'*.jsonl.zst')).Count -gt 0){$Notices.Add('Compressed JSONL.ZST archives are not read. Coverage is partial.')}
        } catch { $Notices.Add('A session directory could not be enumerated; coverage is partial.') }
    }
}
function Read-SafeEvents([System.IO.FileInfo]$File, [int]$Limit) {
    $list=[System.Collections.Generic.List[object]]::new()
    $source=Hash-Text $File.FullName
    if($File.Length -gt $MaxFileMiB*1MB){$Notices.Add("Source $($source.Substring(0,12)): exceeds file size limit, skipped.");return ,$list.ToArray()}
    $stream=$null;$reader=$null
    try {
        $stream=[System.IO.File]::Open($File.FullName,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
        $reader=[System.IO.StreamReader]::new($stream,$Utf8,$true,65536,$false)
        $index=0
        while(-not $reader.EndOfStream -and $list.Count -lt $Limit) {
            $line=$reader.ReadLine();$index++
            if([string]::IsNullOrWhiteSpace($line)){continue}
            if($line.Length -gt 2MB){$Notices.Add("Source $($source.Substring(0,12)): oversized line skipped.");continue}
            try {
                $r=ConvertFrom-Json -InputObject $line -AsHashtable -Depth 100 -DateKind String
                $ev=Convert-Event $r $source $index (Hash-Text $line)
                if($null -ne $ev){$list.Add($ev)}
            } catch { $Notices.Add("Source $($source.Substring(0,12)), line ${index}: invalid or unfinished JSON. No content retained.") }
            if($stream.Position -gt $MaxFileMiB*1MB){$Notices.Add('File grew past read limit; remainder omitted.');break}
        }
        if(-not $reader.EndOfStream){$Notices.Add('Event count limit reached. Remaining events omitted; capture is partial.')}
    } catch { $Notices.Add("Source $($source.Substring(0,12)): read failed; coverage is partial.") }
    finally {if($null -ne $reader){$reader.Dispose()}elseif($null -ne $stream){$stream.Dispose()}}
    return ,$list.ToArray()
}
function Write-Atomic([string]$Path,[string]$Text) {
    $tmp=$Path+'.tmp-'+[guid]::NewGuid().ToString('N')
    try {
        $bytes=$Utf8.GetBytes($Text)
        $file=[System.IO.File]::Open($tmp,[System.IO.FileMode]::CreateNew,[System.IO.FileAccess]::Write,[System.IO.FileShare]::None)
        try{$file.Write($bytes,0,$bytes.Length);$file.Flush($true)}finally{$file.Dispose()}
        [System.IO.File]::Move($tmp,$Path,$true)
    } finally {if([System.IO.File]::Exists($tmp)){[System.IO.File]::Delete($tmp)}}
}
Write-Host "Read-only capture: $RunFolder"
Write-Host 'No Codex process, browser, or provider call is started. Ctrl+C stops watching.'
$poll=0
try {
    do {
        $poll++;$Notices.Clear()
        $all=@(Find-Rollouts $Base | Where-Object { $SinceDays -eq 0 -or $_.LastWriteTimeUtc -ge [DateTime]::UtcNow.AddDays(-$SinceDays) } | Sort-Object LastWriteTimeUtc -Descending)
        $selected=@($all | Select-Object -First $MaxFiles)
        if($all.Count -gt $MaxFiles){$Notices.Add('File count limit reached; only newest modified files included.')}
        $events=[System.Collections.Generic.List[object]]::new()
        $activeKeys=[System.Collections.Generic.HashSet[string]]::new()
        foreach($f in $selected) {
            if($events.Count -ge $MaxEvents){$Notices.Add('Global event limit reached; later files omitted.');break}
            $key=Hash-Text $f.FullName;$activeKeys.Add($key)|Out-Null
            $stamp="$($f.Length):$($f.LastWriteTimeUtc.Ticks)"
            $remaining=$MaxEvents-$events.Count
            if(-not $Cache.ContainsKey($key) -or $Cache[$key].stamp -ne $stamp -or $Cache[$key].limit -lt $remaining) {
                $before=$Notices.Count;$parsed=Read-SafeEvents $f $remaining
                $fileNotices=@($Notices | Select-Object -Skip $before)
                $Cache[$key]=@{stamp=$stamp;events=$parsed;notices=$fileNotices;limit=$remaining}
            } else {foreach($n in $Cache[$key].notices){$Notices.Add($n)}}
            foreach($ev in $Cache[$key].events){if($events.Count -ge $MaxEvents){break};$events.Add($ev)}
        }
        foreach($key in @($Cache.Keys)){if(-not $activeKeys.Contains($key)){$Cache.Remove($key)}}
        if($events.Count -eq 0){$Notices.Add('No supported events found. No events is not proof of no Codex activity.')}
        $Notices.Add('Files selected by modification time; captured events can predate SinceDays. Source files and provider state may have changed after capture.')
        $capture=[ordered]@{format='codex-observer/1';capturedAt=[DateTime]::UtcNow.ToString('o');collector='PowerShell read-only / 0.1';profileHash=(Hash-Text $Base);contentPolicy='metadata-only';scannedFiles=$all.Count;includedFiles=$selected.Count;notices=@($Notices|Select-Object -Unique);events=$events.ToArray()}
        $json=ConvertTo-Json -InputObject $capture -Depth 30 -Compress
        if($Utf8.GetByteCount($json) -gt 64MB){throw 'Capture exceeds 64 MiB. Lower MaxEvents; prior output was not replaced.'}
        Write-Atomic (Join-Path $RunFolder 'capture.json') $json
        $base64=[Convert]::ToBase64String($Utf8.GetBytes($json))
        $html=$Template.Replace('window.__CAPTURE_B64__ = "__CAPTURE__";',('window.__CAPTURE_B64__ = "'+$base64+'";'))
        Write-Atomic (Join-Path $RunFolder 'Report.html') $html
        Write-Host "$([DateTime]::Now.ToString('HH:mm:ss'))  $($events.Count) events / $($selected.Count) files. Refresh Report.html to read the new snapshot."
        if(-not $Watch -or ($MaxPolls -gt 0 -and $poll -ge $MaxPolls)){break}
        Start-Sleep -Seconds $IntervalSeconds
    } while($true)
} finally { $Lock.Dispose(); [System.IO.File]::Delete((Join-Path $RunFolder '.collector.lock')) }
