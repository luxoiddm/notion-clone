#!/usr/bin/env bash
# Workspace — установщик: определяет систему и запускает нужный скрипт.
#
#   sudo bash deploy/install/install.sh             # установка или обновление
#   sudo bash deploy/install/install.sh --uninstall # удаление (данные — по отдельному подтверждению)
#   sudo bash deploy/install/install.sh --help
#
# Windows: deploy\install\install-windows.cmd
set -e
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
case "$(uname -s)" in
  Darwin) exec /bin/bash "$DIR/install-macos.sh" "$@" ;;
  Linux)
    [ -r /etc/os-release ] || { echo "Не удалось определить дистрибутив (/etc/os-release)." >&2; exit 1; }
    . /etc/os-release
    case " $ID ${ID_LIKE:-} " in
      *" debian "*|*" ubuntu "*) exec bash "$DIR/install-debian.sh" "$@" ;;
      *" rhel "*|*" centos "*|*" fedora "*|*" rocky "*|*" almalinux "*|*" ol "*) exec bash "$DIR/install-rhel.sh" "$@" ;;
      *) echo "Дистрибутив $PRETTY_NAME не поддерживается. Поддерживаются Debian/Ubuntu и RHEL/Rocky/AlmaLinux." >&2; exit 1 ;;
    esac ;;
  *) echo "Система $(uname -s) не поддерживается. Для Windows — deploy\\install\\install-windows.cmd" >&2; exit 1 ;;
esac
