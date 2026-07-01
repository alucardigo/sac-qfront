#requires -Version 7.0
# Poll UNICO: Microsoft Graph (sac@bellube.com.br) -> QFront/Chatwoot inbox.
# Roda via Agendador de Tarefas do Windows a cada 1 min. Incremental por lastReceived + dedupe(seen).
$ErrorActionPreference = 'Stop'
$root      = 'X:\SAC_QFront\integration\email-bridge'
$envFile   = Join-Path $root '.env'
$stateFile = Join-Path $root 'local-poll-state.json'
$logFile   = Join-Path $root 'local-poll.log'
function Log([string]$m){ ("{0}Z {1}" -f ([DateTime]::UtcNow.ToString('s')), $m) | Add-Content -Path $logFile -Encoding UTF8 }

# --- .env ---
$cfg = @{}
Get-Content $envFile | ForEach-Object { if ($_ -match '^\s*([^#=]+)=(.*)$') { $cfg[$matches[1].Trim()] = $matches[2].Trim() } }

# --- estado ---
if (Test-Path $stateFile) { $st = Get-Content $stateFile -Raw | ConvertFrom-Json } else { $st = [pscustomobject]@{ lastReceived = $null; seen = @{} } }
$seen = @{}; if ($st.seen) { $st.seen.PSObject.Properties | ForEach-Object { $seen[$_.Name] = $_.Value } }
$lastReceived = $st.lastReceived

try {
  # --- token Graph (client_credentials) ---
  $tokBody = @{ client_id=$cfg.MS_CLIENT_ID; client_secret=$cfg.MS_CLIENT_SECRET; scope='https://graph.microsoft.com/.default'; grant_type='client_credentials' }
  $tok = (Invoke-RestMethod -Method Post -Uri "https://login.microsoftonline.com/$($cfg.MS_TENANT_ID)/oauth2/v2.0/token" -Body $tokBody).access_token
  $gh  = @{ Authorization = "Bearer $tok" }
  $mbx = $cfg.MS_MAILBOX

  # --- buscar Inbox (sem $filter: Graph rejeita $filter+$orderby no mesmo campo) ---
  $url  = "https://graph.microsoft.com/v1.0/users/$mbx/mailFolders/Inbox/messages?`$top=25&`$orderby=receivedDateTime desc&`$select=id,subject,from,receivedDateTime,bodyPreview,body"
  $resp = Invoke-RestMethod -Method Get -Uri $url -Headers $gh
  $msgs = @($resp.value); [array]::Reverse($msgs)   # mais antigos primeiro

  # --- QFront ---
  $qh    = @{ 'access-token'=$cfg.QFRONT_ACCESS_TOKEN; 'client'=$cfg.QFRONT_CLIENT; 'uid'=$cfg.QFRONT_UID; 'token-type'='Bearer'; 'Content-Type'='application/json'; 'Accept'='application/json' }
  $qbase = $cfg.QFRONT_BASE
  $inbox = [int]$cfg.QFRONT_INBOX_ID
  $pulled = 0

  foreach ($m in $msgs) {
    if ($seen.ContainsKey($m.id)) { continue }
    if ($lastReceived -and ($m.receivedDateTime -le $lastReceived)) { continue }

    $fromAddr = ''; $fromName = ''
    if ($m.from -and $m.from.emailAddress) { $fromAddr = ("" + $m.from.emailAddress.address).ToLower(); $fromName = ("" + $m.from.emailAddress.name) }

    # contato (busca; cria se nao existir)
    $cid = $null
    if ($fromAddr) {
      $s = Invoke-RestMethod -Method Get -Uri ("$qbase/contacts/search?q=" + [uri]::EscapeDataString($fromAddr)) -Headers $qh
      $c = $s.payload | Where-Object { ("" + $_.email).ToLower() -eq $fromAddr } | Select-Object -First 1
      if ($c) { $cid = $c.id }
    }
    if (-not $cid) {
      $nm  = if ($fromName) { $fromName } elseif ($fromAddr) { $fromAddr } else { 'Desconhecido' }
      $ident = 'mail-' + ($fromAddr ? $fromAddr : [guid]::NewGuid().ToString())
      $cbody = @{ name = $nm; identifier = $ident }
      if ($fromAddr) { $cbody.email = $fromAddr }
      $cr  = Invoke-RestMethod -Method Post -Uri "$qbase/contacts" -Headers $qh -Body ($cbody | ConvertTo-Json)
      $cid = $cr.payload.contact.id
    }

    # conversa
    $sid     = 'msg-' + $m.id.Substring([Math]::Max(0, $m.id.Length - 40))
    $conv    = Invoke-RestMethod -Method Post -Uri "$qbase/conversations" -Headers $qh -Body (@{ inbox_id=$inbox; contact_id=$cid; source_id=$sid } | ConvertTo-Json)

    # corpo
    $txt = ''
    if ($m.body -and $m.body.contentType -eq 'html') { $txt = ($m.body.content -replace '<[^>]+>',' ') }
    elseif ($m.body) { $txt = $m.body.content } else { $txt = $m.bodyPreview }
    $txt = ($txt -replace '\s+',' ').Trim(); if ($txt.Length -gt 8000) { $txt = $txt.Substring(0,8000) }
    $dt = ''; if ($m.receivedDateTime) { $dt = ([DateTime]$m.receivedDateTime).ToString('dd/MM/yyyy HH:mm') }
    $content = "**$($m.subject)**`n_De: $fromName <$fromAddr> - $($dt)_`n`n$txt"
    Invoke-RestMethod -Method Post -Uri "$qbase/conversations/$($conv.id)/messages" -Headers $qh -Body (@{ content=$content; message_type='incoming' } | ConvertTo-Json) | Out-Null

    $seen[$m.id] = $conv.id
    if (-not $lastReceived -or ($m.receivedDateTime -gt $lastReceived)) { $lastReceived = $m.receivedDateTime }
    $pulled++
    Log("IN $fromAddr | $($m.subject) -> conv $($conv.id)")
  }

  [pscustomobject]@{ lastReceived = $lastReceived; seen = $seen } | ConvertTo-Json -Depth 5 | Set-Content -Path $stateFile -Encoding UTF8
  Log("ok pulled=$pulled lastReceived=$lastReceived")
  Write-Output "PULLED=$pulled lastReceived=$lastReceived"
}
catch {
  Log("ERRO " + $_.Exception.Message)
  Write-Output ("ERRO " + $_.Exception.Message)
  exit 1
}
