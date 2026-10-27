#!/usr/bin/env bash
# Workspace — установка на Debian 11/12/13 и Ubuntu 20.04/22.04/24.04 (и новее).
#
#   sudo bash deploy/install/install-debian.sh            # установка или обновление
#   sudo bash deploy/install/install-debian.sh --help     # параметры
#
# Обычно запускается через deploy/install/install.sh, который сам выбирает скрипт под ОС.

WS_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh
. "$WS_SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/linux.sh
. "$WS_SCRIPT_DIR/lib/linux.sh"

export DEBIAN_FRONTEND=noninteractive
APT_UPDATED=no

apt_update() { [ "$APT_UPDATED" = yes ] || { apt-get update -qq >>"$WS_LOG" 2>&1; APT_UPDATED=yes; }; }
apt_install() { apt_update; apt-get install -y -qq --no-install-recommends "$@" >>"$WS_LOG" 2>&1; }
pkg_installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed'; }

os_check_supported() {
  . /etc/os-release
  local ok_ver=no
  case "$ID:${VERSION_ID:-}" in
    debian:11|debian:12|debian:13) ok_ver=yes ;;
    ubuntu:20.04|ubuntu:22.04|ubuntu:24.04|ubuntu:25.*|ubuntu:26.*) ok_ver=yes ;;
  esac
  case "$(uname -m)" in x86_64|aarch64) ;; *) die "Архитектура $(uname -m) не поддерживается (нужна x86_64 или aarch64)." ;; esac
  if [ "$ok_ver" = yes ]; then ok "$PRETTY_NAME, $(uname -m)"; else
    warn "$PRETTY_NAME не проверялась с этим установщиком (проверены Debian 11–13, Ubuntu 20.04–24.04)."
    local go=no; ask_yn go "Продолжить на свой страх и риск?" n
    [ "$go" = yes ] || die "Установка отменена."
  fi
}

os_install_base_tools() {
  local need="" p
  for p in curl ca-certificates openssl gnupg unzip tar git iproute2 util-linux; do pkg_installed "$p" || need="$need $p"; done
  if ! command -v dig >/dev/null 2>&1; then
    apt_update
    if apt-cache show bind9-dnsutils >/dev/null 2>&1; then need="$need bind9-dnsutils"; else need="$need dnsutils"; fi
  fi
  if ! pkg_installed systemd-timesyncd && ! pkg_installed chrony && ! pkg_installed ntpsec && ! pkg_installed ntp; then need="$need systemd-timesyncd"; fi
  if [ -n "$need" ]; then
    info "Ставлю утилиты:$need"
    # shellcheck disable=SC2086
    apt_install $need || die "Не удалось установить:$need (журнал: $WS_LOG)"
  fi
  ok "Базовые утилиты есть"
}

os_install_packages() {
  local list="nginx certbot"
  case "$FIREWALL" in nft-new|nft-add) list="$list nftables" ;; esac
  [ "$CALLS" = yes ] && list="$list coturn"
  info "Ставлю: $list"
  # shellcheck disable=SC2086
  apt_install $list || die "Не удалось установить пакеты: $list (журнал: $WS_LOG)"
  # Стандартный сайт nginx (default_server на 80) мешает — убираем ссылку, сам файл остаётся.
  if [ -L /etc/nginx/sites-enabled/default ]; then rm -f /etc/nginx/sites-enabled/default; info "Отключён стандартный сайт nginx (sites-enabled/default)"; fi
  mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
  ln -sfn /etc/nginx/sites-available/workspace.conf /etc/nginx/sites-enabled/workspace.conf
  ok "Пакеты установлены: $list"
}

node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

os_install_node() {
  local cur; cur=$(node_major)
  if [ "$cur" -ge 20 ]; then ok "Node.js $(node -v) уже установлен"; return 0; fi
  info "Ставлю Node.js $NODE_MAJOR LTS из репозитория NodeSource"
  # npm из дистрибутива конфликтует с nodejs из NodeSource (там npm уже внутри).
  pkg_installed npm && apt-get remove -y -qq npm >>"$WS_LOG" 2>&1 || true
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  printf 'Package: nodejs\nPin: origin deb.nodesource.com\nPin-Priority: 600\n' > /etc/apt/preferences.d/nodesource
  APT_UPDATED=no
  apt_install nodejs || die "Не удалось установить Node.js $NODE_MAJOR"
  ok "Node.js $(node -v), npm $(npm -v)"
}

os_nginx_site_path() { printf '/etc/nginx/sites-available/workspace.conf'; }
os_nginx_remove_site() { rm -f /etc/nginx/sites-enabled/workspace.conf /etc/nginx/sites-available/workspace.conf; }
os_coturn_conf_path() { printf '/etc/turnserver.conf'; }
os_coturn_default_user() { printf 'turnserver'; }
os_nft_main_conf() { printf '/etc/nftables.conf'; }

# SELinux на Debian/Ubuntu обычно нет; AppArmor nginx/coturn не мешает.
os_selinux_relabel() { :; }
os_selinux_coturn() { :; }

ws_main "$@"
