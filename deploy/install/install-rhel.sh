#!/usr/bin/env bash
# Workspace — установка на RHEL / Rocky Linux / AlmaLinux / Oracle Linux 8, 9, 10.
#
#   sudo bash deploy/install/install-rhel.sh            # установка или обновление
#   sudo bash deploy/install/install-rhel.sh --help     # параметры
#
# certbot и coturn берутся из EPEL; SELinux остаётся включённым — нужные
# разрешения (nginx → приложение, метки файлов) выставляются здесь.

WS_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$WS_SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/linux.sh
. "$WS_SCRIPT_DIR/lib/linux.sh"

RHEL_MAJOR=""

dnf_install() { dnf install -y -q "$@" >>"$WS_LOG" 2>&1; }
rpm_installed() { rpm -q "$1" >/dev/null 2>&1; }

os_check_supported() {
  . /etc/os-release
  RHEL_MAJOR=${VERSION_ID%%.*}
  case "$ID" in rhel|rocky|almalinux|ol|centos) ;; *)
    case " ${ID_LIKE:-} " in *" rhel "*|*" centos "*|*" fedora "*) ;; *) die "Этот скрипт — для RHEL и совместимых. У вас: $PRETTY_NAME" ;; esac ;;
  esac
  case "$(uname -m)" in x86_64|aarch64) ;; *) die "Архитектура $(uname -m) не поддерживается (нужна x86_64 или aarch64)." ;; esac
  case "$RHEL_MAJOR" in
    8|9|10) ok "$PRETTY_NAME, $(uname -m)" ;;
    *) warn "$PRETTY_NAME не проверялась (проверены 8, 9, 10)."
       local go=no; ask_yn go "Продолжить на свой страх и риск?" n
       [ "$go" = yes ] || die "Установка отменена." ;;
  esac
  if command -v getenforce >/dev/null 2>&1; then info "SELinux: $(getenforce)"; fi
}

os_install_base_tools() {
  local need="" p
  for p in curl ca-certificates openssl unzip tar git iproute util-linux chrony dnf-plugins-core; do rpm_installed "$p" || need="$need $p"; done
  command -v dig >/dev/null 2>&1 || need="$need bind-utils"
  command -v semanage >/dev/null 2>&1 || need="$need policycoreutils-python-utils"
  if [ -n "$need" ]; then
    info "Ставлю утилиты:$need"
    # shellcheck disable=SC2086
    dnf_install $need || die "Не удалось установить:$need"
  fi
  systemctl enable --now chronyd >/dev/null 2>&1 || true
  ok "Базовые утилиты есть"
}

enable_epel() {
  if rpm_installed epel-release; then return 0; fi
  info "Подключаю EPEL (там certbot и coturn)"
  . /etc/os-release
  if [ "$ID" = rhel ]; then
    subscription-manager repos --enable "codeready-builder-for-rhel-$RHEL_MAJOR-$(uname -m)-rpms" >>"$WS_LOG" 2>&1 || true
    dnf_install "https://dl.fedoraproject.org/pub/epel/epel-release-latest-$RHEL_MAJOR.noarch.rpm" || die "Не удалось подключить EPEL"
  else
    dnf_install epel-release || die "Не удалось подключить EPEL"
    if [ "$RHEL_MAJOR" = 8 ]; then dnf config-manager --set-enabled powertools >>"$WS_LOG" 2>&1 || true
    else dnf config-manager --set-enabled crb >>"$WS_LOG" 2>&1 || true; fi
  fi
}

os_install_packages() {
  enable_epel
  local list="nginx certbot"
  case "$FIREWALL" in nft-new|nft-add) list="$list nftables" ;; esac
  [ "$CALLS" = yes ] && list="$list coturn"
  info "Ставлю: $list"
  # shellcheck disable=SC2086
  dnf_install $list || die "Не удалось установить пакеты: $list (журнал: $WS_LOG)"
  mkdir -p /etc/nginx/conf.d
  os_selinux_nginx
  ok "Пакеты установлены: $list"
}

node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

os_install_node() {
  local cur; cur=$(node_major)
  if [ "$cur" -ge 20 ]; then ok "Node.js $(node -v) уже установлен"; return 0; fi
  info "Ставлю Node.js $NODE_MAJOR LTS"
  if [ "$RHEL_MAJOR" != 10 ] && dnf module list nodejs 2>/dev/null | grep -Eq "^nodejs +$NODE_MAJOR "; then
    dnf module reset -y -q nodejs >>"$WS_LOG" 2>&1 || true
    dnf module enable -y -q "nodejs:$NODE_MAJOR" >>"$WS_LOG" 2>&1
    dnf_install nodejs npm || die "Не удалось установить Node.js из модуля nodejs:$NODE_MAJOR"
  else
    cat > /etc/yum.repos.d/nodesource-nodejs.repo <<EOF
[nodesource-nodejs]
name=Node.js $NODE_MAJOR (NodeSource)
baseurl=https://rpm.nodesource.com/pub_${NODE_MAJOR}.x/nodistro/nodejs/\$basearch
enabled=1
gpgcheck=1
gpgkey=https://rpm.nodesource.com/gpgkey/ns-operations-public.key
module_hotfixes=1
EOF
    dnf_install nodejs || die "Не удалось установить Node.js $NODE_MAJOR из NodeSource"
  fi
  [ "$(node_major)" -ge 20 ] || die "Установился Node.js $(node -v 2>/dev/null) — нужен 20 или новее."
  ok "Node.js $(node -v), npm $(npm -v)"
}

os_nginx_site_path() { printf '/etc/nginx/conf.d/workspace.conf'; }
os_nginx_remove_site() { rm -f /etc/nginx/conf.d/workspace.conf; }
os_coturn_conf_path() { mkdir -p /etc/coturn; printf '/etc/coturn/turnserver.conf'; }
os_coturn_default_user() { printf 'coturn'; }
os_nft_main_conf() { printf '/etc/sysconfig/nftables.conf'; }

selinux_on() { command -v getenforce >/dev/null 2>&1 && [ "$(getenforce)" != Disabled ]; }

os_selinux_nginx() {
  selinux_on || return 0
  # nginx проксирует на приложение (127.0.0.1:3000/4000) — без этого SELinux отвечает 502.
  setsebool -P httpd_can_network_connect 1 >>"$WS_LOG" 2>&1 || warn "Не удалось включить httpd_can_network_connect"
  mkdir -p /var/www/certbot
  restorecon -R /var/www/certbot >/dev/null 2>&1 || true
  ok "SELinux: nginx разрешено проксировать на приложение"
}
os_selinux_relabel() { selinux_on && restorecon -R "$1" >/dev/null 2>&1 || true; }
os_selinux_coturn() {
  selinux_on || return 0
  restorecon -R /etc/coturn >/dev/null 2>&1 || true
  # Нестандартные порты TURN нужно разрешить в политике.
  local p
  for p in "$TURN_PORT" "$TURN_TLS_PORT"; do
    case "$p" in 3478|5349) continue ;; esac
    semanage port -a -t turn_port_t -p tcp "$p" >>"$WS_LOG" 2>&1 || semanage port -m -t turn_port_t -p tcp "$p" >>"$WS_LOG" 2>&1 || true
    semanage port -a -t turn_port_t -p udp "$p" >>"$WS_LOG" 2>&1 || semanage port -m -t turn_port_t -p udp "$p" >>"$WS_LOG" 2>&1 || true
  done
}

ws_main "$@"
