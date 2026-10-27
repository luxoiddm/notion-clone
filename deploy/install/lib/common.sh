# shellcheck shell=bash
# Workspace — общая часть установщика для Linux (Debian/Ubuntu, RHEL/Rocky)
# и macOS. Подключается из install-<ос>.sh, который до вызова `ws_main`
# определяет функции os_* (пакеты, Node, службы, файрвол и т. д.).
#
# Совместимо с bash 3.2 (macOS): без ассоциативных массивов, ${x,,},
# mapfile и прочего из bash 4.
#
# Что делает (по шагам, см. ws_main):
#   1. проверки системы (права, ОС, память, диск, время, порты, интернет);
#   2. вопросы (домен, DNS, администратор, звонки, файрвол) — с проверкой
#      каждого ответа, где это возможно (DNS, CAA, AAAA — автоматически);
#   3. пакеты (nginx, certbot, coturn, nftables, Node.js LTS);
#   4. пользователь workspace и папки /opt/workspace/{releases,config,storage};
#   5. сборка новой версии в releases/<версия>-<время>, переключение
#      ссылки app → на неё, перезапуск служб; при ошибке — откат;
#   6. nginx, сертификат (сначала пробный выпуск, потом настоящий), coturn;
#   7. файрвол (nftables с автоматическим откатом, если пропал SSH);
#   8. проверка работы и короткий чек-лист.
#
# Повторный запуск безопасен: найденная установка обновляется, данные
# (storage) и секреты (config/*.env) не трогаются.

set -Eeuo pipefail

WS_INSTALLER_VERSION="1.0.0"
WS_USER="${WS_USER:-workspace}"
WS_PREFIX="${WS_PREFIX:-/opt/workspace}"
NODE_MAJOR="${NODE_MAJOR:-22}"
API_PORT="${API_PORT:-4000}"
WEB_PORT="${WEB_PORT:-3000}"

# Ответы (могут прийти из --answers или из прошлой установки)
MODE="${MODE:-}"                 # domain | ip
DOMAIN="${DOMAIN:-}"
LE_EMAIL="${LE_EMAIL:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
ADMIN_NAME="${ADMIN_NAME:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
CALLS="${CALLS:-}"               # yes | no
TURN_MIN_PORT="${TURN_MIN_PORT:-49152}"
TURN_MAX_PORT="${TURN_MAX_PORT:-49452}"
TURN_PORT="${TURN_PORT:-3478}"
TURN_TLS_PORT="${TURN_TLS_PORT:-5349}"
FIREWALL="${FIREWALL:-}"         # nft-new | nft-add | existing | none
SSH_PORTS="${SSH_PORTS:-}"
EXTRA_PORTS="${EXTRA_PORTS:-}"
SOURCE="${SOURCE:-}"
SERVER_IP="${SERVER_IP:-}"

NONINTERACTIVE=no
ACTION=install                  # install | update | uninstall
STEP_N=0
STEP_TOTAL=9
PUBLIC_IP4=""
PUBLIC_IP6=""
BEHIND_NAT=no
PRIVATE_IP4=""
TMP_DIR=""
NEW_RELEASE=""
PREV_RELEASE=""
CERT_END=""
ADMIN_PASSWORD_GENERATED=no

# ------------------------------------------------------------------ вывод

if [ -t 1 ]; then
  C_OFF=$'\033[0m'; C_B=$'\033[1m'; C_DIM=$'\033[2m'
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_BLU=$'\033[34m'; C_CYN=$'\033[36m'
else
  C_OFF=""; C_B=""; C_DIM=""; C_RED=""; C_GRN=""; C_YEL=""; C_BLU=""; C_CYN=""
fi

say()  { printf '%s\n' "$*"; }
info() { printf '%s•%s %s\n' "$C_BLU" "$C_OFF" "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GRN" "$C_OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YEL" "$C_OFF" "$*"; }
bad()  { printf '%s✗%s %s\n' "$C_RED" "$C_OFF" "$*"; }
die()  { bad "$*"; say "  Полный журнал: ${WS_LOG:-—}"; exit 1; }
step() {
  STEP_N=$((STEP_N + 1))
  printf '\n%s%s[%d/%d] %s%s\n' "$C_B" "$C_CYN" "$STEP_N" "$STEP_TOTAL" "$*" "$C_OFF"
}
hr() { printf '%s\n' "────────────────────────────────────────────────────────────"; }

# Ввод — всегда с терминала (работает и при `curl … | bash`), в журнал
# попадает только сам вопрос и несекретный ответ.
HAVE_TTY=no
if [ -r /dev/tty ] && [ -w /dev/tty ] && { : < /dev/tty; } 2>/dev/null; then HAVE_TTY=yes; fi

tty_print() { if [ "$HAVE_TTY" = yes ]; then printf '%s' "$*" > /dev/tty; else printf '%s' "$*" >&2; fi; }
tty_read() {  # tty_read VAR [silent]
  local __v=""
  if [ "$HAVE_TTY" = yes ]; then
    if [ "${2:-}" = silent ]; then IFS= read -r -s __v < /dev/tty || true; printf '\n' > /dev/tty
    else IFS= read -r __v < /dev/tty || true; fi
  else
    IFS= read -r __v || true
  fi
  printf -v "$1" '%s' "$__v"
}

need_answer() {
  die "Нет ответа на вопрос «$1». В режиме --non-interactive задайте $2 в файле ответов (--answers)."
}

# ask VAR "Вопрос" "значение по умолчанию" [функция-проверка] [текст ошибки]
ask() {
  local __var=$1 __q=$2 __def=${3:-} __check=${4:-} __err=${5:-"Неверное значение"} __ans=""
  local __cur
  eval "__cur=\${$__var:-}"
  [ -n "$__cur" ] && __def=$__cur
  if [ "$NONINTERACTIVE" = yes ]; then
    [ -n "$__def" ] || need_answer "$__q" "$__var"
    if [ -n "$__check" ] && ! "$__check" "$__def"; then die "$__var=$__def: $__err"; fi
    printf -v "$__var" '%s' "$__def"; info "$__q: $__def"; return 0
  fi
  while :; do
    if [ -n "$__def" ]; then tty_print "${C_B}? ${__q}${C_OFF} [${__def}]: "; else tty_print "${C_B}? ${__q}${C_OFF}: "; fi
    tty_read __ans
    [ -z "$__ans" ] && __ans=$__def
    if [ -z "$__ans" ]; then warn "Нужен ответ"; continue; fi
    if [ -n "$__check" ] && ! "$__check" "$__ans"; then warn "$__err"; continue; fi
    break
  done
  printf -v "$__var" '%s' "$__ans"
  printf '  %s → %s\n' "$__q" "$__ans" >> "${WS_LOG:-/dev/null}" 2>/dev/null || true
}

# ask_yn VAR "Вопрос" y|n  → VAR=yes|no
ask_yn() {
  local __var=$1 __q=$2 __def=${3:-y} __ans="" __cur
  eval "__cur=\${$__var:-}"
  case "$__cur" in yes) __def=y ;; no) __def=n ;; esac
  if [ "$NONINTERACTIVE" = yes ]; then
    if [ "$__def" = y ]; then printf -v "$__var" yes; else printf -v "$__var" no; fi
    info "$__q: $( [ "$__def" = y ] && echo да || echo нет )"; return 0
  fi
  while :; do
    if [ "$__def" = y ]; then tty_print "${C_B}? ${__q}${C_OFF} [Д/н]: "; else tty_print "${C_B}? ${__q}${C_OFF} [д/Н]: "; fi
    tty_read __ans
    case "$__ans" in
      "") __ans=$__def ;;
      y|Y|yes|Yes|YES|д|Д|да|Да|ДА) __ans=y ;;
      n|N|no|No|NO|н|Н|нет|Нет|НЕТ) __ans=n ;;
      *) warn "Ответьте «да» или «нет»"; continue ;;
    esac
    break
  done
  if [ "$__ans" = y ]; then printf -v "$__var" yes; else printf -v "$__var" no; fi
}

# confirm_yes "Что сделать" — ждёт, пока человек напишет yes (или «нет» — выход).
confirm_yes() {
  local __ans=""
  if [ "$NONINTERACTIVE" = yes ]; then info "$1 — подтверждено файлом ответов"; return 0; fi
  while :; do
    tty_print "${C_B}${C_YEL}» $1${C_OFF}
  Когда будет готово, напишите ${C_B}yes${C_OFF} (или ${C_B}no${C_OFF} — прервать установку): "
    tty_read __ans
    case "$__ans" in
      yes|YES|Yes|да|Да|ДА) return 0 ;;
      no|NO|No|нет|Нет) die "Установка прервана по вашему ответу. Запустите скрипт снова, когда будете готовы — уже сделанное повторно не делается." ;;
      *) warn "Напишите yes, когда шаг выполнен" ;;
    esac
  done
}

ask_password() {
  local p1="" p2=""
  if [ -n "$ADMIN_PASSWORD" ]; then return 0; fi
  if [ "$NONINTERACTIVE" = yes ]; then ADMIN_PASSWORD=$(gen_password); ADMIN_PASSWORD_GENERATED=yes; return 0; fi
  while :; do
    tty_print "${C_B}? Пароль администратора${C_OFF} (Enter — сгенерировать надёжный): "
    tty_read p1 silent
    if [ -z "$p1" ]; then ADMIN_PASSWORD=$(gen_password); ADMIN_PASSWORD_GENERATED=yes; ok "Пароль сгенерирован — покажу его в конце установки"; return 0; fi
    if [ "${#p1}" -lt 10 ]; then warn "Не короче 10 символов"; continue; fi
    case "$p1" in *"'"*) warn "Без символа ' (апостроф) — он ломает файл настроек"; continue ;; esac
    tty_print "${C_B}? Повторите пароль${C_OFF}: "
    tty_read p2 silent
    if [ "$p1" != "$p2" ]; then warn "Пароли не совпадают"; continue; fi
    ADMIN_PASSWORD=$p1; return 0
  done
}

# ------------------------------------------------------------------ проверки значений

valid_domain() { printf '%s' "$1" | grep -Eq '^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z][A-Za-z0-9-]{1,62}$'; }
valid_email()  { printf '%s' "$1" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; }
valid_name()   { [ -n "$1" ] && [ "${#1}" -le 60 ] && case "$1" in *'"'*|*'\'*) false ;; *) true ;; esac; }
valid_port()   { printf '%s' "$1" | grep -Eq '^[0-9]{1,5}$' && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
valid_ports()  { [ -z "$1" ] && return 0; printf '%s' "$1" | grep -Eq '^[0-9]{1,5}(-[0-9]{1,5})?(/(tcp|udp))?( *, *[0-9]{1,5}(-[0-9]{1,5})?(/(tcp|udp))?)*$'; }
valid_ipv4()   { printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; }
valid_range()  {
  printf '%s' "$1" | grep -Eq '^[0-9]{4,5}-[0-9]{4,5}$' || return 1
  local a=${1%-*} b=${1#*-}
  [ "$a" -ge 1024 ] && [ "$b" -le 65535 ] && [ $((b - a)) -ge 50 ]
}
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

gen_secret()   { openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | cut -c1-48; }
gen_password() { openssl rand -base64 32 | tr -dc 'A-Za-z0-9' | cut -c1-18; }

# ------------------------------------------------------------------ аргументы

ws_usage() {
  cat <<EOF
Установка Workspace — версия установщика $WS_INSTALLER_VERSION

  sudo bash deploy/install/install.sh [параметры]

Параметры:
  --source ПУТЬ|URL    код: папка проекта, zip-архив версии или git-адрес
                       (по умолчанию — проект, в котором лежит этот скрипт)
  --prefix ПАПКА       куда ставить (по умолчанию $WS_PREFIX)
  --user ИМЯ           системный пользователь служб (по умолчанию $WS_USER)
  --answers ФАЙЛ       готовые ответы (формат KEY=value, см. answers.example.conf)
  --non-interactive    ничего не спрашивать: ответы — из --answers
  --uninstall          удалить установку (данные — только с отдельным подтверждением)
  -h, --help           эта справка

Повторный запуск на сервере, где Workspace уже стоит, обновляет его:
новая версия собирается рядом, при ошибке — откат на прежнюю.
EOF
}

load_answers() {
  local file=$1 line key val
  [ -r "$file" ] || die "Файл ответов не найден: $file"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    key=${line%%=*}; val=${line#*=}
    val=${val%\"}; val=${val#\"}; val=${val%\'}; val=${val#\'}
    case "$key" in
      MODE|DOMAIN|LE_EMAIL|ADMIN_EMAIL|ADMIN_NAME|ADMIN_PASSWORD|CALLS|TURN_MIN_PORT|TURN_MAX_PORT|TURN_PORT|TURN_TLS_PORT|FIREWALL|SSH_PORTS|EXTRA_PORTS|SOURCE|SERVER_IP|NODE_MAJOR|WS_USER|WS_PREFIX)
        printf -v "$key" '%s' "$val" ;;
      *) warn "Неизвестный ключ в файле ответов: $key — пропускаю" ;;
    esac
  done < "$file"
}

ws_parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --source) SOURCE=$2; shift 2 ;;
      --prefix) WS_PREFIX=$2; shift 2 ;;
      --user) WS_USER=$2; shift 2 ;;
      --answers) load_answers "$2"; shift 2 ;;
      --non-interactive|--yes) NONINTERACTIVE=yes; shift ;;
      --uninstall) ACTION=uninstall; shift ;;
      -h|--help) ws_usage; exit 0 ;;
      *) ws_usage; die "Неизвестный параметр: $1" ;;
    esac
  done
  printf '%s' "$WS_USER" | grep -Eq '^[a-z_][a-z0-9_-]{0,30}$' || die "Имя пользователя «$WS_USER» не подходит: только строчные латинские буквы, цифры, _ и -"
  case "$WS_PREFIX" in /*) ;; *) die "--prefix должен быть абсолютным путём" ;; esac
  WS_RELEASES="$WS_PREFIX/releases"
  WS_APP="$WS_PREFIX/app"
  WS_CONFIG="$WS_PREFIX/config"
  WS_STORAGE="$WS_PREFIX/storage"
  WS_BACKUPS="$WS_PREFIX/backups"
  WS_STATE="$WS_PREFIX/install.conf"
  WS_LOG="$WS_PREFIX/install.log"
  if [ "$HAVE_TTY" = no ] && [ "$NONINTERACTIVE" = no ]; then
    die "Нет терминала для вопросов. Запустите в обычной SSH-сессии или передайте --answers ФАЙЛ --non-interactive."
  fi
}

# Журнал: всё, что выводит скрипт, дублируется в install.log.
start_log() {
  mkdir -p "$WS_PREFIX"
  touch "$WS_LOG"; chmod 600 "$WS_LOG"
  exec > >(tee -a "$WS_LOG") 2>&1
  printf '\n===== %s — установщик %s, действие: %s =====\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$WS_INSTALLER_VERSION" "$ACTION" >> "$WS_LOG"
}

on_error() {
  local code=$? line=${1:-?}
  bad "Ошибка (код $code) в строке $line: ${BASH_COMMAND:-}"
  say "  Журнал установки: $WS_LOG"
  say "  Исправьте причину и запустите скрипт снова — готовые шаги пропускаются."
  exit "$code"
}

cleanup() { [ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR"; return 0; }

# ------------------------------------------------------------------ сеть

detect_public_ips() {
  PUBLIC_IP4=$(curl -4 -fsS --max-time 8 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 8 https://ifconfig.me 2>/dev/null || curl -4 -fsS --max-time 8 https://icanhazip.com 2>/dev/null || true)
  PUBLIC_IP4=$(printf '%s' "$PUBLIC_IP4" | tr -d '[:space:]')
  valid_ipv4 "$PUBLIC_IP4" || PUBLIC_IP4=""
  PUBLIC_IP6=$(curl -6 -fsS --max-time 6 https://api64.ipify.org 2>/dev/null || true)
  PUBLIC_IP6=$(printf '%s' "$PUBLIC_IP6" | tr -d '[:space:]')
  case "$PUBLIC_IP6" in *:*) ;; *) PUBLIC_IP6="" ;; esac
  local locals
  locals=$(os_local_ipv4s || true)
  PRIVATE_IP4=$(printf '%s\n' "$locals" | head -n1)
  BEHIND_NAT=no
  if [ -n "$PUBLIC_IP4" ] && ! printf '%s\n' "$locals" | grep -qx "$PUBLIC_IP4"; then BEHIND_NAT=yes; fi
}

dns_a()    { dig +short +time=3 +tries=2 ${2:+@"$2"} A "$1" 2>/dev/null | grep -E '^[0-9.]+$' | sort -u || true; }
dns_aaaa() { dig +short +time=3 +tries=2 ${2:+@"$2"} AAAA "$1" 2>/dev/null | grep ':' | sort -u || true; }

# CAA: Let's Encrypt откажет, если у домена (или родительского) есть CAA без letsencrypt.org.
check_caa() {
  local d=$1 recs
  while printf '%s' "$d" | grep -q '\.'; do
    recs=$(dig +short +time=3 +tries=2 @1.1.1.1 CAA "$d" 2>/dev/null | grep -i 'issue' || true)
    if [ -n "$recs" ]; then
      if printf '%s\n' "$recs" | grep -qi 'letsencrypt.org'; then ok "CAA-запись для $d разрешает Let's Encrypt"; return 0; fi
      bad "У $d есть CAA-запись, которая не разрешает Let's Encrypt:"
      printf '    %s\n' "$recs"
      say "    Добавьте CAA-запись: $d. CAA 0 issue \"letsencrypt.org\" — или удалите ограничение."
      return 1
    fi
    d=${d#*.}
  done
  ok "CAA-ограничений нет"
  return 0
}

# Проверка DNS до выпуска сертификата: A → IP сервера (через 1.1.1.1 и 8.8.8.8),
# AAAA — либо нет, либо указывает на этот сервер, CAA не мешает.
verify_dns() {
  local a1 a2 aaaa problems
  command -v dig >/dev/null 2>&1 || die "Нет утилиты dig для проверки DNS (пакет dnsutils / bind-utils)."
  while :; do
    problems=0
    a1=$(dns_a "$DOMAIN" 1.1.1.1); a2=$(dns_a "$DOMAIN" 8.8.8.8)
    if [ -z "$a1" ] && [ -z "$a2" ] && ! dig +time=3 +tries=1 @1.1.1.1 . NS >/dev/null 2>&1; then
      warn "Публичные DNS (1.1.1.1, 8.8.8.8) недоступны с сервера — проверяю через системный DNS."
      a1=$(dns_a "$DOMAIN"); a2=$a1
    fi
    if printf '%s\n' "$a1" | grep -qx "$SERVER_IP" && printf '%s\n' "$a2" | grep -qx "$SERVER_IP"; then
      ok "A-запись $DOMAIN → $SERVER_IP (видна в Cloudflare 1.1.1.1 и Google 8.8.8.8)"
      local extra
      extra=$(printf '%s\n%s\n' "$a1" "$a2" | grep -v "^$SERVER_IP\$" | grep -v '^$' | sort -u || true)
      if [ -n "$extra" ]; then
        warn "У домена есть и другие A-записи: $(printf '%s ' $extra)— Let's Encrypt может пойти на них. Оставьте только $SERVER_IP."
        problems=1
      fi
    else
      bad "A-запись $DOMAIN пока не указывает на $SERVER_IP"
      say "    1.1.1.1 видит: ${a1:-нет записи}"
      say "    8.8.8.8 видит: ${a2:-нет записи}"
      say "    Новая запись обычно появляется за 1–15 минут (зависит от TTL у регистратора)."
      problems=1
    fi
    aaaa=$(dns_aaaa "$DOMAIN" 1.1.1.1)
    if [ -n "$aaaa" ]; then
      if [ -n "$PUBLIC_IP6" ] && printf '%s\n' "$aaaa" | grep -qix "$PUBLIC_IP6"; then
        ok "AAAA-запись указывает на IPv6 этого сервера ($PUBLIC_IP6) — порты 80/443 откроем и для IPv6"
      else
        bad "У домена есть AAAA-запись ($(printf '%s ' $aaaa)), но это не IPv6 этого сервера (${PUBLIC_IP6:-у сервера нет внешнего IPv6})."
        say "    Let's Encrypt предпочитает IPv6 и не выпустит сертификат. Удалите AAAA-запись или направьте её на сервер."
        problems=1
      fi
    fi
    check_caa "$DOMAIN" || problems=1
    [ "$problems" -eq 0 ] && return 0
    if [ "$NONINTERACTIVE" = yes ]; then die "DNS настроен не так, как нужно (см. выше)."; fi
    local again=""
    tty_print "${C_B}? Исправьте DNS и нажмите Enter для повторной проверки (q — прервать): ${C_OFF}"
    tty_read again
    [ "$again" = q ] && die "Прервано: DNS не готов. Запустите скрипт снова, когда запись обновится."
    info "Проверяю снова…"
  done
}

port_list_nft() { printf '%s' "$1" | tr -d ' ' | tr ',' '\n' | grep -v '^$' || true; }

# ------------------------------------------------------------------ проверки системы

check_internet() {
  local url failed=0
  for url in https://registry.npmjs.org/ "https://fonts.googleapis.com/css2?family=Inter" "$@"; do
    if curl -fsS -o /dev/null --max-time 15 "$url"; then ok "Доступ: $url"; else bad "Нет доступа: $url"; failed=1; fi
  done
  [ "$failed" -eq 0 ] || die "Серверу нужен исходящий HTTPS к адресам выше (пакеты npm, шрифты для сборки, Let's Encrypt). Проверьте прокси/файрвол провайдера."
}

check_resources() {
  local mem_mb swap_mb free_gb
  mem_mb=$(os_mem_mb); swap_mb=$(os_swap_mb)
  free_gb=$(os_free_gb "$WS_PREFIX")
  info "Память: ${mem_mb} МБ, swap: ${swap_mb} МБ, свободно на диске: ${free_gb} ГБ"
  [ "$free_gb" -ge 5 ] || die "Нужно минимум 5 ГБ свободного места для $WS_PREFIX (сейчас ${free_gb} ГБ)."
  if [ $((mem_mb + swap_mb)) -lt 2600 ]; then
    warn "Для сборки нужно около 2,5 ГБ памяти (ОЗУ + swap), сейчас $((mem_mb + swap_mb)) МБ."
    local mkswap=yes
    ask_yn mkswap "Создать файл подкачки 2 ГБ?" y
    if [ "$mkswap" = yes ]; then os_make_swap 2048; else die "Без дополнительной памяти сборка, скорее всего, упадёт. Добавьте ОЗУ или swap и запустите снова."; fi
  else
    ok "Памяти достаточно"
  fi
}

# Порты: свободны или заняты «нашими» (при обновлении).
check_ports() {
  local p owner busy=0 list="80 443 $API_PORT $WEB_PORT"
  [ "$CALLS" = yes ] && list="$list $TURN_PORT"
  [ "$CALLS" = yes ] && [ "$MODE" = domain ] && list="$list $TURN_TLS_PORT"
  for p in $list; do
    owner=$(os_port_owner "$p" || true)
    if [ -z "$owner" ]; then ok "Порт $p свободен"; continue; fi
    case "$owner" in
      *nginx*|*node*|*turnserv*|*next-serv*) ok "Порт $p занят $owner — это компонент Workspace, будет перенастроен" ;;
      *lighttpd*|*apache2*|*httpd*|*caddy*)
        warn "Порт $p занят веб-сервером $owner."
        local stopit=yes
        ask_yn stopit "Остановить и отключить $owner? (иначе nginx не сможет занять порт)" y
        if [ "$stopit" = yes ]; then os_stop_service_owning "$owner"; ok "$owner остановлен"; else busy=1; fi ;;
      *) bad "Порт $p занят: $owner"; busy=1 ;;
    esac
  done
  [ "$busy" -eq 0 ] || die "Освободите порты выше (или остановите программы, которые их держат) и запустите снова."
}

check_time() {
  if os_time_synced; then ok "Время синхронизировано"; else
    warn "Часы не синхронизированы — сертификаты и вход могут не работать. Пробую включить синхронизацию…"
    os_enable_time_sync || true
    sleep 3
    if os_time_synced; then ok "Синхронизация времени включена"; else warn "Не удалось проверить синхронизацию времени — проверьте вручную (timedatectl)."; fi
  fi
}

# ------------------------------------------------------------------ исходники

find_project_root() {  # папка с package.json и apps/server внутри $1 (до 2 уровней)
  local d
  for d in "$1" "$1"/* "$1"/*/*; do
    [ -f "$d/package.json" ] && [ -d "$d/apps/server" ] && [ -d "$d/apps/web" ] && { printf '%s' "$d"; return 0; }
  done
  return 1
}

resolve_source() {
  local script_root
  script_root=$(cd "$WS_SCRIPT_DIR/../.." && pwd)
  if [ -z "$SOURCE" ]; then
    if [ -f "$script_root/package.json" ] && [ -d "$script_root/apps/server" ]; then SOURCE=$script_root; else
      ask SOURCE "Где взять код Workspace (папка, zip-архив или git-адрес)" "" ""
    fi
  fi
  TMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/ws-install.XXXXXX")
  case "$SOURCE" in
    *.zip)
      [ -f "$SOURCE" ] || die "Архив не найден: $SOURCE"
      info "Распаковываю $SOURCE"
      unzip -q "$SOURCE" -d "$TMP_DIR/src" || die "Не удалось распаковать $SOURCE"
      SRC_ROOT=$(find_project_root "$TMP_DIR/src") || die "В архиве нет проекта Workspace (package.json + apps/server + apps/web)" ;;
    http://*|https://*|git@*|ssh://*)
      command -v git >/dev/null 2>&1 || die "Нужен git для загрузки из $SOURCE"
      local ref=""
      ask ref "Ветка или тег (Enter — основная ветка)" "-" ""
      [ "$ref" = "-" ] && ref=""
      info "Загружаю $SOURCE ${ref:+($ref)}"
      git clone --depth 1 ${ref:+--branch "$ref"} "$SOURCE" "$TMP_DIR/src" || die "Не удалось загрузить код из $SOURCE"
      SRC_ROOT="$TMP_DIR/src" ;;
    *)
      [ -d "$SOURCE" ] || die "Папка не найдена: $SOURCE"
      SRC_ROOT=$(find_project_root "$SOURCE") || die "В $SOURCE нет проекта Workspace (package.json + apps/server + apps/web)" ;;
  esac
  SRC_VERSION=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$SRC_ROOT/package.json" | head -n1)
  [ -n "$SRC_VERSION" ] || SRC_VERSION=unknown
  ok "Код Workspace $SRC_VERSION: $SRC_ROOT"
}

# ------------------------------------------------------------------ вопросы

ask_questions() {
  hr
  say "${C_B}Несколько вопросов.${C_OFF} В скобках — значение по умолчанию (Enter)."
  hr
  detect_public_ips
  if [ -n "$PUBLIC_IP4" ]; then
    info "Внешний IPv4 сервера: $PUBLIC_IP4${PUBLIC_IP6:+, IPv6: $PUBLIC_IP6}"
    [ "$BEHIND_NAT" = yes ] && info "Сервер за NAT (адрес на интерфейсе: ${PRIVATE_IP4:-?}) — учту это для видеозвонков"
  else
    warn "Не удалось определить внешний IP автоматически"
  fi

  say ""
  say "Как будет открываться Workspace?"
  say "  1) По домену с настоящим HTTPS-сертификатом Let's Encrypt (для работы — рекомендуется)"
  say "  2) По IP-адресу с самоподписанным сертификатом (для проверки: браузер один раз предупредит)"
  local m=""
  case "$MODE" in domain) m=1 ;; ip) m=2 ;; esac
  ask m "Вариант" "${m:-1}" valid_mode "Введите 1 или 2"
  if [ "$m" = 1 ]; then MODE=domain; else MODE=ip; fi

  ask SERVER_IP "Внешний IP-адрес сервера" "${PUBLIC_IP4:-}" valid_ipv4 "Нужен IPv4-адрес вида 203.0.113.10"

  if [ "$MODE" = domain ]; then
    ask DOMAIN "Домен (например, workspace.company.ru)" "" valid_domain "Нужно доменное имя вида workspace.company.ru"
    DOMAIN=$(lower "$DOMAIN")
    ask LE_EMAIL "Email для Let's Encrypt (уведомления о сертификате)" "" valid_email "Нужен email вида name@company.ru"
    say ""
    say "  ${C_B}DNS:${C_OFF} у регистратора домена добавьте запись"
    say "      ${C_B}$DOMAIN.   A   $SERVER_IP${C_OFF}"
    say "  Если есть AAAA-запись для $DOMAIN — удалите её (или направьте на IPv6 этого сервера)."
    confirm_yes "A-запись $DOMAIN → $SERVER_IP добавлена"
    verify_dns
  fi

  say ""
  ask ADMIN_EMAIL "Email администратора (логин для входа)" "" valid_email "Нужен email вида name@company.ru"
  ask ADMIN_NAME "Имя администратора" "Администратор" valid_name "1–60 символов, без двойных кавычек и обратной косой черты"
  if [ "$ACTION" = install ] && [ ! -f "$WS_STORAGE/auth/credentials.json" ]; then ask_password; fi

  say ""
  ask_yn CALLS "Включить видеозвонки через свой TURN-сервер (coturn)?" y
  if [ "$CALLS" = yes ]; then
    local range="$TURN_MIN_PORT-$TURN_MAX_PORT"
    ask range "Диапазон UDP-портов для медиа звонков" "$range" valid_range "Формат 49152-49452, от 1024, не меньше 50 портов"
    TURN_MIN_PORT=${range%-*}; TURN_MAX_PORT=${range#*-}
  fi

  ask_firewall

  say ""
  say "  ${C_B}Файрвол провайдера / облака${C_OFF} (security group, панель хостинга) — скрипт его не видит."
  say "  Входящие должны быть открыты:"
  say "      TCP 80, 443 — сайт и выпуск сертификата"
  [ "$CALLS" = yes ] && say "      TCP/UDP $TURN_PORT, TCP $TURN_TLS_PORT, UDP $TURN_MIN_PORT-$TURN_MAX_PORT — видеозвонки"
  say "      TCP $(printf '%s' "$SSH_PORTS" | tr ',' ' ') — SSH (чтобы не потерять доступ)"
  [ "$BEHIND_NAT" = yes ] && say "  Сервер за NAT: на роутере/шлюзе пробросьте эти же порты на ${PRIVATE_IP4:-этот сервер}."
  confirm_yes "Порты открыты в файрволе провайдера (или его нет)"

  say ""
  hr
  say "${C_B}Итого:${C_OFF}"
  if [ "$MODE" = domain ]; then say "  Адрес:          https://$DOMAIN"; else say "  Адрес:          https://$SERVER_IP (самоподписанный сертификат)"; fi
  say "  Папка:          $WS_PREFIX (данные — $WS_STORAGE)"
  say "  Пользователь:   $WS_USER"
  say "  Администратор:  $ADMIN_NAME <$ADMIN_EMAIL>"
  if [ "$CALLS" = yes ]; then say "  Звонки:         да, TURN $TURN_PORT, медиа UDP $TURN_MIN_PORT-$TURN_MAX_PORT"; else say "  Звонки:         без TURN (только внутри одной сети)"; fi
  say "  Файрвол:        $(firewall_label)"
  hr
  confirm_yes "Начать установку с этими настройками"
}

valid_mode() { [ "$1" = 1 ] || [ "$1" = 2 ]; }

firewall_label() {
  case "$FIREWALL" in
    nft-new) echo "nftables (полная настройка, остальные файрволы отключаются)" ;;
    nft-add) echo "nftables (своя таблица рядом с существующими правилами)" ;;
    existing) echo "добавить правила в действующий файрвол" ;;
    macos) echo "файрвол macOS (pf-якорь workspace + брандмауэр приложений)" ;;
    none) echo "не настраивать" ;;
  esac
}

# ------------------------------------------------------------------ конфигурация

# Сохраняем ответы (без пароля) — для обновлений и повторной установки.
save_state() {
  umask 077
  cat > "$WS_STATE" <<EOF
# Ответы установщика Workspace ($(date '+%Y-%m-%d %H:%M')). Без паролей.
# Можно передать в --answers для установки ещё одного сервера.
MODE=$MODE
DOMAIN=$DOMAIN
LE_EMAIL=$LE_EMAIL
SERVER_IP=$SERVER_IP
ADMIN_EMAIL=$ADMIN_EMAIL
ADMIN_NAME=$ADMIN_NAME
CALLS=$CALLS
TURN_PORT=$TURN_PORT
TURN_TLS_PORT=$TURN_TLS_PORT
TURN_MIN_PORT=$TURN_MIN_PORT
TURN_MAX_PORT=$TURN_MAX_PORT
FIREWALL=$FIREWALL
SSH_PORTS=$SSH_PORTS
EXTRA_PORTS=$EXTRA_PORTS
EOF
  umask 022
}

env_get() { [ -f "$1" ] && sed -n "s/^$2=//p" "$1" | tail -n1 || true; }

site_origin() { if [ "$MODE" = domain ]; then printf 'https://%s' "$DOMAIN"; else printf 'https://%s' "$SERVER_IP"; fi; }

# config/server.env и config/web.env: секреты сохраняются при обновлении.
write_env() {
  mkdir -p "$WS_CONFIG"
  local f="$WS_CONFIG/server.env" w="$WS_CONFIG/web.env" access refresh turn_secret
  access=$(env_get "$f" ACCESS_TOKEN_SECRET); [ -n "$access" ] || access=$(gen_secret)
  refresh=$(env_get "$f" REFRESH_TOKEN_SECRET); [ -n "$refresh" ] || refresh=$(gen_secret)
  turn_secret=$(env_get "$f" TURN_SECRET); [ -n "$turn_secret" ] || turn_secret=$(gen_secret)
  TURN_SECRET_VALUE=$turn_secret
  local turn_host="" admin_pw_line="ADMIN_PASSWORD="
  [ "$CALLS" = yes ] && { if [ "$MODE" = domain ]; then turn_host=$DOMAIN; else turn_host=$SERVER_IP; fi; }
  # Пароль администратора нужен только при самом первом запуске (хранилище пусто).
  # В одинарных кавычках: dotenv иначе обрежет значение на # и пробелах.
  [ -n "$ADMIN_PASSWORD" ] && [ ! -f "$WS_STORAGE/auth/credentials.json" ] && admin_pw_line="ADMIN_PASSWORD='$ADMIN_PASSWORD'"
  # Ключи GIF и прочие ручные настройки из прежнего файла переносим как есть.
  local keep=""
  [ -f "$f" ] && keep=$(grep -E '^(KLIPY_API_KEY|GIPHY_API_KEY|CHAT_ALLOWED_MIME_TYPES|TILE_SHEET_COLS|TILE_SHEET_ROWS|TILE_SIZE)=' "$f" || true)
  umask 027
  cat > "$f.new" <<EOF
# Создано установщиком Workspace. Ручные правки ключей GIF, типов файлов
# чата и тайлов сохраняются при обновлении; остальное перезаписывается.
PORT=$API_PORT
BIND_HOST=127.0.0.1
WEB_ORIGIN=$(site_origin)
STORAGE_ROOT=$WS_STORAGE
ACCESS_TOKEN_SECRET=$access
REFRESH_TOKEN_SECRET=$refresh
ADMIN_EMAIL=$ADMIN_EMAIL
$admin_pw_line
ADMIN_DISPLAY_NAME="$ADMIN_NAME"
TURN_HOST=$turn_host
TURN_PORT=$TURN_PORT
TURN_TLS_PORT=$( [ "$MODE" = domain ] && [ "$CALLS" = yes ] && printf '%s' "$TURN_TLS_PORT" )
TURN_SECRET=$( [ "$CALLS" = yes ] && printf '%s' "$turn_secret" )
TURN_CREDENTIAL_TTL_SECONDS=3600
${keep}
EOF
  local keepw=""
  [ -f "$w" ] && keepw=$(grep -E '^NEXT_PUBLIC_(LOGIN_LOGO_HEIGHT|HEADER_LOGO_HEIGHT|EDITOR_WIDTH_CHARS)=' "$w" || true)
  cat > "$w.new" <<EOF
# Создано установщиком Workspace.
PORT=$WEB_PORT
BIND_HOST=127.0.0.1
NEXT_PUBLIC_API_URL=$(site_origin)
${keepw}
EOF
  umask 022
  mv -f "$f.new" "$f"; mv -f "$w.new" "$w"
  chown -R "root:$(ws_group)" "$WS_CONFIG"
  chmod 750 "$WS_CONFIG"; chmod 640 "$f" "$w"
  ok "Настройки: $f, $w (секреты сохранены)"
}

# После первого запуска пароль администратора из файла убираем.
scrub_admin_password() {
  local f="$WS_CONFIG/server.env"
  if grep -q '^ADMIN_PASSWORD=.' "$f" 2>/dev/null; then
    sed -i.bak 's/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=/' "$f" && rm -f "$f.bak"
    ok "Пароль администратора убран из $f (он нужен был только для первого запуска)"
  fi
}

ws_group() { id -gn "$WS_USER" 2>/dev/null || printf '%s' "$WS_USER"; }

# Переменные прокси и корневых сертификатов для сборки от имени $WS_USER
# (значения без пробелов — URL и пути).
proxy_env() {
  local v
  for v in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy NODE_EXTRA_CA_CERTS npm_config_https_proxy npm_config_proxy npm_config_noproxy; do
    eval "[ -n \"\${$v:-}\" ] && printf '%s=%s ' \"$v\" \"\${$v}\""  || true
  done
  return 0
}

# ------------------------------------------------------------------ сборка и выпуск

build_release() {
  local stamp rel
  stamp=$(date +%Y%m%d-%H%M%S)
  rel="$WS_RELEASES/$SRC_VERSION-$stamp"
  mkdir -p "$rel"
  info "Копирую код в $rel"
  ( cd "$SRC_ROOT" && tar --exclude='./.git' --exclude='node_modules' --exclude='.next' --exclude='.turbo' \
      --exclude='./apps/server/storage' --exclude='./apps/server/.env' --exclude='./apps/web/.env.local' \
      --exclude='./apps/server/dist' -cf - . ) | ( cd "$rel" && tar -xf - )
  ln -sfn "$WS_CONFIG/server.env" "$rel/apps/server/.env"
  ln -sfn "$WS_CONFIG/web.env" "$rel/apps/web/.env.local"
  chown -R "$WS_USER:$(ws_group)" "$rel"
  info "Устанавливаю зависимости (npm ci) — 2–5 минут"
  as_ws "$rel" npm ci --no-audit --no-fund --loglevel=error || die "npm ci завершился с ошибкой (см. журнал)."
  info "Собираю (npm run build) — 3–10 минут"
  as_ws "$rel" npm run build || die "Сборка не удалась — текущая версия продолжает работать. Подробности в журнале."
  [ -f "$rel/apps/server/dist/index.js" ] || die "Сборка не создала apps/server/dist/index.js"
  [ -f "$rel/apps/web/.next/BUILD_ID" ] || die "Сборка не создала apps/web/.next"
  rm -rf "$rel/.turbo/cache" 2>/dev/null || true
  NEW_RELEASE=$rel
  ok "Версия $SRC_VERSION собрана"
}

# Атомарно перенаправить ссылку app на другую версию.
swap_link() {
  ln -sfn "$1" "$2.tmp"
  if mv --version >/dev/null 2>&1; then mv -fT "$2.tmp" "$2"; else mv -fh "$2.tmp" "$2"; fi
}

activate_release() {
  PREV_RELEASE=""
  [ -L "$WS_APP" ] && PREV_RELEASE=$(readlink "$WS_APP")
  swap_link "$NEW_RELEASE" "$WS_APP"
  os_restart_app
  if wait_app_healthy; then
    ok "Новая версия работает"
    prune_releases
  else
    if [ -n "$PREV_RELEASE" ] && [ -d "$PREV_RELEASE" ]; then
      bad "Новая версия не отвечает — возвращаю прежнюю ($PREV_RELEASE)"
      swap_link "$PREV_RELEASE" "$WS_APP"
      os_restart_app
      wait_app_healthy || true
      die "Обновление откатено. Посмотрите логи служб: $(os_logs_hint)"
    fi
    die "Приложение не запустилось. Логи: $(os_logs_hint)"
  fi
}

wait_app_healthy() {
  local i
  for i in $(seq 1 60); do
    if curl -fsS --max-time 3 "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then break; fi
    sleep 2
  done
  curl -fsS --max-time 3 "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 || { bad "API (порт $API_PORT) не отвечает"; return 1; }
  for i in $(seq 1 60); do
    if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:$WEB_PORT/"; then return 0; fi
    sleep 2
  done
  bad "Веб-приложение (порт $WEB_PORT) не отвечает"
  return 1
}

prune_releases() {
  local keep=3 n=0 r current
  current=$(readlink "$WS_APP" || true)
  for r in $(ls -1dt "$WS_RELEASES"/*/ 2>/dev/null); do
    r=${r%/}
    n=$((n + 1))
    [ "$n" -le "$keep" ] && continue
    [ "$r" = "$current" ] && continue
    rm -rf "$r" && info "Удалена старая версия $(basename "$r")"
  done
}

backup_storage() {
  [ -d "$WS_STORAGE" ] || return 0
  local size_mb dobackup=yes
  size_mb=$(du -sm "$WS_STORAGE" 2>/dev/null | awk '{print $1}')
  ask_yn dobackup "Сделать резервную копию данных ($size_mb МБ) перед обновлением?" y
  [ "$dobackup" = yes ] || return 0
  mkdir -p "$WS_BACKUPS"; chmod 700 "$WS_BACKUPS"
  local file="$WS_BACKUPS/storage-$(date +%Y%m%d-%H%M%S).tar.gz"
  tar -czf "$file" -C "$WS_PREFIX" storage config
  ok "Резервная копия: $file"
}

# ------------------------------------------------------------------ nginx и сертификаты

nginx_listen() {  # nginx_listen 80 [ssl] → строки listen с IPv6, если он есть
  local opts=${2:-}
  printf '    listen %s%s;\n' "$1" "${opts:+ $opts}"
  if os_has_ipv6; then printf '    listen [::]:%s%s;\n' "$1" "${opts:+ $opts}"; fi
}

nginx_proxy_block() {
  cat <<EOF
    client_max_body_size 30m;
    server_tokens off;
    gzip on;
    gzip_types text/plain text/css application/json application/javascript image/svg+xml;

    location = /health {
        proxy_pass http://127.0.0.1:$API_PORT/health;
        proxy_set_header Host \$host;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 120s;
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:$API_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:$WEB_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
EOF
}

# stage: acme (только порт 80 для проверки Let's Encrypt) | https | selfsigned
write_nginx() {
  local stage=$1 conf name
  conf=$(os_nginx_site_path)
  if [ "$MODE" = domain ]; then name=$DOMAIN; else name="_"; fi
  {
    echo "# Workspace — создано установщиком ($(date '+%Y-%m-%d %H:%M')). Перезаписывается при обновлении."
    echo "server {"
    if [ "$MODE" = ip ]; then nginx_listen 80 default_server; else nginx_listen 80; fi
    echo "    server_name $name;"
    echo "    server_tokens off;"
    echo "    location /.well-known/acme-challenge/ { root $(os_acme_root); }"
    if [ "$stage" = acme ]; then
      echo "    location / { return 200 'Workspace: installing'; add_header Content-Type text/plain; }"
    else
      echo "    location / { return 301 https://\$host\$request_uri; }"
    fi
    echo "}"
    if [ "$stage" != acme ]; then
      echo ""
      echo "server {"
      if [ "$MODE" = ip ]; then nginx_listen 443 "ssl default_server"; else nginx_listen 443 ssl; fi
      echo "    http2 on;"
      echo "    server_name $name;"
      if [ "$stage" = https ]; then
        echo "    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;"
        echo "    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;"
      else
        echo "    ssl_certificate     $(os_selfsigned_dir)/workspace.crt;"
        echo "    ssl_certificate_key $(os_selfsigned_dir)/workspace.key;"
      fi
      echo "    ssl_protocols TLSv1.2 TLSv1.3;"
      echo "    ssl_session_cache shared:WS_SSL:10m;"
      echo "    add_header Strict-Transport-Security \"max-age=31536000\" always;"
      nginx_proxy_block
      echo "}"
    fi
  } > "$conf.new"
  # Старые nginx (< 1.25) не знают «http2 on;» — переносим http2 в listen.
  if ! os_nginx_supports_http2_directive; then
    sed -i.bak -e '/http2 on;/d' -e 's/listen \(.*\)443 ssl/listen \1443 ssl http2/' "$conf.new" && rm -f "$conf.new.bak"
  fi
  mv -f "$conf.new" "$conf"
  os_nginx_test || { cat "$conf"; die "nginx не принял конфигурацию (см. выше)."; }
  os_nginx_reload
}

make_selfsigned() {
  local dir; dir=$(os_selfsigned_dir)
  mkdir -p "$dir"
  if [ -f "$dir/workspace.crt" ] && openssl x509 -checkend 2592000 -noout -in "$dir/workspace.crt" >/dev/null 2>&1 \
     && openssl x509 -noout -text -in "$dir/workspace.crt" 2>/dev/null | grep -q "IP Address:$SERVER_IP"; then
    ok "Самоподписанный сертификат уже есть"; return 0
  fi
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 \
    -keyout "$dir/workspace.key" -out "$dir/workspace.crt" \
    -subj "/CN=$SERVER_IP/O=Workspace" -addext "subjectAltName=IP:$SERVER_IP" >/dev/null 2>&1 \
    || die "Не удалось создать самоподписанный сертификат (openssl)"
  chmod 600 "$dir/workspace.key"
  os_after_selfsigned "$dir"
  ok "Самоподписанный сертификат для $SERVER_IP создан (действует 825 дней)"
}

# Проверка цепочки «DNS → этот сервер → nginx → webroot» своим токеном —
# до обращения к Let's Encrypt.
self_check_http() {
  local root token got
  root=$(os_acme_root)
  token="ws-check-$(openssl rand -hex 8)"
  mkdir -p "$root/.well-known/acme-challenge"
  printf '%s' "$token" > "$root/.well-known/acme-challenge/$token"
  got=$(curl -fsS --max-time 10 "http://$DOMAIN/.well-known/acme-challenge/$token" 2>/dev/null || true)
  rm -f "$root/.well-known/acme-challenge/$token"
  if [ "$got" = "$token" ]; then ok "http://$DOMAIN/.well-known/… отвечает этим сервером"; return 0; fi
  got=$(curl -fsS --max-time 10 --resolve "$DOMAIN:80:127.0.0.1" "http://$DOMAIN/.well-known/acme-challenge/$token" 2>/dev/null || true)
  warn "С самого сервера не удалось открыть http://$DOMAIN (у части провайдеров сервер не может обратиться к своему внешнему IP — это нормально). Проверку снаружи сделает пробный выпуск сертификата."
}

issue_certificate() {
  local live="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
  if [ -f "$live" ] && openssl x509 -checkend 2592000 -noout -in "$live" >/dev/null 2>&1; then
    ok "Сертификат для $DOMAIN уже есть и действует больше 30 дней"
    return 0
  fi
  curl -fsS -o /dev/null --max-time 15 https://acme-v02.api.letsencrypt.org/directory \
    || die "Нет доступа к Let's Encrypt (acme-v02.api.letsencrypt.org) — проверьте исходящий HTTPS."
  self_check_http
  local webroot; webroot=$(os_acme_root)
  while :; do
    info "Пробный выпуск сертификата (тестовый сервер Let's Encrypt, лимиты не тратятся)…"
    if certbot certonly --webroot -w "$webroot" -d "$DOMAIN" --email "$LE_EMAIL" --agree-tos --no-eff-email \
         --non-interactive --dry-run >>"$WS_LOG" 2>&1; then
      ok "Пробный выпуск прошёл — Let's Encrypt видит сервер снаружи"
      break
    fi
    bad "Пробный выпуск не прошёл. Последние строки certbot:"
    tail -n 15 /var/log/letsencrypt/letsencrypt.log 2>/dev/null | sed 's/^/    /' || true
    say "  Частые причины:"
    say "    • порт 80 закрыт в файрволе провайдера/облака (или на роутере нет проброса);"
    say "    • A-запись ещё не обновилась у всех DNS (подождите несколько минут);"
    say "    • есть AAAA-запись на другой адрес."
    if [ "$NONINTERACTIVE" = yes ]; then die "Сертификат не выпущен."; fi
    local again=""
    tty_print "${C_B}? Исправьте причину и нажмите Enter, чтобы попробовать снова (q — прервать): ${C_OFF}"
    tty_read again
    [ "$again" = q ] && die "Прервано на выпуске сертификата. Запустите скрипт снова — готовые шаги будут пропущены."
  done
  info "Выпускаю сертификат…"
  certbot certonly --webroot -w "$webroot" -d "$DOMAIN" --email "$LE_EMAIL" --agree-tos --no-eff-email \
    --non-interactive --keep-until-expiring >>"$WS_LOG" 2>&1 || die "certbot не выпустил сертификат (пробный выпуск прошёл — возможно, исчерпан лимит). Журнал: /var/log/letsencrypt/letsencrypt.log"
  ok "Сертификат Let's Encrypt для $DOMAIN выпущен"
}

install_renew_hook() {
  local hook_dir hook
  hook_dir=$(os_letsencrypt_dir)/renewal-hooks/deploy
  hook="$hook_dir/workspace.sh"
  mkdir -p "$hook_dir"
  cat > "$hook" <<EOF
#!/bin/sh
# Workspace: после продления сертификата — перечитать nginx и обновить копию для coturn.
case " \$RENEWED_DOMAINS " in *" $DOMAIN "*) ;; *) exit 0 ;; esac
$(os_renew_hook_body)
EOF
  chmod 755 "$hook"
  RENEWED_DOMAINS=$DOMAIN RENEWED_LINEAGE="$(os_letsencrypt_dir)/live/$DOMAIN" sh "$hook" >/dev/null 2>&1 || true
  os_enable_renew_timer
  ok "Автопродление сертификата включено"
}

# ------------------------------------------------------------------ coturn

write_turnserver_conf() {
  local conf=$1 certdir=${2:-}
  local realm=$SERVER_IP
  [ "$MODE" = domain ] && realm=$DOMAIN
  {
    echo "# Workspace — создано установщиком. Секрет совпадает с TURN_SECRET в $WS_CONFIG/server.env"
    echo "listening-port=$TURN_PORT"
    if [ "$MODE" = domain ] && [ -n "$certdir" ]; then
      echo "tls-listening-port=$TURN_TLS_PORT"
      echo "cert=$certdir/fullchain.pem"
      echo "pkey=$certdir/privkey.pem"
    else
      echo "no-tls"
      echo "no-dtls"
    fi
    if [ "$BEHIND_NAT" = yes ] && [ -n "$PRIVATE_IP4" ]; then
      echo "external-ip=$SERVER_IP/$PRIVATE_IP4"
    fi
    echo "min-port=$TURN_MIN_PORT"
    echo "max-port=$TURN_MAX_PORT"
    echo "fingerprint"
    echo "use-auth-secret"
    echo "static-auth-secret=$TURN_SECRET_VALUE"
    echo "realm=$realm"
    echo "no-loopback-peers"
    echo "no-multicast-peers"
    for r in 0.0.0.0-0.255.255.255 10.0.0.0-10.255.255.255 100.64.0.0-100.127.255.255 127.0.0.0-127.255.255.255 \
             169.254.0.0-169.254.255.255 172.16.0.0-172.31.255.255 192.0.0.0-192.0.0.255 192.0.2.0-192.0.2.255 \
             192.88.99.0-192.88.99.255 192.168.0.0-192.168.255.255 198.18.0.0-198.19.255.255 \
             198.51.100.0-198.51.100.255 203.0.113.0-203.0.113.255 240.0.0.0-255.255.255.255; do
      echo "denied-peer-ip=$r"
    done
    echo "total-quota=100"
    echo "stale-nonce=600"
    echo "no-cli"
    echo "no-tlsv1"
    echo "no-tlsv1_1"
    echo "syslog"
  } > "$conf.new"
  chmod 640 "$conf.new"
  mv -f "$conf.new" "$conf"
}

# ------------------------------------------------------------------ проверки работы

SMOKE_FAIL=0
smoke() {  # smoke "название" команда…
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name"; SMOKE_FAIL=$((SMOKE_FAIL + 1)); fi
}

# Запросы к сайту — через nginx этого сервера (--resolve на 127.0.0.1): так
# проверка не зависит от того, может ли сервер обратиться к своему внешнему
# IP. Сертификат для домена при этом проверяется по-настоящему.
curl_site() {  # curl_site путь [доп. параметры curl]
  local path=$1; shift
  if [ "$MODE" = domain ]; then curl -fsS --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" "$@" "https://$DOMAIN$path"
  else curl -fsS --max-time 10 -k "$@" "https://127.0.0.1$path"; fi
}

check_health_json() { curl_site /health | grep -q '"status":"ok"'; }
check_web_html()    { curl_site / | grep -qi '<html'; }
# Socket.io работает только по WebSocket — проверяем, что nginx пропускает апгрейд (ответ 101).
check_socketio() {
  local out url
  if [ "$MODE" = domain ]; then url="https://$DOMAIN/socket.io/?EIO=4&transport=websocket"
  else url="https://127.0.0.1/socket.io/?EIO=4&transport=websocket"; fi
  out=$(curl -sS -i -N -k --http1.1 --max-time 4 ${DOMAIN:+--resolve "$DOMAIN:443:127.0.0.1"} \
        -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
        -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$url" 2>/dev/null || true)
  printf '%s' "$out" | grep -q '^HTTP/1.1 101'
}
check_http_redirect() {
  if [ "$MODE" = domain ]; then curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "$DOMAIN:80:127.0.0.1" "http://$DOMAIN/"
  else curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1/"; fi | grep -q '^301$'
}
LOGIN_TOKEN=""
check_login() {
  local body
  [ -n "$ADMIN_PASSWORD" ] || return 0
  body=$(printf '{"email":"%s","password":"%s"}' "$ADMIN_EMAIL" "$(printf '%s' "$ADMIN_PASSWORD" | sed 's/\\/\\\\/g; s/"/\\"/g')")
  LOGIN_TOKEN=$(curl_site /api/auth/login -H 'Content-Type: application/json' -d "$body" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
  [ -n "$LOGIN_TOKEN" ]
}
check_ice() {
  [ -n "$LOGIN_TOKEN" ] || return 1
  curl_site /api/webrtc/ice-servers -H "Authorization: Bearer $LOGIN_TOKEN" | grep -q 'turn:'
}
check_cert_valid() {
  CERT_END=$(echo | openssl s_client -connect 127.0.0.1:443 -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//')
  [ -n "$CERT_END" ] && curl_site / -o /dev/null
}

run_smoke_tests() {
  SMOKE_FAIL=0
  os_smoke_services
  smoke "API отвечает локально (127.0.0.1:$API_PORT/health)" curl -fsS --max-time 5 "http://127.0.0.1:$API_PORT/health"
  smoke "Веб-приложение отвечает локально (127.0.0.1:$WEB_PORT)" curl -fsS -o /dev/null --max-time 10 "http://127.0.0.1:$WEB_PORT/"
  if [ "$MODE" = domain ]; then
    smoke "HTTPS: сертификат действителен для $DOMAIN" check_cert_valid
  fi
  smoke "Через nginx: /health" check_health_json
  smoke "Через nginx: страница входа" check_web_html
  smoke "WebSocket-канал (чаты, звонки) проходит через nginx" check_socketio
  smoke "HTTP перенаправляет на HTTPS" check_http_redirect
  if [ -n "$ADMIN_PASSWORD" ]; then
    smoke "Вход администратора $ADMIN_EMAIL" check_login
    if [ "$CALLS" = yes ]; then smoke "Звонки: сервер выдаёт адреса TURN" check_ice; fi
  fi
  if [ "$CALLS" = yes ]; then smoke "coturn слушает порт $TURN_PORT" os_port_listening "$TURN_PORT"; fi
  os_smoke_firewall
  os_smoke_autostart
  if [ "$MODE" = domain ]; then os_smoke_renew_timer; fi
}

print_checklist() {
  local url f="$WS_PREFIX/CHECKLIST.txt"
  url=$(site_origin)
  {
    echo "Workspace $SRC_VERSION — установлено $(date '+%Y-%m-%d %H:%M')"
    echo ""
    echo "[ ] Открыть $url и войти: $ADMIN_EMAIL"
    [ "$MODE" = ip ] && echo "    (сертификат самоподписанный — браузер предупредит один раз, нажмите «Всё равно перейти»)"
    echo "[ ] Сменить пароль администратора в профиле, создать сотрудников (Администрирование)"
    echo "[ ] Настроить резервное копирование папок: $WS_STORAGE и $WS_CONFIG"
    [ "$CALLS" = yes ] && echo "[ ] Проверить видеозвонок между двумя РАЗНЫМИ сетями (например, офис и мобильный интернет)"
    [ "$MODE" = domain ] && echo "[ ] Сертификат действует до: ${CERT_END:-—}; продлевается автоматически"
    echo ""
    echo "Где что:"
    echo "  код:        $WS_APP → $(readlink "$WS_APP" 2>/dev/null || true)"
    echo "  настройки:  $WS_CONFIG/server.env, $WS_CONFIG/web.env"
    echo "  данные:     $WS_STORAGE"
    echo "  журнал:     $WS_LOG"
    echo ""
    echo "Команды:"
    os_checklist_commands
    echo "  обновить:   скачайте новую версию и запустите её install.sh — данные и настройки сохранятся"
    echo "  забыли пароль администратора:"
    echo "              $(os_reset_password_hint)"
  } > "$f"
  chmod 600 "$f"
  hr
  cat "$f"
  hr
  if [ "$ADMIN_PASSWORD_GENERATED" = yes ] && [ -n "$ADMIN_PASSWORD" ]; then
    if [ "$HAVE_TTY" = yes ]; then
      # Только на экран: в журнал и файлы пароль не попадает.
      tty_print "
${C_B}${C_YEL}Пароль администратора (показан один раз, нигде не сохранён):${C_OFF} ${C_B}$ADMIN_PASSWORD${C_OFF}
"
    else
      umask 077; printf '%s\n' "$ADMIN_PASSWORD" > "$WS_PREFIX/ADMIN_PASSWORD.txt"; umask 022
      say "Пароль администратора записан в $WS_PREFIX/ADMIN_PASSWORD.txt (только для root) — удалите файл после входа."
    fi
  fi
  say "Чек-лист сохранён: $f"
}

# ------------------------------------------------------------------ главный сценарий

ws_main() {
  ws_parse_args "$@"
  os_require_privileges
  start_log
  trap 'on_error $LINENO' ERR
  trap cleanup EXIT

  say ""
  say "${C_B}Workspace — установка${C_OFF} (установщик $WS_INSTALLER_VERSION, $(os_name))"

  if [ "$ACTION" = uninstall ]; then os_uninstall; exit 0; fi

  # Уже установлено? Тогда это обновление: прежние ответы — по умолчанию.
  if [ -L "$WS_APP" ] && [ -f "$WS_STATE" ]; then
    ACTION=update
    load_answers "$WS_STATE"
    info "Найдена установка в $WS_PREFIX (версия: $(basename "$(readlink "$WS_APP")"))"
    local what=1
    say "  1) Обновить до новой версии (данные и настройки сохраняются)"
    say "  2) Пройти настройку заново (домен, звонки, файрвол) и обновить"
    ask what "Что сделать" 1 valid_mode "Введите 1 или 2"
    [ "$what" = 2 ] && ACTION=reconfigure
  fi

  step "Проверка системы"
  os_check_supported
  os_install_base_tools
  check_time
  check_resources
  check_internet

  if [ "$ACTION" != update ]; then
    step "Настройки"
    ask_questions
  else
    step "Настройки — из прошлой установки ($WS_STATE)"
    detect_public_ips
    [ "$MODE" = domain ] && verify_dns
  fi
  check_ports
  save_state

  step "Пакеты: nginx, Node.js $NODE_MAJOR, certbot$( [ "$CALLS" = yes ] && printf ', coturn' )"
  os_install_packages
  os_install_node

  step "Пользователь $WS_USER и папки"
  os_create_user
  mkdir -p "$WS_RELEASES" "$WS_CONFIG" "$WS_STORAGE" "$WS_BACKUPS"
  chown "$WS_USER:$(ws_group)" "$WS_RELEASES" "$WS_STORAGE"
  chown "root:$(ws_group)" "$WS_PREFIX" 2>/dev/null || true
  chmod 750 "$WS_PREFIX" "$WS_STORAGE"
  chmod 755 "$WS_RELEASES"
  ok "$WS_PREFIX готова"
  if [ "$ACTION" != install ]; then backup_storage; fi
  write_env

  step "Сборка Workspace"
  resolve_source
  build_release

  step "Запуск служб"
  os_install_services
  activate_release
  if [ -n "$ADMIN_PASSWORD" ]; then scrub_admin_password; fi

  step "nginx и сертификат"
  if [ "$MODE" = domain ]; then
    write_nginx acme
    issue_certificate
    write_nginx https
    install_renew_hook
  else
    make_selfsigned
    write_nginx selfsigned
  fi
  if [ "$CALLS" = yes ]; then os_setup_coturn; else os_disable_coturn; fi

  step "Файрвол"
  os_setup_firewall

  step "Проверка работы"
  sleep 2
  run_smoke_tests
  say ""
  if [ "$SMOKE_FAIL" -eq 0 ]; then
    ok "${C_B}Все проверки пройдены${C_OFF}"
  else
    warn "Не прошло проверок: $SMOKE_FAIL. Подсказки — в журнале $WS_LOG и логах служб: $(os_logs_hint)"
  fi
  print_checklist
  [ "$SMOKE_FAIL" -eq 0 ] || exit 2
}
