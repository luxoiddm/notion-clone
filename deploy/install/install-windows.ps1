<#
  Workspace — установка на Windows Server 2019/2022/2025 и Windows 10/11.

  Запуск (PowerShell от имени администратора):
    powershell -ExecutionPolicy Bypass -File deploy\install\install-windows.ps1
  или двойным щелчком по deploy\install\install-windows.cmd (сам попросит права администратора).

  Состав:
    Node.js LTS (официальный MSI с проверкой SHA-256),
    Caddy — веб-сервер с автоматическим HTTPS (сам выпускает и продлевает сертификаты Let's Encrypt),
    WinSW — обёртка, превращающая Node.js и Caddy в службы Windows,
    брандмауэр Защитника Windows — правила группы «Workspace».
  Видеозвонки: coturn под Windows не работает, поэтому свой TURN здесь не ставится.
  Можно указать отдельный TURN-сервер (например, coturn на Linux) — адрес и секрет.

  Повторный запуск обновляет установку (данные и настройки сохраняются).
#>
[CmdletBinding()]
param(
  [string]$Source = "",
  [string]$Prefix = "C:\Workspace",
  [string]$User = "workspace",
  [string]$AnswersFile = "",
  [switch]$NonInteractive,
  [switch]$Uninstall
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$InstallerVersion = "1.0.0"
$NodeMajor = 22
$ApiPort = 4000
$WebPort = 3000
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ------------------------------------------------------------------ состояние

$A = [ordered]@{
  MODE = ""; DOMAIN = ""; LE_EMAIL = ""; SERVER_IP = ""
  ADMIN_EMAIL = ""; ADMIN_NAME = ""; CALLS = ""; TURN_HOST = ""; TURN_PORT = "3478"
  FIREWALL = ""; EXTRA_PORTS = ""
}
$AdminPassword = ""
$AdminPasswordGenerated = $false
$TurnSecretInput = ""
$Action = "install"
$Releases = Join-Path $Prefix "releases"
$App = Join-Path $Prefix "app"
$Config = Join-Path $Prefix "config"
$Storage = Join-Path $Prefix "storage"
$Backups = Join-Path $Prefix "backups"
$Tools = Join-Path $Prefix "tools"
$Services = Join-Path $Prefix "services"
$Logs = Join-Path $Prefix "logs"
$CaddyData = Join-Path $Prefix "caddy"
$StateFile = Join-Path $Prefix "install.conf"
$LogFile = Join-Path $Prefix "install.log"
$StepN = 0
$StepTotal = 9
$SmokeFail = 0
$CertEnd = ""

# ------------------------------------------------------------------ вывод и вопросы

function Say($t) { Write-Host $t }
function Info($t) { Write-Host "• $t" -ForegroundColor Cyan }
function Ok($t) { Write-Host "✓ $t" -ForegroundColor Green }
function Warn($t) { Write-Host "! $t" -ForegroundColor Yellow }
function Bad($t) { Write-Host "✗ $t" -ForegroundColor Red }
function Die($t) {
  Bad $t
  Write-Host "  Журнал: $LogFile"
  Write-Host "  Исправьте причину и запустите скрипт снова — готовые шаги пропускаются."
  try { Stop-Transcript | Out-Null } catch { }
  exit 1
}
# Внешние программы пишут в stderr служебные сообщения; в PowerShell 5.1 при
# ErrorActionPreference=Stop это превращается в ошибку. Запускаем их через Exec.
function Exec([scriptblock]$Sb) {
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & $Sb 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $old }
}
function Step($t) { $script:StepN++; Write-Host ""; Write-Host "[$($script:StepN)/$StepTotal] $t" -ForegroundColor White -BackgroundColor DarkBlue }
function Hr { Write-Host "────────────────────────────────────────────────────────────" }

function Ask([string]$Key, [string]$Question, [string]$Default = "", [scriptblock]$Check = $null, [string]$Err = "Неверное значение") {
  $cur = $A[$Key]; if ($cur) { $Default = $cur }
  if ($NonInteractive) {
    if (-not $Default) { Die "Нет ответа на «$Question». Задайте $Key в файле ответов (-AnswersFile)." }
    if ($Check -and -not (& $Check $Default)) { Die "$Key=$Default — $Err" }
    $A[$Key] = $Default; Info "$Question`: $Default"; return
  }
  while ($true) {
    $prompt = if ($Default) { "? $Question [$Default]" } else { "? $Question" }
    $v = Read-Host $prompt
    if (-not $v) { $v = $Default }
    if (-not $v) { Warn "Нужен ответ"; continue }
    if ($Check -and -not (& $Check $v)) { Warn $Err; continue }
    $A[$Key] = $v.Trim(); return
  }
}

function AskYN([string]$Question, [bool]$Default = $true) {
  if ($NonInteractive) { return $Default }
  while ($true) {
    $hint = if ($Default) { "[Д/н]" } else { "[д/Н]" }
    $v = Read-Host "? $Question $hint"
    if (-not $v) { return $Default }
    if ($v -match '^(y|yes|д|да)$') { return $true }
    if ($v -match '^(n|no|н|нет)$') { return $false }
    Warn "Ответьте «да» или «нет»"
  }
}

function ConfirmYes([string]$What) {
  if ($NonInteractive) { Info "$What — подтверждено файлом ответов"; return }
  while ($true) {
    Write-Host "» $What" -ForegroundColor Yellow
    $v = Read-Host "  Когда будет готово, напишите yes (или no — прервать установку)"
    if ($v -match '^(yes|да)$') { return }
    if ($v -match '^(no|нет)$') { Die "Установка прервана по вашему ответу. Запустите снова, когда будете готовы." }
    Warn "Напишите yes, когда шаг выполнен"
  }
}

function New-Password([int]$Len = 18) {
  $chars = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] ($Len * 2)
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes[0..($Len - 1)] | ForEach-Object { $chars[$_ % $chars.Length] })
}
function New-Secret { New-Password 48 }

function AskPassword {
  if ($NonInteractive) { $script:AdminPassword = New-Password; $script:AdminPasswordGenerated = $true; return }
  while ($true) {
    $s1 = Read-Host "? Пароль администратора (Enter — сгенерировать надёжный)" -AsSecureString
    $p1 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s1))
    if (-not $p1) { $script:AdminPassword = New-Password; $script:AdminPasswordGenerated = $true; Ok "Пароль сгенерирован — покажу его в конце"; return }
    if ($p1.Length -lt 10) { Warn "Не короче 10 символов"; continue }
    if ($p1.Contains("'")) { Warn "Без символа ' (апостроф) — он ломает файл настроек"; continue }
    $s2 = Read-Host "? Повторите пароль" -AsSecureString
    $p2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s2))
    if ($p1 -ne $p2) { Warn "Пароли не совпадают"; continue }
    $script:AdminPassword = $p1; return
  }
}

$IsDomain = { param($v) $v -match '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{1,62}$' }
$IsEmail = { param($v) $v -match '^[^@\s]+@[^@\s]+\.[^@\s]+$' }
$IsIPv4 = { param($v) $v -match '^(\d{1,3}\.){3}\d{1,3}$' }
$IsName = { param($v) $v.Length -ge 1 -and $v.Length -le 60 -and -not $v.Contains('"') -and -not $v.Contains('\') }
$IsMode = { param($v) $v -eq "1" -or $v -eq "2" }
$IsPort = { param($v) $v -match '^\d{1,5}$' -and [int]$v -ge 1 -and [int]$v -le 65535 }
$IsPorts = { param($v) $v -eq "-" -or $v -match '^\d{1,5}(-\d{1,5})?(/(tcp|udp))?(\s*,\s*\d{1,5}(-\d{1,5})?(/(tcp|udp))?)*$' }

# ------------------------------------------------------------------ ответы

function Load-Answers([string]$File) {
  if (-not (Test-Path $File)) { Die "Файл ответов не найден: $File" }
  foreach ($line in Get-Content -Encoding UTF8 $File) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $k, $v = $line -split '=', 2
    $k = $k.Trim(); $v = $v.Trim().Trim('"').Trim("'")
    if ($A.Contains($k)) { $A[$k] = $v }
    elseif ($k -eq "ADMIN_PASSWORD") { $script:AdminPassword = $v }
    elseif ($k -eq "TURN_SECRET") { $script:TurnSecretInput = $v }
  }
}

function Save-State {
  $lines = @("# Ответы установщика Workspace ($(Get-Date -Format 'yyyy-MM-dd HH:mm')). Без паролей.")
  foreach ($k in $A.Keys) { $lines += "$k=$($A[$k])" }
  Set-Content -Encoding UTF8 -Path $StateFile -Value $lines
}

# ------------------------------------------------------------------ сеть

function Get-PublicIP {
  foreach ($u in "https://api.ipify.org", "https://ifconfig.me/ip", "https://icanhazip.com") {
    try { $ip = (Invoke-RestMethod -Uri $u -TimeoutSec 8).ToString().Trim(); if (& $IsIPv4 $ip) { return $ip } } catch { }
  }
  return ""
}
function Get-PublicIP6 {
  try { $ip = (Invoke-RestMethod -Uri "https://api64.ipify.org" -TimeoutSec 6).ToString().Trim(); if ($ip -match ':') { return $ip } } catch { }
  return ""
}
function Resolve-Records([string]$Name, [string]$Type, [string]$Server) {
  try {
    $r = Resolve-DnsName -Name $Name -Type $Type -Server $Server -DnsOnly -QuickTimeout -ErrorAction Stop
    switch ($Type) {
      "A" { return @($r | Where-Object { $_.Type -eq "A" } | ForEach-Object { $_.IPAddress }) }
      "AAAA" { return @($r | Where-Object { $_.Type -eq "AAAA" } | ForEach-Object { $_.IPAddress }) }
      default { return @($r) }
    }
  } catch { return @() }
}

function Check-Caa([string]$Domain) {
  $d = $Domain
  while ($d -match '\.') {
    try {
      $r = Resolve-DnsName -Name $d -Type 257 -Server 1.1.1.1 -DnsOnly -ErrorAction Stop | Where-Object { $_.Type -eq 257 -or $_.QueryType -eq 257 }
    } catch { $r = $null }
    if ($r) {
      $txt = ($r | Out-String)
      if ($txt -match 'letsencrypt\.org') { Ok "CAA-запись для $d разрешает Let's Encrypt"; return $true }
      Bad "У $d есть CAA-запись, которая не разрешает Let's Encrypt. Добавьте: $d. CAA 0 issue `"letsencrypt.org`""
      return $false
    }
    $d = $d.Substring($d.IndexOf('.') + 1)
  }
  Ok "CAA-ограничений нет"; return $true
}

function Verify-Dns {
  while ($true) {
    $problems = 0
    $a1 = Resolve-Records $A.DOMAIN "A" "1.1.1.1"
    $a2 = Resolve-Records $A.DOMAIN "A" "8.8.8.8"
    if (($a1 -contains $A.SERVER_IP) -and ($a2 -contains $A.SERVER_IP)) {
      Ok "A-запись $($A.DOMAIN) → $($A.SERVER_IP) (видна в 1.1.1.1 и 8.8.8.8)"
      $extra = @($a1 + $a2 | Where-Object { $_ -ne $A.SERVER_IP } | Sort-Object -Unique)
      if ($extra.Count) { Warn "Есть и другие A-записи: $($extra -join ', ') — оставьте только $($A.SERVER_IP)"; $problems++ }
    } else {
      Bad "A-запись $($A.DOMAIN) пока не указывает на $($A.SERVER_IP)"
      Say "    1.1.1.1 видит: $(if ($a1.Count) { $a1 -join ', ' } else { 'нет записи' })"
      Say "    8.8.8.8 видит: $(if ($a2.Count) { $a2 -join ', ' } else { 'нет записи' })"
      $problems++
    }
    $aaaa = Resolve-Records $A.DOMAIN "AAAA" "1.1.1.1"
    if ($aaaa.Count) {
      $ip6 = Get-PublicIP6
      if ($ip6 -and ($aaaa -contains $ip6)) { Ok "AAAA-запись указывает на IPv6 этого сервера" }
      else { Bad "Есть AAAA-запись ($($aaaa -join ', ')), но это не IPv6 этого сервера — Let's Encrypt не выпустит сертификат. Удалите её."; $problems++ }
    }
    if (-not (Check-Caa $A.DOMAIN)) { $problems++ }
    if ($problems -eq 0) { return }
    if ($NonInteractive) { Die "DNS настроен не так, как нужно (см. выше)." }
    $v = Read-Host "? Исправьте DNS и нажмите Enter для повторной проверки (q — прервать)"
    if ($v -eq "q") { Die "Прервано: DNS не готов." }
  }
}

# ------------------------------------------------------------------ проверки системы

function Check-System {
  $os = Get-CimInstance Win32_OperatingSystem
  $build = [int]$os.BuildNumber
  if ($build -lt 17763) { Die "Нужна Windows Server 2019 / Windows 10 1809 или новее (у вас $($os.Caption), сборка $build)." }
  Ok "$($os.Caption), сборка $build, $env:PROCESSOR_ARCHITECTURE"
  if ($env:PROCESSOR_ARCHITECTURE -notin @("AMD64", "ARM64")) { Die "Нужна 64-битная Windows" }
  $memMb = [math]::Round($os.TotalVisibleMemorySize / 1024)
  $drive = (Split-Path -Qualifier $Prefix)
  $freeGb = [math]::Floor((Get-PSDrive ($drive.TrimEnd(':'))).Free / 1GB)
  Info "Память: $memMb МБ, свободно на $drive`: $freeGb ГБ"
  if ($freeGb -lt 5) { Die "Нужно минимум 5 ГБ свободного места на $drive" }
  if ($memMb -lt 3000) { Warn "Для сборки желательно от 3 ГБ памяти. Если сборка упадёт — увеличьте файл подкачки." }
  try {
    $st = Exec { w32tm /query /status } | Out-String
    if ($st -match 'Leap Indicator: 3|Последний успешный|Last Successful Sync Time: unspecified') { Warn "Синхронизация времени не настроена — включите её (w32tm /resync)" } else { Ok "Служба времени работает" }
  } catch { Warn "Не удалось проверить синхронизацию времени" }
  foreach ($u in "https://registry.npmjs.org/", "https://fonts.googleapis.com/css2?family=Inter", "https://nodejs.org/dist/index.json", "https://api.github.com/") {
    try { Invoke-WebRequest -UseBasicParsing -Uri $u -TimeoutSec 15 | Out-Null; Ok "Доступ: $u" } catch { Die "Нет доступа к $u — серверу нужен исходящий HTTPS (пакеты npm, шрифты, Node.js, GitHub)." }
  }
}

function Port-Owner([int]$Port) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $c) { return "" }
  $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  if ($c.OwningProcess -eq 4) { return "System (HTTP.sys: IIS или другая служба Windows)" }
  if ($p) { return $p.ProcessName } else { return "PID $($c.OwningProcess)" }
}

function Check-Ports {
  $busy = 0
  foreach ($port in 80, 443, $ApiPort, $WebPort) {
    $o = Port-Owner $port
    if (-not $o) { Ok "Порт $port свободен"; continue }
    if ($o -match '^(caddy|node|workspace-)') { Ok "Порт $port занят $o — это Workspace, будет перенастроен"; continue }
    if ($o -match 'HTTP.sys') {
      $iis = Get-Service W3SVC -ErrorAction SilentlyContinue
      if ($iis -and $iis.Status -eq "Running") {
        Warn "Порт $port занят IIS (W3SVC)."
        if (AskYN "Остановить и отключить IIS?" $true) { Stop-Service W3SVC -Force; Set-Service W3SVC -StartupType Disabled; Stop-Service WAS -Force -ErrorAction SilentlyContinue; Ok "IIS остановлен"; continue }
      }
      Bad "Порт $port занят HTTP.sys. Посмотрите: netsh http show servicestate"
      $busy++; continue
    }
    Bad "Порт $port занят: $o"; $busy++
  }
  if ($busy) { Die "Освободите порты выше и запустите снова." }
}

# ------------------------------------------------------------------ вопросы

function Ask-Questions {
  Hr; Say "Несколько вопросов. В скобках — значение по умолчанию (Enter)."; Hr
  $pub = Get-PublicIP
  $locals = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne "127.0.0.1" -and $_.PrefixOrigin -ne "WellKnown" } | ForEach-Object { $_.IPAddress })
  if ($pub) { Info "Внешний IPv4: $pub"; if ($locals -notcontains $pub) { Info "Сервер за NAT (локальные адреса: $($locals -join ', ')) — нужен проброс портов на роутере/шлюзе" } }

  Say ""
  Say "Как будет открываться Workspace?"
  Say "  1) По домену с настоящим HTTPS (Let's Encrypt) — для работы, рекомендуется"
  Say "  2) По IP с внутренним сертификатом Caddy — для проверки (браузер один раз предупредит)"
  $m = if ($A.MODE -eq "ip") { "2" } else { "1" }
  $A.MODE = ""
  Ask "MODE" "Вариант" $m $IsMode "Введите 1 или 2"
  $A.MODE = if ($A.MODE -eq "1") { "domain" } else { "ip" }
  Ask "SERVER_IP" "Внешний IP-адрес сервера" $pub $IsIPv4 "Нужен IPv4 вида 203.0.113.10"
  if ($A.MODE -eq "domain") {
    Ask "DOMAIN" "Домен (например, workspace.company.ru)" "" $IsDomain "Нужно доменное имя"
    $A.DOMAIN = $A.DOMAIN.ToLower()
    Ask "LE_EMAIL" "Email для Let's Encrypt" "" $IsEmail "Нужен email"
    Say ""
    Say "  DNS: у регистратора домена добавьте запись"
    Say "      $($A.DOMAIN).   A   $($A.SERVER_IP)"
    Say "  Если есть AAAA-запись — удалите её."
    ConfirmYes "A-запись $($A.DOMAIN) → $($A.SERVER_IP) добавлена"
    Verify-Dns
  }
  Say ""
  Ask "ADMIN_EMAIL" "Email администратора (логин)" "" $IsEmail "Нужен email"
  Ask "ADMIN_NAME" "Имя администратора" "Администратор" $IsName "1–60 символов"
  if (-not (Test-Path (Join-Path $Storage "auth\credentials.json")) -and -not $AdminPassword) { AskPassword }

  Say ""
  Warn "Свой TURN-сервер (coturn) под Windows не работает. Без TURN видеозвонки проходят только внутри одной сети или при прямой видимости."
  if (AskYN "Есть отдельный TURN-сервер (например, coturn на Linux), который нужно подключить?" ($A.CALLS -eq "external")) {
    $A.CALLS = "external"
    Ask "TURN_HOST" "Адрес TURN-сервера (домен или IP)" $A.TURN_HOST { param($v) (& $IsDomain $v) -or (& $IsIPv4 $v) } "Домен или IPv4"
    Ask "TURN_PORT" "Порт TURN" $A.TURN_PORT $IsPort "Порт 1–65535"
    if (-not $TurnSecretInput) {
      $s = Read-Host "? Секрет TURN (static-auth-secret из turnserver.conf)" -AsSecureString
      $script:TurnSecretInput = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
    }
  } else { $A.CALLS = "no" }

  Say ""
  Say "  Брандмауэр Защитника Windows: откроем входящие TCP 80 и 443 (правила группы «Workspace»)."
  if (AskYN "Это новый сервер? Включить брандмауэр во всех профилях с запретом входящих по умолчанию (RDP/SSH останутся открыты)" ($A.FIREWALL -ne "rules")) { $A.FIREWALL = "new" } else { $A.FIREWALL = "rules" }
  $ex = if ($A.EXTRA_PORTS) { $A.EXTRA_PORTS } else { "-" }
  $A.EXTRA_PORTS = ""
  Ask "EXTRA_PORTS" "Открыть дополнительные порты? (например 8443/tcp; «-» — нет)" $ex $IsPorts "Формат: 8443/tcp,51820/udp или -"
  if ($A.EXTRA_PORTS -eq "-") { $A.EXTRA_PORTS = "" }

  Say ""
  Say "  Файрвол провайдера/облака (security group, панель хостинга) скрипт не видит. Входящие TCP 80 и 443 должны быть открыты."
  Say "  Если сервер за NAT — пробросьте TCP 80 и 443 на этот компьютер."
  ConfirmYes "Порты 80 и 443 открыты у провайдера (или ограничений нет)"

  Hr
  Say "Итого:"
  if ($A.MODE -eq "domain") { Say "  Адрес:         https://$($A.DOMAIN)" } else { Say "  Адрес:         https://$($A.SERVER_IP) (внутренний сертификат Caddy)" }
  Say "  Папка:         $Prefix (данные — $Storage)"
  Say "  Пользователь:  $User (службы Windows)"
  Say "  Администратор: $($A.ADMIN_NAME) <$($A.ADMIN_EMAIL)>"
  Say "  Звонки:        $(if ($A.CALLS -eq 'external') { "TURN $($A.TURN_HOST):$($A.TURN_PORT)" } else { 'без TURN (только внутри одной сети)' })"
  Say "  Брандмауэр:    $(if ($A.FIREWALL -eq 'new') { 'включить, запрет входящих по умолчанию + правила Workspace' } else { 'только правила Workspace' })"
  Hr
  ConfirmYes "Начать установку с этими настройками"
}

# ------------------------------------------------------------------ загрузки

function Download([string]$Url, [string]$Out) {
  Info "Загрузка $Url"
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Out -TimeoutSec 600
}

function Install-Node {
  $node = "C:\Program Files\nodejs\node.exe"
  if (Test-Path $node) {
    $v = (& $node -v).TrimStart('v'); if ([int]($v.Split('.')[0]) -ge 20) { Ok "Node.js v$v уже установлен"; $script:NodeExe = $node; return }
  }
  $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
  $rel = $index | Where-Object { $_.version -like "v$NodeMajor.*" -and $_.lts } | Select-Object -First 1
  if (-not $rel) { Die "Не найден Node.js $NodeMajor LTS на nodejs.org" }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
  $msi = "node-$($rel.version)-$arch.msi"
  $tmp = Join-Path $env:TEMP $msi
  Download "https://nodejs.org/dist/$($rel.version)/$msi" $tmp
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$($rel.version)/SHASUMS256.txt").Content
  $want = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($msi) } | Select-Object -First 1).Split(' ')[0]
  $got = (Get-FileHash -Algorithm SHA256 $tmp).Hash.ToLower()
  if ($want -ne $got) { Die "Контрольная сумма $msi не совпала — загрузка повреждена или подменена." }
  Ok "SHA-256 $msi совпадает"
  $p = Start-Process msiexec.exe -ArgumentList "/i `"$tmp`" /qn /norestart" -Wait -PassThru
  if ($p.ExitCode -ne 0) { Die "Установка Node.js завершилась с кодом $($p.ExitCode)" }
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
  $script:NodeExe = $node
  Ok "Node.js $($rel.version) установлен"
}

function Get-GithubLatest([string]$Repo) {
  Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "workspace-installer" }
}

function Install-Caddy {
  $exe = Join-Path $Tools "caddy.exe"
  if (Test-Path $exe) { Ok "Caddy уже есть ($((& $exe version) -split ' ' | Select-Object -First 1))"; return }
  $rel = Get-GithubLatest "caddyserver/caddy"
  $ver = $rel.tag_name.TrimStart('v')
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
  $zipName = "caddy_${ver}_windows_$arch.zip"
  $asset = $rel.assets | Where-Object { $_.name -eq $zipName }
  $sumAsset = $rel.assets | Where-Object { $_.name -eq "caddy_${ver}_checksums.txt" }
  if (-not $asset -or -not $sumAsset) { Die "В релизе Caddy $ver нет $zipName или файла контрольных сумм" }
  $zip = Join-Path $env:TEMP $zipName
  Download $asset.browser_download_url $zip
  $sums = (Invoke-WebRequest -UseBasicParsing -Uri $sumAsset.browser_download_url).Content
  $want = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($zipName) } | Select-Object -First 1).Split(' ')[0]
  $got = (Get-FileHash -Algorithm SHA512 $zip).Hash.ToLower()
  if ($want -ne $got) { Die "Контрольная сумма Caddy не совпала — загрузка повреждена или подменена." }
  Ok "SHA-512 Caddy $ver совпадает"
  $dir = Join-Path $env:TEMP "caddy-$ver"
  Expand-Archive -Force $zip $dir
  Copy-Item (Join-Path $dir "caddy.exe") $exe -Force
  Ok "Caddy $ver установлен"
}

function Install-WinSW {
  $exe = Join-Path $Tools "WinSW.exe"
  if (Test-Path $exe) { Ok "WinSW уже есть"; return }
  $rel = Get-GithubLatest "winsw/winsw"
  $asset = $rel.assets | Where-Object { $_.name -eq "WinSW-x64.exe" } | Select-Object -First 1
  if (-not $asset) { $asset = $rel.assets | Where-Object { $_.name -like "WinSW*.exe" -and $_.name -notlike "*x86*" } | Select-Object -First 1 }
  if (-not $asset) { Die "Не найден WinSW в релизе $($rel.tag_name)" }
  Download $asset.browser_download_url $exe
  Info "WinSW $($rel.tag_name), SHA-256: $((Get-FileHash -Algorithm SHA256 $exe).Hash)"
  Ok "WinSW установлен"
}

# ------------------------------------------------------------------ пользователь и права

function Ensure-User {
  $u = Get-LocalUser -Name $User -ErrorAction SilentlyContinue
  $pw = New-Password 32
  $sec = ConvertTo-SecureString $pw -AsPlainText -Force
  if (-not $u) {
    New-LocalUser -Name $User -Password $sec -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires -Description "Workspace service" | Out-Null
    Ok "Создан локальный пользователь $User (вход в систему не нужен)"
  } else {
    Set-LocalUser -Name $User -Password $sec
    Ok "Пользователь $User уже есть — пароль службы обновлён"
  }
  # Пароль нигде не сохраняется: он передаётся только диспетчеру служб.
  $script:ServicePassword = $pw
  Grant-ServiceLogon $User
}

function Grant-ServiceLogon([string]$Name) {
  $sid = (New-Object System.Security.Principal.NTAccount($Name)).Translate([System.Security.Principal.SecurityIdentifier]).Value
  $tmp = Join-Path $env:TEMP "ws-secpol.inf"
  $db = Join-Path $env:TEMP "ws-secpol.sdb"
  Exec { secedit /export /cfg $tmp /areas USER_RIGHTS } | Out-Null
  $c = Get-Content $tmp -Encoding Unicode
  $line = $c | Where-Object { $_ -match '^SeServiceLogonRight' }
  if ($line -and $line -match [regex]::Escape($sid)) { Remove-Item $tmp -Force; return }
  if ($line) { $c = $c -replace '^SeServiceLogonRight = (.*)$', "SeServiceLogonRight = `$1,*$sid" }
  else { $c = $c -replace '^\[Privilege Rights\]$', "[Privilege Rights]`r`nSeServiceLogonRight = *$sid" }
  Set-Content -Path $tmp -Value $c -Encoding Unicode
  Exec { secedit /configure /db $db /cfg $tmp /areas USER_RIGHTS } | Out-Null
  Remove-Item $tmp, $db -Force -ErrorAction SilentlyContinue
  Ok "Пользователю $Name разрешён вход как служба"
}

function Set-Acl-Dir([string]$Path, [string]$Rights) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  Exec { icacls $Path /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "${User}:(OI)(CI)$Rights" /T /C /Q } | Out-Null
}

# ------------------------------------------------------------------ исходники и сборка

function Find-ProjectRoot([string]$Dir) {
  foreach ($d in @($Dir) + @(Get-ChildItem -Directory $Dir -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })) {
    if ((Test-Path (Join-Path $d "package.json")) -and (Test-Path (Join-Path $d "apps\server")) -and (Test-Path (Join-Path $d "apps\web"))) { return $d }
  }
  return $null
}

function Resolve-Source {
  if (-not $Source) {
    $root = Resolve-Path (Join-Path $ScriptDir "..\..")
    if (Test-Path (Join-Path $root "apps\server")) { $script:Source = $root.Path }
    else { $script:Source = Read-Host "? Где взять код Workspace (папка или zip-архив)" }
  }
  if ($Source -like "*.zip") {
    if (-not (Test-Path $Source)) { Die "Архив не найден: $Source" }
    $tmp = Join-Path $env:TEMP ("ws-src-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    Expand-Archive -Force $Source $tmp
    $script:SrcRoot = Find-ProjectRoot $tmp
  } elseif ($Source -match '^(https?://|git@)') {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Die "Для загрузки из git нужен Git for Windows (https://git-scm.com)" }
    $tmp = Join-Path $env:TEMP ("ws-src-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    Exec { git clone --depth 1 $Source $tmp } | Add-Content $LogFile
    if ($LASTEXITCODE -ne 0) { Die "Не удалось загрузить $Source" }
    $script:SrcRoot = $tmp
  } else {
    if (-not (Test-Path $Source)) { Die "Папка не найдена: $Source" }
    $script:SrcRoot = Find-ProjectRoot $Source
  }
  if (-not $SrcRoot) { Die "В $Source нет проекта Workspace (package.json + apps\server + apps\web)" }
  $script:SrcVersion = (Get-Content -Raw (Join-Path $SrcRoot "package.json") | ConvertFrom-Json).version
  Ok "Код Workspace $SrcVersion`: $SrcRoot"
}

function Run-Npm([string]$Dir, [string]$Args1) {
  $npm = Join-Path (Split-Path $NodeExe) "npm.cmd"
  $p = Start-Process -FilePath $npm -ArgumentList $Args1 -WorkingDirectory $Dir -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput (Join-Path $Logs "npm.out.log") -RedirectStandardError (Join-Path $Logs "npm.err.log")
  Get-Content (Join-Path $Logs "npm.out.log"), (Join-Path $Logs "npm.err.log") -ErrorAction SilentlyContinue | Add-Content $LogFile
  return $p.ExitCode
}

function Build-Release {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $rel = Join-Path $Releases "$SrcVersion-$stamp"
  Info "Копирую код в $rel"
  $xd = @("node_modules", ".next", ".turbo", ".git", "storage", "dist")
  Exec { robocopy $SrcRoot $rel /E /XD $xd /XF ".env" ".env.local" /NFL /NDL /NJH /NJS /NP } | Out-Null
  if ($LASTEXITCODE -ge 8) { Die "Не удалось скопировать код (robocopy $LASTEXITCODE)" }
  New-Item -ItemType SymbolicLink -Force -Path (Join-Path $rel "apps\server\.env") -Target (Join-Path $Config "server.env") | Out-Null
  New-Item -ItemType SymbolicLink -Force -Path (Join-Path $rel "apps\web\.env.local") -Target (Join-Path $Config "web.env") | Out-Null
  $env:NEXT_TELEMETRY_DISABLED = "1"
  Info "Устанавливаю зависимости (npm ci) — 2–5 минут"
  if ((Run-Npm $rel "ci --no-audit --no-fund --loglevel=error") -ne 0) { Die "npm ci завершился с ошибкой (журнал: $LogFile)" }
  Info "Собираю (npm run build) — 3–10 минут"
  if ((Run-Npm $rel "run build") -ne 0) { Die "Сборка не удалась — текущая версия продолжает работать. Журнал: $LogFile" }
  if (-not (Test-Path (Join-Path $rel "apps\server\dist\index.js"))) { Die "Сборка не создала apps\server\dist\index.js" }
  if (-not (Test-Path (Join-Path $rel "apps\web\.next\BUILD_ID"))) { Die "Сборка не создала apps\web\.next" }
  Remove-Item -Recurse -Force (Join-Path $rel ".turbo\cache") -ErrorAction SilentlyContinue
  Exec { icacls $rel /grant "${User}:(OI)(CI)M" /T /C /Q } | Out-Null
  $script:NewRelease = $rel
  Ok "Версия $SrcVersion собрана"
}

function Write-Env {
  New-Item -ItemType Directory -Force -Path $Config | Out-Null
  $f = Join-Path $Config "server.env"; $w = Join-Path $Config "web.env"
  $old = @{}
  if (Test-Path $f) { foreach ($l in Get-Content $f) { if ($l -match '^([A-Z_]+)=(.*)$') { $old[$Matches[1]] = $Matches[2] } } }
  $access = if ($old["ACCESS_TOKEN_SECRET"]) { $old["ACCESS_TOKEN_SECRET"] } else { New-Secret }
  $refresh = if ($old["REFRESH_TOKEN_SECRET"]) { $old["REFRESH_TOKEN_SECRET"] } else { New-Secret }
  $turnSecret = if ($TurnSecretInput) { $TurnSecretInput } elseif ($old["TURN_SECRET"]) { $old["TURN_SECRET"] } else { "" }
  $origin = if ($A.MODE -eq "domain") { "https://$($A.DOMAIN)" } else { "https://$($A.SERVER_IP)" }
  $pwLine = "ADMIN_PASSWORD="
  # В кавычках: dotenv иначе обрежет значение на # и пробелах.
  if ($AdminPassword -and -not (Test-Path (Join-Path $Storage "auth\credentials.json"))) { $pwLine = "ADMIN_PASSWORD='$AdminPassword'" }
  $lines = @(
    "# Создано установщиком Workspace.",
    "PORT=$ApiPort", "BIND_HOST=127.0.0.1", "WEB_ORIGIN=$origin",
    "STORAGE_ROOT=$($Storage -replace '\\','/')",
    "ACCESS_TOKEN_SECRET=$access", "REFRESH_TOKEN_SECRET=$refresh",
    "ADMIN_EMAIL=$($A.ADMIN_EMAIL)", $pwLine, "ADMIN_DISPLAY_NAME=`"$($A.ADMIN_NAME)`"",
    "TURN_HOST=$(if ($A.CALLS -eq 'external') { $A.TURN_HOST })",
    "TURN_PORT=$($A.TURN_PORT)", "TURN_TLS_PORT=",
    "TURN_SECRET=$(if ($A.CALLS -eq 'external') { $turnSecret })",
    "TURN_CREDENTIAL_TTL_SECONDS=3600"
  )
  foreach ($k in "KLIPY_API_KEY", "GIPHY_API_KEY", "CHAT_ALLOWED_MIME_TYPES", "TILE_SHEET_COLS", "TILE_SHEET_ROWS", "TILE_SIZE") { if ($old[$k]) { $lines += "$k=$($old[$k])" } }
  [IO.File]::WriteAllLines($f, $lines, (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllLines($w, @("# Создано установщиком Workspace.", "PORT=$WebPort", "BIND_HOST=127.0.0.1", "NEXT_PUBLIC_API_URL=$origin"), (New-Object Text.UTF8Encoding($false)))
  Exec { icacls $Config /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "${User}:(OI)(CI)R" /T /C /Q } | Out-Null
  Ok "Настройки: $f, $w (секреты сохранены)"
}

function Scrub-AdminPassword {
  $f = Join-Path $Config "server.env"
  $c = Get-Content $f
  if ($c -match '^ADMIN_PASSWORD=.+') {
    $c = $c -replace '^ADMIN_PASSWORD=.*$', 'ADMIN_PASSWORD='
    [IO.File]::WriteAllLines($f, $c, (New-Object Text.UTF8Encoding($false)))
    Ok "Пароль администратора убран из $f (нужен был только для первого запуска)"
  }
}

# ------------------------------------------------------------------ службы

function Write-ServiceXml([string]$Id, [string]$Name, [string]$Exe, [string]$Arguments, [string]$WorkDir) {
  New-Item -ItemType Directory -Force -Path $Services | Out-Null
  $xml = @"
<service>
  <id>$Id</id>
  <name>$Name</name>
  <description>$Name (Workspace)</description>
  <executable>$Exe</executable>
  <arguments>$Arguments</arguments>
  <workingdirectory>$WorkDir</workingdirectory>
  <env name="NODE_ENV" value="production"/>
  <env name="NEXT_TELEMETRY_DISABLED" value="1"/>
  <env name="XDG_DATA_HOME" value="$CaddyData"/>
  <env name="XDG_CONFIG_HOME" value="$CaddyData"/>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <onfailure action="restart" delay="5 sec"/>
  <resetfailure>1 hour</resetfailure>
  <logpath>$Logs</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>5</keepFiles></log>
</service>
"@
  Set-Content -Encoding UTF8 -Path (Join-Path $Services "$Id.xml") -Value $xml
  Copy-Item (Join-Path $Tools "WinSW.exe") (Join-Path $Services "$Id.exe") -Force
  $svc = Get-Service $Id -ErrorAction SilentlyContinue
  if (-not $svc) {
    $exe = Join-Path $Services "$Id.exe"
    Exec { & $exe install } | Add-Content $LogFile
    if ($LASTEXITCODE -ne 0) { Die "Не удалось зарегистрировать службу $Id" }
  }
  Exec { sc.exe config $Id obj= ".\$User" password= "$ServicePassword" } | Out-Null
  if ($LASTEXITCODE -ne 0) { Die "Не удалось задать учётную запись службы $Id" }
}

function Install-Services {
  $nextBin = Join-Path $App "node_modules\next\dist\bin\next"
  Write-ServiceXml "workspace-server" "Workspace API" $NodeExe "--import tsx src\index.ts" (Join-Path $App "apps\server")
  Write-ServiceXml "workspace-web" "Workspace Web" $NodeExe "`"$nextBin`" start -p $WebPort -H 127.0.0.1" (Join-Path $App "apps\web")
  Ok "Службы workspace-server и workspace-web (автозапуск, перезапуск при сбое)"
}

function Restart-App {
  foreach ($s in "workspace-server", "workspace-web") { Restart-Service $s -Force -ErrorAction SilentlyContinue; if ((Get-Service $s).Status -ne "Running") { Start-Service $s } }
}

function Wait-Healthy {
  for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$ApiPort/health" -TimeoutSec 3 | Out-Null; break } catch { Start-Sleep 2 } }
  try { Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$ApiPort/health" -TimeoutSec 3 | Out-Null } catch { Bad "API не отвечает"; return $false }
  for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$WebPort/" -TimeoutSec 5 | Out-Null; return $true } catch { Start-Sleep 2 } }
  Bad "Веб-приложение не отвечает"; return $false
}

function Switch-App([string]$Target) {
  if (Test-Path $App) { Exec { cmd /c rmdir "$App" } | Out-Null }
  Exec { cmd /c mklink /J "$App" "$Target" } | Out-Null
}

function Activate-Release {
  $prev = $null
  if (Test-Path $App) { $prev = (Get-Item $App).Target | Select-Object -First 1 }
  Stop-Service workspace-web, workspace-server -Force -ErrorAction SilentlyContinue
  Switch-App $NewRelease
  Restart-App
  if (Wait-Healthy) {
    Ok "Новая версия работает"
    Get-ChildItem -Directory $Releases | Sort-Object CreationTime -Descending | Select-Object -Skip 3 | Where-Object { $_.FullName -ne $NewRelease } | ForEach-Object { Remove-Item -Recurse -Force $_.FullName; Info "Удалена старая версия $($_.Name)" }
  } else {
    if ($prev -and (Test-Path $prev)) {
      Bad "Новая версия не отвечает — возвращаю прежнюю ($prev)"
      Stop-Service workspace-web, workspace-server -Force -ErrorAction SilentlyContinue
      Switch-App $prev; Restart-App; Wait-Healthy | Out-Null
      Die "Обновление откатено. Логи служб: $Logs"
    }
    Die "Приложение не запустилось. Логи служб: $Logs"
  }
}

# ------------------------------------------------------------------ Caddy (HTTPS)

function Write-Caddyfile([bool]$Staging) {
  $f = Join-Path $Prefix "Caddyfile"
  $site = if ($A.MODE -eq "domain") { $A.DOMAIN } else { "https://$($A.SERVER_IP)" }
  $tls = if ($A.MODE -eq "domain") { "" } else { "    tls internal" }
  $global = "{`n    email $(if ($A.LE_EMAIL) { $A.LE_EMAIL } else { $A.ADMIN_EMAIL })`n    storage file_system `"$($CaddyData -replace '\\','/')`"`n"
  # Только Let's Encrypt (без запасного ZeroSSL): сначала тестовый сервер, потом настоящий.
  if ($Staging) { $global += "    acme_ca https://acme-staging-v02.api.letsencrypt.org/directory`n" }
  else { $global += "    acme_ca https://acme-v02.api.letsencrypt.org/directory`n" }
  $global += "}`n"
  $body = @"
$site {
$tls
    encode gzip
    request_body {
        max_size 30MB
    }
    header Strict-Transport-Security "max-age=31536000"
    @api path /api/* /socket.io/* /health
    reverse_proxy @api 127.0.0.1:$ApiPort
    reverse_proxy 127.0.0.1:$WebPort
}
"@
  Set-Content -Encoding ASCII -Path $f -Value ($global + $body)
  $caddyExe = Join-Path $Tools "caddy.exe"
  Exec { & $caddyExe validate --config $f --adapter caddyfile } | Add-Content $LogFile
  if ($LASTEXITCODE -ne 0) { Get-Content $f; Die "Caddy не принял конфигурацию (см. выше и журнал)" }
}

function Start-Caddy {
  $caddy = Join-Path $Tools "caddy.exe"
  New-Item -ItemType Directory -Force -Path $CaddyData | Out-Null
  Exec { icacls $CaddyData /grant "${User}:(OI)(CI)M" /T /C /Q } | Out-Null
  if (-not (Get-Service workspace-caddy -ErrorAction SilentlyContinue)) {
    Write-ServiceXml "workspace-caddy" "Workspace HTTPS (Caddy)" $caddy "run --config `"$(Join-Path $Prefix 'Caddyfile')`" --adapter caddyfile" $Prefix
  } else { Exec { sc.exe config workspace-caddy obj= ".\$User" password= "$ServicePassword" } | Out-Null }
  Restart-Service workspace-caddy -Force -ErrorAction SilentlyContinue
  if ((Get-Service workspace-caddy).Status -ne "Running") { Start-Service workspace-caddy }
}

function Cert-Issued([bool]$Staging) {
  $ca = if ($Staging) { "acme-staging-v02.api.letsencrypt.org-directory" } else { "acme-v02.api.letsencrypt.org-directory" }
  $p = Join-Path $CaddyData "certificates\$ca\$($A.DOMAIN)\$($A.DOMAIN).crt"
  return (Test-Path $p)
}

function Setup-Https {
  if ($A.MODE -eq "domain" -and -not (Cert-Issued $false)) {
    while ($true) {
      Info "Пробный выпуск сертификата (тестовый сервер Let's Encrypt, лимиты не тратятся)…"
      Write-Caddyfile $true; Start-Caddy
      $okc = $false
      for ($i = 0; $i -lt 60; $i++) { if (Cert-Issued $true) { $okc = $true; break }; Start-Sleep 3 }
      if ($okc) { Ok "Пробный выпуск прошёл — Let's Encrypt видит сервер снаружи"; break }
      Bad "Пробный выпуск не прошёл за 3 минуты. Последние строки журнала Caddy:"
      Get-ChildItem $Logs -Filter "workspace-caddy*.log" | Sort-Object LastWriteTime -Descending | Select-Object -First 1 | ForEach-Object { Get-Content $_.FullName -Tail 15 }
      Say "  Частые причины: порт 80/443 закрыт у провайдера или на роутере, A-запись ещё не обновилась, есть чужая AAAA-запись."
      if ($NonInteractive) { Die "Сертификат не выпущен" }
      $v = Read-Host "? Исправьте причину и нажмите Enter для повтора (q — прервать)"
      if ($v -eq "q") { Die "Прервано на выпуске сертификата" }
    }
    Info "Выпускаю сертификат…"
    Write-Caddyfile $false; Start-Caddy
    for ($i = 0; $i -lt 60; $i++) { if (Cert-Issued $false) { break }; Start-Sleep 3 }
    if (-not (Cert-Issued $false)) { Die "Caddy не получил сертификат Let's Encrypt (пробный прошёл). Журнал: $Logs" }
    Ok "Сертификат Let's Encrypt для $($A.DOMAIN) выпущен; Caddy продлевает его сам"
  } else {
    Write-Caddyfile $false; Start-Caddy
    if ($A.MODE -eq "domain") { Ok "Сертификат для $($A.DOMAIN) уже есть" } else { Ok "HTTPS по IP с внутренним сертификатом Caddy" }
  }
}

# ------------------------------------------------------------------ брандмауэр

function Wait-RemoteConfirm([int]$Seconds) {
  if ($NonInteractive) { return $true }
  Say ""
  Say "  Проверка доступа: правила применены. Не закрывая это окно, подключитесь к серверу ЗАНОВО (RDP или SSH)"
  Say "  и убедитесь, что вход работает. Если не подтвердить за $Seconds с — правила откатятся сами."
  $deadline = (Get-Date).AddSeconds($Seconds); $buf = ""
  Write-Host -NoNewline "  Новое подключение работает? Напишите yes и Enter: "
  while ((Get-Date) -lt $deadline) {
    if ([Console]::KeyAvailable) {
      $k = [Console]::ReadKey($false)
      if ($k.Key -eq "Enter") { Write-Host ""; if ($buf -match '^(yes|да)$') { return $true }; $buf = ""; Write-Host -NoNewline "  Напишите yes: " }
      else { $buf += $k.KeyChar }
    } else { Start-Sleep -Milliseconds 200 }
  }
  Write-Host ""
  return $false
}

function Setup-Firewall {
  $group = "Workspace"
  Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -Group $group -DisplayName "Workspace — HTTP/HTTPS" -Direction Inbound -Protocol TCP -LocalPort 80, 443 -Action Allow -Profile Any | Out-Null
  foreach ($item in ($A.EXTRA_PORTS -split ',' | Where-Object { $_.Trim() })) {
    $it = $item.Trim(); $proto = if ($it -like "*/udp") { "UDP" } else { "TCP" }; $port = ($it -split '/')[0]
    New-NetFirewallRule -Group $group -DisplayName "Workspace — дополнительно $it" -Direction Inbound -Protocol $proto -LocalPort $port -Action Allow -Profile Any | Out-Null
  }
  Ok "Правила брандмауэра «Workspace»: входящие TCP 80, 443$(if ($A.EXTRA_PORTS) { ", $($A.EXTRA_PORTS)" })"
  if ($A.FIREWALL -ne "new") { return }
  # Удалённый доступ не должен пропасть: включаем штатные правила RDP/SSH/WinRM, если службы есть.
  if ((Get-ItemProperty 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -ErrorAction SilentlyContinue).fDenyTSConnections -eq 0) {
    Enable-NetFirewallRule -DisplayGroup "Remote Desktop" -ErrorAction SilentlyContinue; Enable-NetFirewallRule -DisplayGroup "Удаленный рабочий стол" -ErrorAction SilentlyContinue
    Info "RDP включён — его правила брандмауэра оставлены открытыми"
  }
  if (Get-Service sshd -ErrorAction SilentlyContinue) {
    if (-not (Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" -Direction Inbound -Protocol TCP -LocalPort 22 -Action Allow | Out-Null
    } else { Enable-NetFirewallRule -Name "OpenSSH-Server-In-TCP" }
    Info "OpenSSH Server есть — порт 22 оставлен открытым"
  }
  if (Get-Service WinRM -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq "Running" }) {
    Enable-NetFirewallRule -DisplayGroup "Windows Remote Management" -ErrorAction SilentlyContinue
  }
  $before = Get-NetFirewallProfile | Select-Object Name, Enabled, DefaultInboundAction
  Set-NetFirewallProfile -All -Enabled True -DefaultInboundAction Block -DefaultOutboundAction Allow
  $restore = $before | ForEach-Object { "Set-NetFirewallProfile -Name $($_.Name) -Enabled $($_.Enabled) -DefaultInboundAction $($_.DefaultInboundAction)" }
  $job = Start-Job -ScriptBlock { param($cmds) Start-Sleep 120; foreach ($c in $cmds) { Invoke-Expression $c } } -ArgumentList (, $restore)
  $remote = ($env:SESSIONNAME -like "RDP*") -or $env:SSH_CONNECTION
  $confirmed = if ($remote) { Wait-RemoteConfirm 110 } else { $true }
  if ($confirmed) {
    Stop-Job $job -ErrorAction SilentlyContinue; Remove-Job $job -Force -ErrorAction SilentlyContinue
    Ok "Брандмауэр включён во всех профилях: входящие запрещены, кроме правил выше"
  } else {
    Info "Возвращаю прежние настройки брандмауэра…"
    Wait-Job $job | Out-Null; Remove-Job $job -Force
    Die "Настройки брандмауэра откатены: удалённый доступ не подтверждён."
  }
}

# ------------------------------------------------------------------ проверки

function Smoke([string]$Name, [scriptblock]$Test) {
  $r = $false
  try { $r = [bool](& $Test) } catch { $r = $false }
  if ($r) { Ok $Name } else { Bad $Name; $script:SmokeFail++ }
}

function CurlSite([string]$Path, [string[]]$Extra = @()) {
  if ($A.MODE -eq "domain") { $args1 = @("-fsS", "--max-time", "10", "--resolve", "$($A.DOMAIN):443:127.0.0.1") + $Extra + @("https://$($A.DOMAIN)$Path") }
  else { $args1 = @("-fsS", "-k", "--max-time", "10") + $Extra + @("https://127.0.0.1$Path") }
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $out = & curl.exe @args1 2>$null } finally { $ErrorActionPreference = $old }
  if ($LASTEXITCODE -ne 0) { return $null }
  return ($out -join "`n")
}

# Socket.io работает только по WebSocket — проверяем, что Caddy пропускает апгрейд (ответ 101).
function Test-WebSocket {
  if ($A.MODE -eq "domain") { $url = "https://$($A.DOMAIN)/socket.io/?EIO=4&transport=websocket"; $res = @("--resolve", "$($A.DOMAIN):443:127.0.0.1") }
  else { $url = "https://127.0.0.1/socket.io/?EIO=4&transport=websocket"; $res = @() }
  $a = @("-sS", "-i", "-N", "-k", "--http1.1", "--max-time", "4") + $res + @("-H", "Connection: Upgrade", "-H", "Upgrade: websocket", "-H", "Sec-WebSocket-Version: 13", "-H", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", $url)
  $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $out = (& curl.exe @a 2>$null) -join "`n" } finally { $ErrorActionPreference = $old }
  return ($out -match 'HTTP/1.1 101')
}

function Run-Smoke {
  $script:SmokeFail = 0
  foreach ($s in "workspace-server", "workspace-web", "workspace-caddy") { $n = $s; Smoke "Служба $n работает" { (Get-Service $n).Status -eq "Running" } }
  Smoke "Службы запускаются автоматически" { @(Get-Service workspace-server, workspace-web, workspace-caddy | Where-Object { $_.StartType -ne "Automatic" }).Count -eq 0 }
  Smoke "API отвечает локально" { (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$ApiPort/health" -TimeoutSec 5).StatusCode -eq 200 }
  if ($A.MODE -eq "domain") {
    Smoke "HTTPS: сертификат действителен для $($A.DOMAIN)" {
      $null -ne (CurlSite "/" @("-o", "NUL"))
    }
    $c = Get-ChildItem -Recurse (Join-Path $CaddyData "certificates\acme-v02.api.letsencrypt.org-directory") -Filter "$($A.DOMAIN).crt" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { $script:CertEnd = (New-Object Security.Cryptography.X509Certificates.X509Certificate2($c.FullName)).NotAfter.ToString("yyyy-MM-dd") }
  }
  Smoke "Через Caddy: /health" { (CurlSite "/health") -match '"status":"ok"' }
  Smoke "Через Caddy: страница входа" { (CurlSite "/") -match '<html' }
  Smoke "WebSocket-канал (чаты, звонки) проходит" { Test-WebSocket }
  if ($AdminPassword) {
    $body = (@{ email = $A.ADMIN_EMAIL; password = $AdminPassword } | ConvertTo-Json -Compress)
    $tmp = Join-Path $env:TEMP "ws-login.json"; [IO.File]::WriteAllText($tmp, $body)
    $script:LoginToken = ""
    Smoke "Вход администратора $($A.ADMIN_EMAIL)" {
      $r = CurlSite "/api/auth/login" @("-H", "Content-Type: application/json", "--data-binary", "@$tmp")
      if ($r -match '"accessToken":"([^"]+)"') { $script:LoginToken = $Matches[1]; $true } else { $false }
    }
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    if ($A.CALLS -eq "external") { Smoke "Звонки: сервер выдаёт адреса TURN" { (CurlSite "/api/webrtc/ice-servers" @("-H", "Authorization: Bearer $LoginToken")) -match 'turn:' } }
  }
  Smoke "Брандмауэр: правило Workspace для 80/443" { @(Get-NetFirewallRule -Group "Workspace" -ErrorAction SilentlyContinue).Count -ge 1 }
}

function Print-Checklist {
  $url = if ($A.MODE -eq "domain") { "https://$($A.DOMAIN)" } else { "https://$($A.SERVER_IP)" }
  $f = Join-Path $Prefix "CHECKLIST.txt"
  $t = @(
    "Workspace $SrcVersion — установлено $(Get-Date -Format 'yyyy-MM-dd HH:mm')", "",
    "[ ] Открыть $url и войти: $($A.ADMIN_EMAIL)"
  )
  if ($A.MODE -eq "ip") { $t += "    (сертификат внутренний — браузер предупредит один раз)" }
  $t += "[ ] Сменить пароль администратора, создать сотрудников (Администрирование)"
  $t += "[ ] Настроить резервное копирование: $Storage и $Config"
  if ($A.MODE -eq "domain") { $t += "[ ] Сертификат действует до: $CertEnd; Caddy продлевает его сам" }
  if ($A.CALLS -ne "external") { $t += "[ ] Звонки без TURN: работают внутри одной сети. Для звонков через интернет — отдельный coturn (Linux)" }
  $t += ""; $t += "Где что:"
  $t += "  код:        $App"; $t += "  настройки:  $Config\server.env, $Config\web.env"; $t += "  данные:     $Storage"; $t += "  логи служб: $Logs"; $t += "  журнал:     $LogFile"
  $t += ""; $t += "Команды (PowerShell от администратора):"
  $t += "  состояние:  Get-Service workspace-*"
  $t += "  перезапуск: Restart-Service workspace-server, workspace-web"
  $t += "  обновить:   скачайте новую версию и запустите её install-windows.cmd — данные и настройки сохранятся"
  $t += "  забыли пароль администратора:"
  $t += "              cd $App; npm run admin:reset-password -w apps/server -- $($A.ADMIN_EMAIL) `"НовыйПароль`""
  Set-Content -Encoding UTF8 -Path $f -Value $t
  Hr; $t | ForEach-Object { Say $_ }; Hr
  if ($AdminPasswordGenerated -and $AdminPassword) {
    # Пароль — только на экран, в обход журнала.
    try { Stop-Transcript | Out-Null } catch { }
    Write-Host ""
    Write-Host "Пароль администратора (показан один раз, нигде не сохранён): $AdminPassword" -ForegroundColor Yellow
  }
  Say "Чек-лист сохранён: $f"
}

# ------------------------------------------------------------------ удаление

function Do-Uninstall {
  if (Test-Path $StateFile) { Load-Answers $StateFile }
  Warn "Будут удалены службы Workspace (API, Web, Caddy) и правила брандмауэра «Workspace»."
  ConfirmYes "Удалить Workspace с этого компьютера"
  foreach ($s in "workspace-caddy", "workspace-web", "workspace-server") {
    if (Get-Service $s -ErrorAction SilentlyContinue) {
      Stop-Service $s -Force -ErrorAction SilentlyContinue
      $exe = Join-Path $Services "$s.exe"
      if (Test-Path $exe) { Exec { & $exe uninstall } | Out-Null } else { Exec { sc.exe delete $s } | Out-Null }
    }
  }
  Get-NetFirewallRule -Group "Workspace" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  Ok "Службы и правила брандмауэра удалены"
  if (Test-Path $App) { Exec { cmd /c rmdir "$App" } | Out-Null }
  Remove-Item -Recurse -Force $Releases, $Services -ErrorAction SilentlyContinue
  Warn "Данные: $Storage, настройки: $Config, сертификаты: $CaddyData"
  if (AskYN "Удалить и данные? Это необратимо" $false) {
    $v = Read-Host "  Для подтверждения напишите DELETE"
    if ($v -eq "DELETE") {
      try { Stop-Transcript | Out-Null } catch { }
      Remove-Item -Recurse -Force $Prefix -ErrorAction SilentlyContinue
      Remove-LocalUser -Name $User -ErrorAction SilentlyContinue
      Ok "Данные и пользователь $User удалены"
    } else { Warn "Данные сохранены" }
  } else { Ok "Данные сохранены в $Prefix" }
  Ok "Workspace удалён"
}

# ------------------------------------------------------------------ главный сценарий

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Запустите PowerShell от имени администратора (или install-windows.cmd)." -ForegroundColor Red; exit 1
}
if ($User -notmatch '^[a-z_][a-z0-9_-]{0,19}$') { Write-Host "Имя пользователя «$User» не подходит: строчные латинские буквы, цифры, _ и -, до 20 символов" -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Force -Path $Prefix, $Logs, $Tools | Out-Null
Start-Transcript -Append -Path $LogFile | Out-Null
trap { Bad "Ошибка: $($_.Exception.Message)"; Bad "  в: $($_.InvocationInfo.PositionMessage)"; Die "Установка остановлена." }

Say ""
Say "Workspace — установка (установщик $InstallerVersion, Windows)"
if ($AnswersFile) { Load-Answers $AnswersFile }

if ($Uninstall) { Do-Uninstall; try { Stop-Transcript | Out-Null } catch { }; exit 0 }

if ((Test-Path $App) -and (Test-Path $StateFile)) {
  $Action = "update"
  Load-Answers $StateFile
  Info "Найдена установка в $Prefix"
  Say "  1) Обновить до новой версии (данные и настройки сохраняются)"
  Say "  2) Пройти настройку заново и обновить"
  $tmpA = $A.MODE; $A.MODE = ""
  Ask "MODE" "Что сделать" "1" $IsMode "Введите 1 или 2"
  if ($A.MODE -eq "2") { $Action = "reconfigure" }
  $A.MODE = $tmpA
}

Step "Проверка системы"
Check-System

if ($Action -eq "update") {
  Step "Настройки — из прошлой установки"
  if ($A.MODE -eq "domain") { Verify-Dns }
} else {
  Step "Настройки"
  Ask-Questions
}
Check-Ports
Save-State

Step "Компоненты: Node.js $NodeMajor, Caddy, WinSW"
Install-Node
New-Item -ItemType Directory -Force -Path $Releases, $Config, $Storage, $Backups, $Services | Out-Null
Install-Caddy
Install-WinSW

Step "Пользователь $User и папки"
Ensure-User
Set-Acl-Dir $Storage "M"
Exec { icacls $Prefix /grant "${User}:(RX)" /C /Q } | Out-Null
Exec { icacls $Logs /grant "${User}:(OI)(CI)M" /T /C /Q } | Out-Null
if ($Action -ne "install" -and (Test-Path $Storage)) {
  if (AskYN "Сделать резервную копию данных перед обновлением?" $true) {
    $bk = Join-Path $Backups ("storage-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".zip")
    Compress-Archive -Path $Storage, $Config -DestinationPath $bk
    Ok "Резервная копия: $bk"
  }
}
Write-Env

Step "Сборка Workspace"
Resolve-Source
Build-Release

Step "Запуск служб"
Install-Services
Activate-Release
if ($AdminPassword) { Scrub-AdminPassword }

Step "HTTPS (Caddy)"
Setup-Https

Step "Брандмауэр"
Setup-Firewall

Step "Проверка работы"
Start-Sleep 2
Run-Smoke
Say ""
if ($SmokeFail -eq 0) { Ok "Все проверки пройдены" } else { Warn "Не прошло проверок: $SmokeFail. Логи служб: $Logs, журнал: $LogFile" }
Print-Checklist
try { Stop-Transcript | Out-Null } catch { }
if ($SmokeFail -ne 0) { exit 2 }
