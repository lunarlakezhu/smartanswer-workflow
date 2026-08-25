# crossref-fetch.ps1 —— CrossRef 取数（两种模式，应急通道）
# 主通道见 reference/crossref-fetch.js（Node，主 agent 预取；子代理禁网）。
# 本 ps1 仅在本地代理 17897 在场、且 Node 通道不可用时的应急路径。
# 子代理执行方式：把本段原样放在 pwsh 命令最前，换行后加：
#   $dois = @('10.1038/nature14539', '10.xxxx/yyyy')
#   foreach ($d in $dois) { Get-CrossrefWork -Doi $d | ConvertTo-Json -Compress; Start-Sleep -Milliseconds 300 }
# 模式一 · 按 DOI 精确查询：Get-CrossrefWork -Doi <doi>
# 模式二 · 按标题查询（v2 pending 补验）：Get-CrossrefByTitle -QueryTitle <title>
# 每行紧凑 JSON：{doi, status, title, journal, year, abstract, citedBy, note[, queryTitle]}
# status: found=有记录 | not-found=查无此篇 | error=网络/解析失败
#
# 连接方式（试运行已实测）：
#   方式一：裸 socket 向本地代理 127.0.0.1:17897 发「GET 绝对URI」明文请求（DSH 子代理沙箱直连 TLS 会报
#           「安全包中没有可用的凭证」，走代理 CONNECT 也失败，只有这种方式通）
#   方式二：直连 Invoke-RestMethod 兜底（主 agent 环境直连可用）
# 禁止修改本片段、禁止自行调试网络；失败就标 error，不重试超过一次。

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$script:CrossrefUa = 'SmartAnswer/1.0 (mailto:research-bot@example.org)'

# 通用 GET：返回 @{ ok; statusCode; body; note }
function Invoke-CrossrefRaw([string]$Url) {
  $ok = $false; $body = ''; $note = ''; $statusCode = 0
  # ---- 方式一：裸 socket 经本地代理 ----
  try {
    $c = New-Object System.Net.Sockets.TcpClient('127.0.0.1', 17897)
    $ns = $c.GetStream(); $ns.ReadTimeout = 30000; $ns.WriteTimeout = 15000
    $req = "GET $Url HTTP/1.1`r`nHost: api.crossref.org`r`nUser-Agent: $script:CrossrefUa`r`nAccept: application/json`r`nAccept-Encoding: identity`r`nConnection: close`r`n`r`n"
    $b = [System.Text.Encoding]::ASCII.GetBytes($req)
    $ns.Write($b, 0, $b.Length)
    $raw = New-Object System.IO.MemoryStream
    $buf = New-Object byte[] 65536
    while ($true) { try { $n = $ns.Read($buf, 0, $buf.Length) } catch { break }; if ($n -le 0) { break }; $raw.Write($buf, 0, $n) }
    $c.Close()
    $bytes = $raw.ToArray()
    $sep = -1
    for ($i = 0; $i -lt $bytes.Length - 3; $i++) { if ($bytes[$i] -eq 13 -and $bytes[$i+1] -eq 10 -and $bytes[$i+2] -eq 13 -and $bytes[$i+3] -eq 10) { $sep = $i; break } }
    if ($sep -ge 0) {
      $hdr = [System.Text.Encoding]::ASCII.GetString($bytes, 0, $sep)
      $start = $sep + 4
      if ($hdr -match '^HTTP/1\.[01]\s+(\d+)') { $statusCode = [int]$Matches[1] }
      if ($statusCode -notmatch '^2\d\d$') { $note = "http $statusCode" }
      else {
        if ($hdr -match '(?i)transfer-encoding:\s*chunked') {
          $out = New-Object System.IO.MemoryStream
          $pos = $start
          while ($true) {
            $le = -1
            for ($j = $pos; $j -lt $bytes.Length - 1; $j++) { if ($bytes[$j] -eq 13 -and $bytes[$j+1] -eq 10) { $le = $j; break } }
            if ($le -lt 0) { break }
            $sizeLine = [System.Text.Encoding]::ASCII.GetString($bytes, $pos, $le - $pos).Trim()
            if ($sizeLine -notmatch '^([0-9a-fA-F]+)') { break }
            $size = [Convert]::ToInt32($Matches[1], 16)
            if ($size -le 0) { break }
            $pos = $le + 2
            if ($pos + $size -gt $bytes.Length) { break }
            $out.Write($bytes, $pos, $size)
            $pos += $size + 2
          }
          $body = [System.Text.Encoding]::UTF8.GetString($out.ToArray())
        } else {
          $body = [System.Text.Encoding]::UTF8.GetString($bytes, $start, $bytes.Length - $start)
        }
        $ok = $true
      }
    }
  } catch { }
  # ---- 方式二：直连兜底 ----
  if (-not $ok) {
    try {
      $r = Invoke-RestMethod -Uri $Url -TimeoutSec 30 -Headers @{ 'User-Agent' = $script:CrossrefUa }
      $body = $r | ConvertTo-Json -Depth 20 -Compress
      $ok = $true
    } catch {
      if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
      return @{ ok = $false; statusCode = $statusCode; body = ''; note = $_.Exception.Message }
    }
  }
  return @{ ok = $ok; statusCode = $statusCode; body = $body; note = $note }
}

# 从 CrossRef work JSON 的 message 提取公共字段
function ConvertFrom-CrossrefMessage([hashtable]$Raw, [string]$Doi, [string]$QueryTitle) {
  if (-not $Raw.ok) {
    if ($Raw.statusCode -eq 404) { return [PSCustomObject]@{ doi = $Doi; status = 'not-found'; note = '' } }
    return [PSCustomObject]@{ doi = $Doi; status = 'error'; note = $Raw.note }
  }
  try {
    $m = ($Raw.body | ConvertFrom-Json).message
    if ($null -eq $m) { return [PSCustomObject]@{ doi = $Doi; status = 'error'; note = 'no message' } }
    $abs = ''
    if ($m.abstract) {
      $abs = ($m.abstract -replace '<[^>]+>', ' ' -replace '\s+', ' ').Trim()
      if ($abs.Length -gt 800) { $abs = $abs.Substring(0, 800) }
    }
    $out = [PSCustomObject]@{
      doi = if ($m.DOI) { [string]$m.DOI } else { $Doi }
      status = 'found'
      title = if ($m.title) { $m.title[0] } else { '' }
      journal = if ($m.'container-title') { $m.'container-title'[0] } else { '' }
      year = if ($m.issued.'date-parts') { [string]$m.issued.'date-parts'[0][0] } else { '' }
      abstract = $abs
      citedBy = if ($null -ne $m.'is-referenced-by-count') { [int]$m.'is-referenced-by-count' } else { 0 }
      note = ''
    }
    if ($QueryTitle) { $out | Add-Member -NotePropertyName queryTitle -NotePropertyValue $QueryTitle }
    return $out
  } catch {
    return [PSCustomObject]@{ doi = $Doi; status = 'error'; note = 'parse fail' }
  }
}

# 模式一：按 DOI 精确查询（验身+排名）
function Get-CrossrefWork([string]$Doi) {
  $url = 'https://api.crossref.org/works/' + ($Doi -replace '\s+', '')
  $raw = Invoke-CrossrefRaw $url
  return ConvertFrom-CrossrefMessage $raw $Doi ''
}

# 模式二：按标题查询（v2 pending 补验；query.title 精确标题，取 top1）
# 注意：不要用 select= 参数——score 不是 selectable 字段，加了会被丢弃导致无法做相关度判断
function Get-CrossrefByTitle([string]$QueryTitle) {
  $t = ($QueryTitle -replace '\s+', ' ').Trim()
  $enc = [System.Uri]::EscapeDataString($t)
  $url = "https://api.crossref.org/works?query.title=$enc&rows=1"
  $raw = Invoke-CrossrefRaw $url
  if (-not $raw.ok) { return ConvertFrom-CrossrefMessage $raw '' $t }
  try {
    $msg = ($raw.body | ConvertFrom-Json).message
    $items = @($msg.items)
    if ($items.Count -eq 0) { return [PSCustomObject]@{ doi = ''; status = 'not-found'; note = '标题查询无结果' } }
    $top = $items[0]
    $score = $null; if ($null -ne $top.score) { $score = [double]$top.score }
    # 阈值 60（实测命中 64-100；低于 60 多为噪声），低于则视为查无此篇；score 缺失时放行（取 top1）
    if ($null -ne $score -and $score -lt 60) {
      return [PSCustomObject]@{ doi = ''; status = 'not-found'; note = "score=$([math]::Round($score,1)) 低于阈值" }
    }
    $work = [PSCustomObject]@{
      doi = [string]$top.DOI
      status = 'found'
      title = if ($top.title) { $top.title[0] } else { '' }
      journal = if ($top.'container-title') { $top.'container-title'[0] } else { '' }
      year = if ($top.issued.'date-parts') { [string]$top.issued.'date-parts'[0][0] } else { '' }
      abstract = if ($top.abstract) { (($top.abstract -replace '<[^>]+>', ' ' -replace '\s+', ' ').Trim()) } else { '' }
      citedBy = if ($null -ne $top.'is-referenced-by-count') { [int]$top.'is-referenced-by-count' } else { 0 }
      note = if ($null -ne $score) { "score=$([math]::Round($score,1))" } else { '' }
    }
    $work | Add-Member -NotePropertyName queryTitle -NotePropertyValue $t
    return $work
  } catch {
    return [PSCustomObject]@{ doi = ''; status = 'error'; note = 'parse fail' }
  }
}
