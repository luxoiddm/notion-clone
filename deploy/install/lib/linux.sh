# shellcheck shell=bash
# Workspace — общее для Linux с systemd (Debian/Ubuntu и RHEL/Rocky):
# службы, пользователь, nginx, coturn, nftables. Пакетный менеджер и пути
# конкретного дистрибутива — в install-debian.sh / install-rhel.sh.

NFT_DIR=/etc/nftables.d
NFT_FILE=$NFT_DIR/workspace.nft
FW_FLUSH=no
FW_CONTAINERS=""

os_name() { . /etc/os-release; printf '%s' "${PRETTY_NAME:-Linux}"; }

os_require_privileges() {
  [ "$(id -u)" -eq 0 ] || { printf 'Запустите от root: sudo bash %s\n' "$0" >&2; exit 1; }
  command -v systemctl >/dev/null 2>&1 || { printf 'Нужен systemd.\n' >&2; exit 1; }
}

os_local_ipv4s() { ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1; }
os_mem_mb()  { awk '/^MemTotal:/ {printf "%d", $2/1024}' /proc/meminfo; }
os_swap_mb() { awk '/^SwapTotal:/ {printf "%d", $2/1024}' /proc/meminfo; }
os_free_gb() { df -Pk "$1" | awk 'NR==2 {printf "%d", $4/1024/1024}'; }
os_has_ipv6() { [ -f /proc/net/if_inet6 ] && [ -s /proc/net/if_inet6 ]; }

os_make_swap() {
  local mb=$1 f=/swapfile-workspace
  [ -f "$f" ] && { swapon "$f" 2>/dev/null || true; ok "Файл подкачки уже есть"; return 0; }
  fallocate -l "${mb}M" "$f" 2>/dev/null || dd if=/dev/zero of="$f" bs=1M count="$mb" status=none
  chmod 600 "$f"; mkswap "$f" >/dev/null; swapon "$f"
  grep -q "^$f " /etc/fstab || echo "$f none swap sw 0 0" >> /etc/fstab
  ok "Создан файл подкачки $f (${mb} МБ), подключается при загрузке"
}

os_port_owner() {
  ss -H -ltnup 2>/dev/null | awk -v p=":$1" '$5 ~ p"$" {print $7}' | sed -n 's/.*(("\([^"]*\)".*/\1/p' | sort -u | tr '\n' ' ' | sed 's/ $//'
}
os_port_listening() { ss -H -ltnu 2>/dev/null | awk '{print $5}' | grep -Eq "[:.]$1\$"; }

os_stop_service_owning() {
  local svc
  case "$1" in
    *lighttpd*) svc=lighttpd ;; *apache2*) svc=apache2 ;; *httpd*) svc=httpd ;; *caddy*) svc=caddy ;; *) return 1 ;;
  esac
  systemctl disable --now "$svc" >/dev/null 2>&1 || true
}

os_time_synced() { [ "$(timedatectl show -p NTPSynchronized --value 2>/dev/null)" = yes ]; }
os_enable_time_sync() { timedatectl set-ntp true >/dev/null 2>&1 || true; }

# ------------------------------------------------------------------ пользователь и запуск от него

os_create_user() {
  if ! id "$WS_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$WS_PREFIX" --no-create-home --shell "$(command -v nologin || echo /usr/sbin/nologin)" \
      --comment "Workspace service" "$WS_USER"
    ok "Создан системный пользователь $WS_USER (без входа в систему)"
  else
    ok "Пользователь $WS_USER уже есть"
  fi
  mkdir -p "$WS_PREFIX/.home"
  chown "$WS_USER:$(ws_group)" "$WS_PREFIX/.home"; chmod 700 "$WS_PREFIX/.home"
}

as_ws() {  # as_ws ПАПКА команда…
  local dir=$1; shift
  # Чистое окружение, но прокси и доп. корневые сертификаты (корпоративная сеть) передаём.
  # shellcheck disable=SC2046
  runuser -u "$WS_USER" -- env -i PATH="$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin" HOME="$WS_PREFIX/.home" \
    npm_config_cache="$WS_PREFIX/.home/.npm" npm_config_update_notifier=false npm_config_fund=false \
    NEXT_TELEMETRY_DISABLED=1 LANG=C.UTF-8 $(proxy_env) \
    bash -c 'cd "$1" && shift && exec "$@"' _ "$dir" "$@"
}

# ------------------------------------------------------------------ службы

os_install_services() {
  local node; node=$(command -v node)
  cat > /etc/systemd/system/workspace-server.service <<EOF
[Unit]
Description=Workspace API (Express + Socket.io)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$WS_USER
Group=$(ws_group)
WorkingDirectory=$WS_APP/apps/server
Environment=NODE_ENV=production
Environment=HOME=$WS_PREFIX/.home
# Пакеты @core/* — исходники TypeScript, поэтому сервер запускается через tsx.
ExecStart=$node --import tsx src/index.ts
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
  cat > /etc/systemd/system/workspace-web.service <<EOF
[Unit]
Description=Workspace Web (Next.js)
After=network-online.target workspace-server.service
Wants=network-online.target

[Service]
Type=simple
User=$WS_USER
Group=$(ws_group)
WorkingDirectory=$WS_APP/apps/web
Environment=NODE_ENV=production
Environment=HOME=$WS_PREFIX/.home
Environment=NEXT_TELEMETRY_DISABLED=1
Environment=PATH=$(dirname "$node"):/usr/local/bin:/usr/bin:/bin
ExecStart=$node scripts/run.mjs start
Restart=always
RestartSec=3
LimitNOFILE=65536
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable workspace-server workspace-web >/dev/null 2>&1
  ok "Службы workspace-server и workspace-web (автозапуск включён)"
}

os_restart_app() { systemctl restart workspace-server workspace-web; }
os_logs_hint() { printf 'journalctl -u workspace-server -u workspace-web -n 200'; }

# ------------------------------------------------------------------ nginx

os_nginx_test() { nginx -t >>"$WS_LOG" 2>&1; }
os_nginx_reload() {
  systemctl enable nginx >/dev/null 2>&1 || true
  if systemctl is-active --quiet nginx; then systemctl reload nginx; else systemctl restart nginx; fi
}
os_nginx_supports_http2_directive() {
  local v; v=$(nginx -v 2>&1 | sed -n 's/.*nginx\/\([0-9.]*\).*/\1/p')
  [ -n "$v" ] || return 1
  printf '%s\n%s\n' "1.25.1" "$v" | sort -V | head -n1 | grep -qx "1.25.1"
}
os_acme_root() { mkdir -p /var/www/certbot; printf '/var/www/certbot'; }
os_selfsigned_dir() { printf '/etc/nginx/workspace-tls'; }
os_after_selfsigned() { os_selinux_relabel "$1"; }
os_letsencrypt_dir() { printf '/etc/letsencrypt'; }

os_renew_hook_body() {
  local grp; grp=$(os_coturn_group)
  cat <<EOF
if [ -d /etc/coturn/certs ]; then
  install -m 644 -o root -g $grp "\$RENEWED_LINEAGE/fullchain.pem" /etc/coturn/certs/fullchain.pem
  install -m 640 -o root -g $grp "\$RENEWED_LINEAGE/privkey.pem" /etc/coturn/certs/privkey.pem
  systemctl is-active --quiet coturn && systemctl restart coturn
fi
systemctl reload nginx
EOF
}

os_enable_renew_timer() {
  local t
  for t in certbot.timer certbot-renew.timer snap.certbot.renew.timer; do
    if systemctl list-unit-files "$t" >/dev/null 2>&1 && systemctl list-unit-files "$t" | grep -q "$t"; then
      systemctl enable --now "$t" >/dev/null 2>&1 || true; RENEW_TIMER=$t; return 0
    fi
  done
  cat > /etc/systemd/system/workspace-certbot-renew.service <<'EOF'
[Unit]
Description=Продление сертификатов Let's Encrypt (Workspace)
[Service]
Type=oneshot
ExecStart=/usr/bin/certbot renew --quiet
EOF
  cat > /etc/systemd/system/workspace-certbot-renew.timer <<'EOF'
[Unit]
Description=Продление сертификатов дважды в день
[Timer]
OnCalendar=*-*-* 03,15:17:00
RandomizedDelaySec=1h
Persistent=true
[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now workspace-certbot-renew.timer >/dev/null 2>&1
  RENEW_TIMER=workspace-certbot-renew.timer
}

# ------------------------------------------------------------------ coturn

os_coturn_user()  { local u; u=$(systemctl show -p User --value coturn 2>/dev/null || true); printf '%s' "${u:-$(os_coturn_default_user)}"; }
os_coturn_group() { id -gn "$(os_coturn_user)" 2>/dev/null || printf 'root'; }

os_setup_coturn() {
  local conf certdir=""
  conf=$(os_coturn_conf_path)
  if [ "$MODE" = domain ]; then
    certdir=/etc/coturn/certs
    mkdir -p "$certdir"
    install -m 644 -o root -g "$(os_coturn_group)" "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" "$certdir/fullchain.pem"
    install -m 640 -o root -g "$(os_coturn_group)" "/etc/letsencrypt/live/$DOMAIN/privkey.pem" "$certdir/privkey.pem"
  fi
  [ -f "$conf" ] && [ ! -f "$conf.orig" ] && cp -p "$conf" "$conf.orig"
  write_turnserver_conf "$conf" "$certdir"
  chown "root:$(os_coturn_group)" "$conf"
  [ -f /etc/default/coturn ] && sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
  os_selinux_coturn
  systemctl enable coturn >/dev/null 2>&1
  systemctl restart coturn
  sleep 1
  systemctl is-active --quiet coturn || { journalctl -u coturn -n 30 --no-pager || true; die "coturn не запустился (см. выше)."; }
  [ "$BEHIND_NAT" = yes ] && info "Сервер за NAT: в coturn указан external-ip=$SERVER_IP/$PRIVATE_IP4"
  ok "coturn (TURN) запущен: порт $TURN_PORT${certdir:+, TLS $TURN_TLS_PORT}, медиа UDP $TURN_MIN_PORT-$TURN_MAX_PORT"
}

os_disable_coturn() {
  if systemctl list-unit-files coturn.service >/dev/null 2>&1 && grep -q 'Workspace' "$(os_coturn_conf_path)" 2>/dev/null; then
    systemctl disable --now coturn >/dev/null 2>&1 || true
    info "Звонки без TURN: coturn остановлен"
  fi
}

# ------------------------------------------------------------------ файрвол

detect_ssh_ports() {
  local ports=""
  if command -v sshd >/dev/null 2>&1; then ports=$(sshd -T 2>/dev/null | awk '$1=="port"{print $2}' | tr '\n' ',' ); fi
  if [ -n "${SSH_CONNECTION:-}" ]; then ports="$ports$(printf '%s' "$SSH_CONNECTION" | awk '{print $4}'),"; fi
  ports=$(printf '%s' "$ports" | tr ',' '\n' | grep -E '^[0-9]+$' | sort -un | tr '\n' ',' | sed 's/,$//')
  printf '%s' "${ports:-22}"
}

ask_firewall() {
  local found="" newsrv=yes usenft=yes
  command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active' && found="$found ufw"
  systemctl is-active --quiet firewalld 2>/dev/null && found="$found firewalld"
  systemctl is-active --quiet netfilter-persistent 2>/dev/null && found="$found iptables-persistent"
  systemctl is-active --quiet iptables 2>/dev/null && found="$found iptables"
  FW_CONTAINERS=""
  systemctl is-active --quiet docker 2>/dev/null && FW_CONTAINERS="$FW_CONTAINERS docker"
  systemctl is-active --quiet libvirtd 2>/dev/null && FW_CONTAINERS="$FW_CONTAINERS libvirt"
  { command -v incus >/dev/null 2>&1 || command -v lxd >/dev/null 2>&1; } && FW_CONTAINERS="$FW_CONTAINERS lxd/incus"

  say ""
  say "  ${C_B}Файрвол сервера.${C_OFF} Сейчас активны: ${found:-ничего не найдено}${FW_CONTAINERS:+; есть контейнеры/ВМ:$FW_CONTAINERS}"
  case "$FIREWALL" in nft-new) newsrv=yes ;; nft-add|existing|none) newsrv=no ;; esac
  ask_yn newsrv "Это новый сервер и файрвол можно настроить с нуля? (основной — nftables, остальные файрволы отключаются)" y
  if [ "$newsrv" = yes ]; then
    FIREWALL=nft-new
    if [ -n "$FW_CONTAINERS" ]; then
      warn "Есть${FW_CONTAINERS}: их сетевые правила не трогаю (без «flush ruleset» и без запрета forward), только своя таблица."
      FW_FLUSH=no
    else
      FW_FLUSH=yes
    fi
  else
    ask_yn usenft "Добавить свою таблицу nftables (существующие правила не трогаю${found:+, порты открою и в$found})?" y
    if [ "$usenft" = yes ]; then FIREWALL=nft-add
    elif [ -n "$found" ]; then FIREWALL=existing
    else FIREWALL=none; warn "Файрвол настраиваться не будет — убедитесь, что порты $API_PORT и $WEB_PORT не открыты наружу (службы и так слушают только 127.0.0.1)."; fi
  fi
  if [ "$FIREWALL" != none ]; then
    [ -n "$SSH_PORTS" ] || SSH_PORTS=$(detect_ssh_ports)
    ask SSH_PORTS "Порты SSH, которые останутся открытыми" "$SSH_PORTS" valid_ports "Список портов через запятую, например 22 или 22,2222"
    local extra=${EXTRA_PORTS:--}
    ask extra "Открыть дополнительные порты? (например 8443/tcp,51820/udp; «-» — нет)" "$extra" valid_extra "Формат: 8443/tcp,51820/udp или -"
    if [ "$extra" = "-" ]; then EXTRA_PORTS=""; else EXTRA_PORTS=$extra; fi
  fi
}
valid_extra() { [ "$1" = "-" ] || valid_ports "$1"; }

nft_extra_rules() {
  local item port proto
  for item in $(port_list_nft "$EXTRA_PORTS"); do
    port=${item%/*}; proto=tcp
    case "$item" in */udp) proto=udp ;; esac
    printf '    %s dport %s accept comment "дополнительно"\n' "$proto" "$port"
  done
}

nft_rules() {
  local ssh
  ssh=$(printf '%s' "$SSH_PORTS" | tr -d ' ')
  cat <<EOF
#!/usr/sbin/nft -f
# Workspace — файрвол (создано установщиком $(date '+%Y-%m-%d %H:%M')).
# Перезапуск безопасен: таблица пересоздаётся целиком.
table inet workspace
delete table inet workspace
table inet workspace {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state invalid drop
    ct state { established, related } accept
    iif "lo" accept
    ip protocol icmp accept
    meta l4proto ipv6-icmp accept
    ip6 saddr fe80::/10 udp dport 546 accept comment "DHCPv6"
    tcp dport { $ssh } accept comment "SSH"
    tcp dport { 80, 443 } accept comment "Workspace: сайт"
EOF
  if [ "$CALLS" = yes ]; then
    echo "    udp dport $TURN_PORT accept comment \"TURN\""
    if [ "$MODE" = domain ]; then echo "    tcp dport { $TURN_PORT, $TURN_TLS_PORT } accept comment \"TURN\""; else echo "    tcp dport $TURN_PORT accept comment \"TURN\""; fi
    echo "    udp dport $TURN_MIN_PORT-$TURN_MAX_PORT accept comment \"TURN: медиа\""
  fi
  nft_extra_rules
  echo "  }"
  if [ "$FIREWALL" = nft-new ] && [ "$FW_FLUSH" = yes ]; then
    cat <<'EOF'
  chain forward {
    type filter hook forward priority 0; policy drop;
  }
EOF
  fi
  echo "}"
}

# Ждём подтверждения, что новое SSH-подключение проходит; иначе — откат.
fw_wait_confirm() {
  local secs=$1 left ans="" start now
  if [ "$NONINTERACTIVE" = yes ]; then return 0; fi
  start=$(date +%s)
  say ""
  say "  ${C_B}${C_YEL}Проверка доступа.${C_OFF} Правила применены. ${C_B}Не закрывая это окно${C_OFF}, откройте НОВОЕ SSH-подключение к серверу"
  say "  (порт $(printf '%s' "$SSH_PORTS" | tr ',' ' ')) и убедитесь, что вход работает."
  say "  Если за $secs секунд не подтвердить, правила откатятся сами — доступ не потеряется."
  while :; do
    now=$(date +%s); left=$((secs - (now - start)))
    [ "$left" -le 0 ] && return 1
    tty_print "${C_B}  Новое SSH-подключение работает? Напишите yes (осталось ${left} с): ${C_OFF}"
    ans=""
    IFS= read -r -t "$left" ans < /dev/tty || true
    case "$ans" in yes|YES|Yes|да|Да) return 0 ;; no|NO|нет) return 1 ;; esac
  done
}

fw_disable_others() {
  if command -v ufw >/dev/null 2>&1; then ufw --force disable >/dev/null 2>&1 || true; systemctl disable --now ufw >/dev/null 2>&1 || true; fi
  for s in firewalld netfilter-persistent iptables ip6tables; do
    if systemctl list-unit-files "$s.service" 2>/dev/null | grep -q "^$s.service"; then
      systemctl disable --now "$s" >/dev/null 2>&1 || true
      systemctl mask "$s" >/dev/null 2>&1 || true
    fi
  done
}

fw_persist_nft() {
  local main; main=$(os_nft_main_conf)
  if [ "$FIREWALL" = nft-new ] && [ "$FW_FLUSH" = yes ]; then
    [ -f "$main" ] && [ ! -f "$main.before-workspace" ] && cp -p "$main" "$main.before-workspace"
    cat > "$main" <<EOF
#!/usr/sbin/nft -f
# Создано установщиком Workspace. Прежний файл: $main.before-workspace
flush ruleset
include "$NFT_DIR/*.nft"
EOF
  else
    touch "$main"
    grep -q "$NFT_FILE\|$NFT_DIR/\*" "$main" || printf '\ninclude "%s"\n' "$NFT_FILE" >> "$main"
  fi
  systemctl enable nftables >/dev/null 2>&1 || true
}

fw_open_existing() {
  local p item port proto
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
    for p in $(port_list_nft "$SSH_PORTS"); do ufw allow "$p/tcp" >/dev/null; done
    ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
    if [ "$CALLS" = yes ]; then
      ufw allow "$TURN_PORT" >/dev/null
      [ "$MODE" = domain ] && ufw allow "$TURN_TLS_PORT/tcp" >/dev/null
      ufw allow "$TURN_MIN_PORT:$TURN_MAX_PORT/udp" >/dev/null
    fi
    for item in $(port_list_nft "$EXTRA_PORTS"); do port=${item%/*}; proto=tcp; case "$item" in */udp) proto=udp ;; esac; ufw allow "$(printf '%s' "$port" | tr '-' ':')/$proto" >/dev/null; done
    ok "Порты открыты в ufw"
  fi
  if systemctl is-active --quiet firewalld 2>/dev/null; then
    for p in $(port_list_nft "$SSH_PORTS"); do firewall-cmd --permanent --add-port="$p/tcp" >/dev/null; done
    firewall-cmd --permanent --add-service=http --add-service=https >/dev/null
    if [ "$CALLS" = yes ]; then
      firewall-cmd --permanent --add-port="$TURN_PORT/udp" --add-port="$TURN_PORT/tcp" --add-port="$TURN_MIN_PORT-$TURN_MAX_PORT/udp" >/dev/null
      [ "$MODE" = domain ] && firewall-cmd --permanent --add-port="$TURN_TLS_PORT/tcp" >/dev/null
    fi
    for item in $(port_list_nft "$EXTRA_PORTS"); do port=${item%/*}; proto=tcp; case "$item" in */udp) proto=udp ;; esac; firewall-cmd --permanent --add-port="$port/$proto" >/dev/null; done
    firewall-cmd --reload >/dev/null
    ok "Порты открыты в firewalld"
  fi
}

os_setup_firewall() {
  case "$FIREWALL" in
    none) warn "Файрвол не настраивается (по вашему выбору)"; return 0 ;;
    existing) fw_open_existing; return 0 ;;
  esac
  command -v nft >/dev/null 2>&1 || die "nftables не установлен"
  mkdir -p "$NFT_DIR"
  nft_rules > "$NFT_FILE.new"
  nft -c -f "$NFT_FILE.new" >>"$WS_LOG" 2>&1 || { cat "$NFT_FILE.new"; die "nftables не принял правила (см. выше)."; }
  # Повторный запуск с теми же правилами (обновление) — без проверки доступа.
  if [ -f "$NFT_FILE" ] && fw_has_rules && diff -q <(grep -v '^# Workspace — файрвол' "$NFT_FILE") <(grep -v '^# Workspace — файрвол' "$NFT_FILE.new") >/dev/null 2>&1; then
    rm -f "$NFT_FILE.new"
    ok "Правила файрвола не изменились"
    fw_persist_nft
    return 0
  fi
  mv -f "$NFT_FILE.new" "$NFT_FILE"; chmod 600 "$NFT_FILE"

  local backup was_ufw=no was_firewalld=no rb_pid
  backup=$(mktemp); nft list ruleset > "$backup" 2>/dev/null || true
  if [ "$FIREWALL" = nft-new ]; then
    command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active' && was_ufw=yes
    systemctl is-active --quiet firewalld 2>/dev/null && was_firewalld=yes
    [ "$was_ufw" = yes ] && ufw --force disable >/dev/null 2>&1
    [ "$was_firewalld" = yes ] && systemctl stop firewalld
    [ "$FW_FLUSH" = yes ] && nft flush ruleset
  fi
  nft -f "$NFT_FILE"

  # Страховка: через 120 с вернуть прежние правила, если нет подтверждения.
  ( sleep 120
    nft flush ruleset; nft -f "$backup" 2>/dev/null || true
    [ "$was_firewalld" = yes ] && systemctl start firewalld
    [ "$was_ufw" = yes ] && ufw --force enable
  ) >/dev/null 2>&1 &
  rb_pid=$!
  if fw_wait_confirm 110; then
    kill "$rb_pid" 2>/dev/null || true; wait "$rb_pid" 2>/dev/null || true
    rm -f "$backup"
  else
    info "Возвращаю прежние правила…"
    wait "$rb_pid" 2>/dev/null || true
    rm -f "$backup"
    die "Файрвол откатан: доступ по SSH не подтверждён. Проверьте порты SSH ($SSH_PORTS) и запустите скрипт снова."
  fi
  if [ "$FIREWALL" = nft-new ]; then fw_disable_others; else fw_open_existing; fi
  fw_persist_nft
  ok "Файрвол nftables: таблица inet workspace ($NFT_FILE), загружается при старте системы"
  [ "$FIREWALL" = nft-new ] && ok "Прочие файрволы (ufw, firewalld, iptables-persistent) отключены"
}

# ------------------------------------------------------------------ проверки

os_smoke_services() {
  smoke "Служба workspace-server работает" systemctl is-active --quiet workspace-server
  smoke "Служба workspace-web работает" systemctl is-active --quiet workspace-web
  smoke "nginx работает" systemctl is-active --quiet nginx
  if [ "$CALLS" = yes ]; then smoke "coturn работает" systemctl is-active --quiet coturn; fi
}
fw_has_rules() { nft list table inet workspace 2>/dev/null | grep -q 'dport { 80, 443 }'; }
os_smoke_firewall() {
  case "$FIREWALL" in
    nft-new|nft-add) smoke "Файрвол: правила nftables загружены" fw_has_rules
                     smoke "Файрвол: nftables включится после перезагрузки" systemctl is-enabled --quiet nftables ;;
    existing) ok "Файрвол: порты добавлены в действующий файрвол" ;;
    none) warn "Файрвол не настраивался" ;;
  esac
}
os_smoke_autostart() {
  smoke "Автозапуск после перезагрузки: workspace-server, workspace-web, nginx" \
    sh -c 'systemctl is-enabled --quiet workspace-server && systemctl is-enabled --quiet workspace-web && systemctl is-enabled --quiet nginx'
}
renew_timer_active() { systemctl is-active --quiet "${RENEW_TIMER:-certbot.timer}"; }
os_smoke_renew_timer() { smoke "Автопродление сертификата (${RENEW_TIMER:-certbot})" renew_timer_active; }

os_checklist_commands() {
  echo "  состояние:  systemctl status workspace-server workspace-web nginx$( [ "$CALLS" = yes ] && printf ' coturn')"
  echo "  логи:       journalctl -u workspace-server -u workspace-web -f"
  echo "  перезапуск: systemctl restart workspace-server workspace-web"
  [ "$FIREWALL" = nft-new ] || [ "$FIREWALL" = nft-add ] && echo "  файрвол:    nft list table inet workspace   (правила: $NFT_FILE)"
  [ "$MODE" = domain ] && echo "  сертификат: certbot certificates; проверка продления: certbot renew --dry-run"
  return 0
}
os_reset_password_hint() {
  printf 'cd %s && runuser -u %s -- env HOME=%s/.home npm run admin:reset-password -w apps/server -- %s "НовыйПароль"' "$WS_APP" "$WS_USER" "$WS_PREFIX" "${ADMIN_EMAIL:-email}"
}

# ------------------------------------------------------------------ удаление

os_uninstall() {
  [ -f "$WS_STATE" ] && load_answers "$WS_STATE"
  say ""
  warn "Будут удалены: службы Workspace, сайт в nginx, настройки coturn, правила файрвола Workspace."
  confirm_yes "Удалить Workspace с этого сервера"
  systemctl disable --now workspace-server workspace-web >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/workspace-server.service /etc/systemd/system/workspace-web.service
  systemctl daemon-reload
  ok "Службы удалены"
  os_nginx_remove_site
  nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1 || true
  ok "Сайт в nginx удалён"
  local tconf; tconf=$(os_coturn_conf_path)
  if grep -q 'Workspace' "$tconf" 2>/dev/null; then
    systemctl disable --now coturn >/dev/null 2>&1 || true
    if [ -f "$tconf.orig" ]; then mv -f "$tconf.orig" "$tconf"; else rm -f "$tconf"; fi
    rm -rf /etc/coturn/certs
    ok "coturn остановлен, его конфигурация возвращена"
  fi
  if [ -f "$NFT_FILE" ]; then
    nft delete table inet workspace 2>/dev/null || true
    rm -f "$NFT_FILE"
    local main; main=$(os_nft_main_conf)
    if [ -f "$main.before-workspace" ]; then mv -f "$main.before-workspace" "$main"; else sed -i "\|$NFT_FILE|d" "$main" 2>/dev/null || true; fi
    warn "Правила файрвола Workspace удалены. Если ufw/firewalld отключал установщик — включите нужный файрвол сами."
  fi
  if [ -n "${DOMAIN:-}" ] && [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
    local delcert=no
    ask_yn delcert "Удалить сертификат Let's Encrypt для $DOMAIN?" n
    [ "$delcert" = yes ] && certbot delete --cert-name "$DOMAIN" --non-interactive >/dev/null 2>&1 && ok "Сертификат удалён"
  fi
  rm -f /etc/letsencrypt/renewal-hooks/deploy/workspace.sh
  rm -rf "$WS_RELEASES" "$WS_APP"
  local deldata=no
  say ""
  warn "Данные сотрудников: $WS_STORAGE, настройки: $WS_CONFIG, копии: $WS_BACKUPS"
  ask_yn deldata "Удалить и данные? Это необратимо" n
  if [ "$deldata" = yes ]; then
    local really=""
    tty_print "${C_B}${C_RED}  Для подтверждения напишите DELETE: ${C_OFF}"; tty_read really
    if [ "$really" = DELETE ]; then
      rm -rf "$WS_PREFIX"; userdel "$WS_USER" >/dev/null 2>&1 || true
      ok "Данные и пользователь $WS_USER удалены"
    else warn "Данные сохранены"; fi
  else
    ok "Данные сохранены в $WS_PREFIX — повторная установка подхватит их"
  fi
  ok "Workspace удалён"
}
