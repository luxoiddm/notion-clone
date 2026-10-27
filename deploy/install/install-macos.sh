#!/bin/bash
# Workspace — установка на macOS 12+ (Apple Silicon и Intel).
#
#   sudo bash deploy/install/install-macos.sh            # установка или обновление
#   sudo bash deploy/install/install-macos.sh --help     # параметры
#
# Запускать через sudo из-под обычного администратора: Homebrew работает от
# его имени, системные части (службы, /opt/workspace) — от root.
# Службы — LaunchDaemons (стартуют при загрузке, без входа в систему).
# Файрвол — штатный брандмауэр приложений macOS; pf не трогаем: обновления
# macOS перезаписывают /etc/pf.conf, и это легко ломает удалённый доступ.

WS_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$WS_SCRIPT_DIR/lib/common.sh"

BREW=""
BREW_PREFIX=""
NODE_BIN=""
LD=/Library/LaunchDaemons

os_name() { printf 'macOS %s' "$(sw_vers -productVersion 2>/dev/null)"; }

os_require_privileges() {
  [ "$(id -u)" -eq 0 ] || { printf 'Запустите через sudo: sudo bash %s\n' "$0" >&2; exit 1; }
  if [ -z "${SUDO_USER:-}" ] || [ "$SUDO_USER" = root ]; then
    printf 'Запустите через sudo из-под обычного пользователя-администратора (Homebrew не работает от root).\n' >&2; exit 1
  fi
  for b in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$b" ] && { BREW=$b; break; }; done
  if [ -n "$BREW" ]; then BREW_PREFIX=$("$BREW" --prefix); PATH="$BREW_PREFIX/bin:$BREW_PREFIX/sbin:$BREW_PREFIX/opt/openssl@3/bin:$PATH"; export PATH; fi
}

brew_do() { sudo -u "$SUDO_USER" -H env HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ENV_HINTS=1 "$BREW" "$@" >>"$WS_LOG" 2>&1; }

os_check_supported() {
  local v major
  v=$(sw_vers -productVersion); major=${v%%.*}
  [ "$major" -ge 12 ] || die "Нужна macOS 12 или новее (у вас $v)."
  ok "macOS $v, $(uname -m)"
  if [ -z "$BREW" ]; then
    warn "Homebrew не установлен — он нужен для nginx, certbot, coturn и Node.js."
    local inst=yes; ask_yn inst "Установить Homebrew сейчас (официальный установщик, спросит пароль $SUDO_USER)?" y
    [ "$inst" = yes ] || die "Установите Homebrew (https://brew.sh) и запустите скрипт снова."
    sudo -u "$SUDO_USER" -H /bin/bash -c "NONINTERACTIVE=1 $(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || die "Homebrew не установился"
    os_require_privileges
    [ -n "$BREW" ] || die "Homebrew не найден после установки"
  fi
  ok "Homebrew: $BREW_PREFIX"
}

os_install_base_tools() {
  xcode-select -p >/dev/null 2>&1 || warn "Не найдены Command Line Tools (git). Если понадобится git — выполните xcode-select --install"
  if [ ! -x "$BREW_PREFIX/opt/openssl@3/bin/openssl" ]; then info "Ставлю openssl@3"; brew_do install openssl@3 || die "Не удалось установить openssl@3"; fi
  ok "Базовые утилиты есть (curl, dig, openssl)"
}

os_local_ipv4s() { ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" {print $2}'; }
os_mem_mb()  { echo $(( $(sysctl -n hw.memsize) / 1048576 )); }
os_swap_mb() { echo 4096; }   # macOS управляет подкачкой сама
os_free_gb() { df -Pk "$1" | awk 'NR==2 {printf "%d", $4/1024/1024}'; }
os_make_swap() { :; }
os_has_ipv6() { return 0; }

os_port_owner() {
  { lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fc 2>/dev/null; lsof -nP -iUDP:"$1" -Fc 2>/dev/null; } | sed -n 's/^c//p' | sort -u | tr '\n' ' ' | sed 's/ $//'
}
os_port_listening() { [ -n "$(os_port_owner "$1")" ]; }
os_stop_service_owning() {
  case "$1" in
    *httpd*) launchctl bootout system/org.apache.httpd >/dev/null 2>&1 || true
             launchctl disable system/org.apache.httpd >/dev/null 2>&1 || true ;;
    *) brew_do services stop "$1" || true ;;
  esac
}
os_time_synced() { systemsetup -getusingnetworktime 2>/dev/null | grep -qi 'on'; }
os_enable_time_sync() { systemsetup -setusingnetworktime on >/dev/null 2>&1 || true; }

# ------------------------------------------------------------------ пакеты

os_install_packages() {
  local list="nginx certbot"
  [ "$CALLS" = yes ] && list="$list coturn"
  info "Ставлю через Homebrew: $list"
  # shellcheck disable=SC2086
  brew_do install $list || die "Не удалось установить: $list (журнал: $WS_LOG)"
  mkdir -p "$BREW_PREFIX/etc/nginx/servers"
  # Свой nginx-демон от root (порты 80/443); brew services не используем.
  brew_do services stop nginx || true
  ok "Пакеты установлены: $list"
}

os_install_node() {
  NODE_BIN="$BREW_PREFIX/opt/node@$NODE_MAJOR/bin"
  if [ ! -x "$NODE_BIN/node" ]; then info "Ставлю Node.js $NODE_MAJOR LTS"; brew_do install "node@$NODE_MAJOR" || die "Не удалось установить node@$NODE_MAJOR"; fi
  PATH="$NODE_BIN:$PATH"; export PATH
  ok "Node.js $("$NODE_BIN/node" -v), npm $("$NODE_BIN/npm" -v)"
}

# ------------------------------------------------------------------ пользователь

os_create_user() {
  if ! dscl . -read "/Groups/$WS_USER" >/dev/null 2>&1; then
    local gid=400; while dscl . -list /Groups PrimaryGroupID | awk '{print $2}' | grep -qx "$gid"; do gid=$((gid + 1)); done
    dscl . -create "/Groups/$WS_USER"; dscl . -create "/Groups/$WS_USER" PrimaryGroupID "$gid"
    dscl . -create "/Groups/$WS_USER" RealName "Workspace"
  fi
  if ! id "$WS_USER" >/dev/null 2>&1; then
    local uid=400; while dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx "$uid"; do uid=$((uid + 1)); done
    dscl . -create "/Users/$WS_USER"
    dscl . -create "/Users/$WS_USER" UniqueID "$uid"
    dscl . -create "/Users/$WS_USER" PrimaryGroupID "$(dscl . -read "/Groups/$WS_USER" PrimaryGroupID | awk '{print $2}')"
    dscl . -create "/Users/$WS_USER" UserShell /usr/bin/false
    dscl . -create "/Users/$WS_USER" NFSHomeDirectory "$WS_PREFIX/.home"
    dscl . -create "/Users/$WS_USER" RealName "Workspace service"
    dscl . -create "/Users/$WS_USER" IsHidden 1
    dscl . -create "/Users/$WS_USER" Password '*'
    ok "Создан скрытый системный пользователь $WS_USER (без входа)"
  else
    ok "Пользователь $WS_USER уже есть"
  fi
  mkdir -p "$WS_PREFIX/.home" "$WS_PREFIX/logs"
  chown "$WS_USER:$(ws_group)" "$WS_PREFIX/.home" "$WS_PREFIX/logs"; chmod 700 "$WS_PREFIX/.home"
}

as_ws() {
  local dir=$1; shift
  # shellcheck disable=SC2046
  sudo -u "$WS_USER" env -i PATH="$NODE_BIN:$BREW_PREFIX/bin:/usr/bin:/bin" HOME="$WS_PREFIX/.home" \
    npm_config_cache="$WS_PREFIX/.home/.npm" npm_config_update_notifier=false npm_config_fund=false \
    NEXT_TELEMETRY_DISABLED=1 LANG=en_US.UTF-8 $(proxy_env) \
    /bin/bash -c 'cd "$1" && shift && exec "$@"' _ "$dir" "$@"
}

# ------------------------------------------------------------------ службы (launchd)

plist() {  # plist ИМЯ ПОЛЬЗОВАТЕЛЬ ПАПКА ЛОГ команда…
  local label=$1 user=$2 dir=$3 log=$4; shift 4
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo "  <key>Label</key><string>$label</string>"
    [ -n "$user" ] && echo "  <key>UserName</key><string>$user</string>"
    [ -n "$dir" ] && echo "  <key>WorkingDirectory</key><string>$dir</string>"
    echo '  <key>ProgramArguments</key><array>'
    local a; for a in "$@"; do echo "    <string>$a</string>"; done
    echo '  </array>'
    echo '  <key>EnvironmentVariables</key><dict>'
    echo "    <key>PATH</key><string>$NODE_BIN:$BREW_PREFIX/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>"
    echo "    <key>HOME</key><string>$WS_PREFIX/.home</string>"
    echo '    <key>NODE_ENV</key><string>production</string>'
    echo '    <key>NEXT_TELEMETRY_DISABLED</key><string>1</string>'
    echo '  </dict>'
    echo '  <key>RunAtLoad</key><true/>'
    echo '  <key>KeepAlive</key><true/>'
    echo '  <key>ThrottleInterval</key><integer>5</integer>'
    echo "  <key>StandardOutPath</key><string>$log</string>"
    echo "  <key>StandardErrorPath</key><string>$log</string>"
    echo '</dict></plist>'
  } > "$LD/$label.plist"
  chown root:wheel "$LD/$label.plist"; chmod 644 "$LD/$label.plist"
}

ld_restart() {  # перезапустить (или загрузить) демона
  launchctl bootout "system/$1" >/dev/null 2>&1 || true
  sleep 1
  launchctl bootstrap system "$LD/$1.plist" 2>>"$WS_LOG" || launchctl kickstart -k "system/$1" >/dev/null 2>&1 || true
}
ld_running() { launchctl print "system/$1" 2>/dev/null | grep -q 'state = running'; }

os_install_services() {
  plist com.workspace.server "$WS_USER" "$WS_APP/apps/server" "$WS_PREFIX/logs/server.log" "$NODE_BIN/node" --import tsx src/index.ts
  plist com.workspace.web "$WS_USER" "$WS_APP/apps/web" "$WS_PREFIX/logs/web.log" "$NODE_BIN/node" scripts/run.mjs start
  ok "Службы com.workspace.server и com.workspace.web (LaunchDaemons, автозапуск при загрузке)"
}
os_restart_app() { ld_restart com.workspace.server; ld_restart com.workspace.web; }
os_logs_hint() { printf 'tail -n 200 %s/logs/server.log %s/logs/web.log' "$WS_PREFIX" "$WS_PREFIX"; }

# ------------------------------------------------------------------ nginx

NGINX_BIN() { printf '%s/opt/nginx/bin/nginx' "$BREW_PREFIX"; }
os_nginx_site_path() { printf '%s/etc/nginx/servers/workspace.conf' "$BREW_PREFIX"; }
os_nginx_remove_site() { rm -f "$(os_nginx_site_path)"; }
os_nginx_test() { "$(NGINX_BIN)" -t >>"$WS_LOG" 2>&1; }
os_nginx_reload() {
  if [ ! -f "$LD/com.workspace.nginx.plist" ]; then
    plist com.workspace.nginx "" "" "$WS_PREFIX/logs/nginx.log" "$(NGINX_BIN)" -g "daemon off;"
  fi
  if ld_running com.workspace.nginx; then "$(NGINX_BIN)" -s reload; else ld_restart com.workspace.nginx; fi
  sleep 1
}
os_nginx_supports_http2_directive() { return 0; }
os_acme_root() { mkdir -p /var/www/certbot; chmod 755 /var/www /var/www/certbot; printf '/var/www/certbot'; }
os_selfsigned_dir() { printf '%s/etc/nginx/workspace-tls' "$BREW_PREFIX"; }
os_after_selfsigned() { :; }
os_letsencrypt_dir() { printf '/etc/letsencrypt'; }

os_renew_hook_body() {
  cat <<EOF
if [ -d "$WS_PREFIX/turn-certs" ]; then
  install -m 644 -o root -g $(ws_group) "\$RENEWED_LINEAGE/fullchain.pem" "$WS_PREFIX/turn-certs/fullchain.pem"
  install -m 640 -o root -g $(ws_group) "\$RENEWED_LINEAGE/privkey.pem" "$WS_PREFIX/turn-certs/privkey.pem"
  launchctl kickstart -k system/com.workspace.coturn >/dev/null 2>&1 || true
fi
"$(NGINX_BIN)" -s reload
EOF
}

os_enable_renew_timer() {
  cat > "$LD/com.workspace.certbot-renew.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.workspace.certbot-renew</string>
  <key>ProgramArguments</key><array><string>$BREW_PREFIX/bin/certbot</string><string>renew</string><string>--quiet</string></array>
  <key>StartCalendarInterval</key><array>
    <dict><key>Hour</key><integer>3</integer><key>Minute</key><integer>17</integer></dict>
    <dict><key>Hour</key><integer>15</integer><key>Minute</key><integer>17</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$WS_PREFIX/logs/certbot-renew.log</string>
  <key>StandardErrorPath</key><string>$WS_PREFIX/logs/certbot-renew.log</string>
</dict></plist>
EOF
  chown root:wheel "$LD/com.workspace.certbot-renew.plist"; chmod 644 "$LD/com.workspace.certbot-renew.plist"
  launchctl bootout system/com.workspace.certbot-renew >/dev/null 2>&1 || true
  launchctl bootstrap system "$LD/com.workspace.certbot-renew.plist" 2>>"$WS_LOG" || true
}

# ------------------------------------------------------------------ coturn

os_setup_coturn() {
  local conf="$BREW_PREFIX/etc/turnserver.conf" certdir=""
  if [ "$MODE" = domain ]; then
    certdir="$WS_PREFIX/turn-certs"; mkdir -p "$certdir"
    install -m 644 -o root -g "$(ws_group)" "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$certdir/fullchain.pem"
    install -m 640 -o root -g "$(ws_group)" "/etc/letsencrypt/live/$DOMAIN/privkey.pem" "$certdir/privkey.pem"
  fi
  write_turnserver_conf "$conf" "$certdir"
  chown "root:$(ws_group)" "$conf"
  plist com.workspace.coturn "$WS_USER" "" "$WS_PREFIX/logs/coturn.log" "$BREW_PREFIX/bin/turnserver" -c "$conf"
  ld_restart com.workspace.coturn
  sleep 2
  ld_running com.workspace.coturn || { tail -n 30 "$WS_PREFIX/logs/coturn.log" 2>/dev/null || true; die "coturn не запустился (см. выше)."; }
  ok "coturn (TURN) запущен: порт $TURN_PORT${certdir:+, TLS $TURN_TLS_PORT}, медиа UDP $TURN_MIN_PORT-$TURN_MAX_PORT"
}
os_disable_coturn() {
  [ -f "$LD/com.workspace.coturn.plist" ] || return 0
  launchctl bootout system/com.workspace.coturn >/dev/null 2>&1 || true
  rm -f "$LD/com.workspace.coturn.plist"
  info "Звонки без TURN: coturn остановлен"
}

# ------------------------------------------------------------------ файрвол

FWCTL=/usr/libexec/ApplicationFirewall/socketfilterfw

ask_firewall() {
  local use=yes
  say ""
  say "  ${C_B}Файрвол.${C_OFF} На macOS используется штатный брандмауэр приложений: он пропускает входящие"
  say "  только к разрешённым программам (nginx$( [ "$CALLS" = yes ] && printf ', coturn')) и включает «скрытый режим»."
  [ "$FIREWALL" = none ] && use=no
  ask_yn use "Включить брандмауэр macOS и разрешить только Workspace?" y
  if [ "$use" = yes ]; then FIREWALL=macos; else FIREWALL=none; fi
  SSH_PORTS=${SSH_PORTS:-22}
}

os_setup_firewall() {
  [ "$FIREWALL" = macos ] || { warn "Брандмауэр не настраивается (по вашему выбору)"; return 0; }
  local nginx_real turn_real
  nginx_real=$(cd "$(dirname "$(NGINX_BIN)")" && pwd -P)/nginx
  "$FWCTL" --setglobalstate on >/dev/null
  "$FWCTL" --setstealthmode on >/dev/null
  "$FWCTL" --setallowsigned off >/dev/null 2>&1 || true
  "$FWCTL" --add "$nginx_real" >/dev/null 2>&1 || true
  "$FWCTL" --unblockapp "$nginx_real" >/dev/null 2>&1 || true
  if [ "$CALLS" = yes ]; then
    turn_real=$(cd "$BREW_PREFIX/bin" && pwd -P)/$(readlink "$BREW_PREFIX/bin/turnserver" 2>/dev/null || echo turnserver)
    [ -x "$turn_real" ] || turn_real="$BREW_PREFIX/bin/turnserver"
    "$FWCTL" --add "$turn_real" >/dev/null 2>&1 || true
    "$FWCTL" --unblockapp "$turn_real" >/dev/null 2>&1 || true
  fi
  # Удалённый вход (SSH) управляется отдельно — в Настройках → Общий доступ.
  ok "Брандмауэр macOS включён: входящие разрешены nginx$( [ "$CALLS" = yes ] && printf ' и coturn'), скрытый режим включён"
  info "Node.js слушает только 127.0.0.1 — наружу не виден"
}

# ------------------------------------------------------------------ проверки

os_smoke_services() {
  smoke "Служба com.workspace.server работает" ld_running com.workspace.server
  smoke "Служба com.workspace.web работает" ld_running com.workspace.web
  smoke "nginx работает" ld_running com.workspace.nginx
  if [ "$CALLS" = yes ]; then smoke "coturn работает" ld_running com.workspace.coturn; fi
}
fw_on() { "$FWCTL" --getglobalstate 2>/dev/null | grep -qi 'enabled'; }
os_smoke_firewall() { if [ "$FIREWALL" = macos ]; then smoke "Брандмауэр macOS включён" fw_on; else warn "Брандмауэр не настраивался"; fi; }
plists_ok() { [ -f "$LD/com.workspace.server.plist" ] && [ -f "$LD/com.workspace.web.plist" ] && [ -f "$LD/com.workspace.nginx.plist" ]; }
os_smoke_autostart() { smoke "Автозапуск при загрузке (LaunchDaemons)" plists_ok; }
renew_loaded() { launchctl print system/com.workspace.certbot-renew >/dev/null 2>&1; }
os_smoke_renew_timer() { smoke "Автопродление сертификата (дважды в день)" renew_loaded; }

os_checklist_commands() {
  echo "  состояние:  sudo launchctl print system/com.workspace.server | grep state"
  echo "  логи:       tail -f $WS_PREFIX/logs/server.log $WS_PREFIX/logs/web.log"
  echo "  перезапуск: sudo launchctl kickstart -k system/com.workspace.server; sudo launchctl kickstart -k system/com.workspace.web"
  [ "$MODE" = domain ] && echo "  сертификат: sudo certbot certificates"
  echo "  сервер должен не засыпать: Настройки → Экран блокировки/Энергосбережение — запретить сон"
  return 0
}
os_reset_password_hint() {
  printf 'cd %s && sudo -u %s env PATH=%s:$PATH HOME=%s/.home npm run admin:reset-password -w apps/server -- %s "НовыйПароль"' "$WS_APP" "$WS_USER" "$NODE_BIN" "$WS_PREFIX" "${ADMIN_EMAIL:-email}"
}

# ------------------------------------------------------------------ удаление

os_uninstall() {
  [ -f "$WS_STATE" ] && load_answers "$WS_STATE"
  warn "Будут удалены: службы Workspace (LaunchDaemons), сайт в nginx, coturn Workspace, задача продления сертификата."
  confirm_yes "Удалить Workspace с этого Mac"
  local l
  for l in com.workspace.web com.workspace.server com.workspace.coturn com.workspace.nginx com.workspace.certbot-renew; do
    launchctl bootout "system/$l" >/dev/null 2>&1 || true
    rm -f "$LD/$l.plist"
  done
  [ -n "$BREW_PREFIX" ] && rm -f "$BREW_PREFIX/etc/nginx/servers/workspace.conf"
  rm -f /etc/letsencrypt/renewal-hooks/deploy/workspace.sh
  ok "Службы удалены"
  if [ -n "${DOMAIN:-}" ] && [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    local delcert=no; ask_yn delcert "Удалить сертификат Let's Encrypt для $DOMAIN?" n
    [ "$delcert" = yes ] && certbot delete --cert-name "$DOMAIN" --non-interactive >/dev/null 2>&1 && ok "Сертификат удалён"
  fi
  rm -rf "$WS_RELEASES" "$WS_APP" "$WS_PREFIX/turn-certs"
  local deldata=no
  warn "Данные: $WS_STORAGE, настройки: $WS_CONFIG, копии: $WS_BACKUPS"
  ask_yn deldata "Удалить и данные? Это необратимо" n
  if [ "$deldata" = yes ]; then
    local really=""; tty_print "${C_B}${C_RED}  Для подтверждения напишите DELETE: ${C_OFF}"; tty_read really
    if [ "$really" = DELETE ]; then
      rm -rf "$WS_PREFIX"
      dscl . -delete "/Users/$WS_USER" >/dev/null 2>&1 || true
      dscl . -delete "/Groups/$WS_USER" >/dev/null 2>&1 || true
      ok "Данные и пользователь $WS_USER удалены"
    else warn "Данные сохранены"; fi
  else ok "Данные сохранены в $WS_PREFIX"; fi
  ok "Workspace удалён"
}

ws_main "$@"
