#!/bin/bash
# Выкладка собранного hostsgen-ui (./build.sh) на роутер, где уже есть Entware и вход по SSH.
# Для роутеров без Entware — архив dist/install/hostsgen-ui.tar.gz и инструкция в README.md.
#   ./deploy.sh            — выложить dist/pkg и перевстроить модуль
#   ./deploy.sh status     — встроен ли модуль сейчас
#   ./deploy.sh uninstall  — вернуть родной интерфейс и удалить файлы с роутера
set -euo pipefail
cd "$(dirname "$0")"

ROUTER=${ROUTER:-root@192.168.0.1}
PORT=${PORT:-222}
ssh_router() { ssh -o BatchMode=yes -p "$PORT" "$ROUTER" "$@"; }

case "${1:-deploy}" in
	deploy)
		[ -f dist/install/hostsgen-ui.tar.gz ] || { echo "сначала ./build.sh" >&2; exit 1; }
		# etc/initrc из архива не кладём: на роутере с Entware сценарий запуска — его rc.unslung
		ssh_router 'set -e; t=$(mktemp -d); tar -xzf - -C "$t"; mkdir -p /opt/share/hostsgen-ui;
			cp -r "$t"/share/hostsgen-ui/. /opt/share/hostsgen-ui/; cp "$t"/etc/init.d/S99hostsgen-ui /opt/etc/init.d/;
			rm -rf "$t" /opt/share/hostsgen-ui/resolve.sh' <dist/install/hostsgen-ui.tar.gz
		ssh_router '/opt/etc/init.d/S99hostsgen-ui restart'
		;;
	status)
		ssh_router '/opt/etc/init.d/S99hostsgen-ui status'
		;;
	uninstall)
		ssh_router '/opt/etc/init.d/S99hostsgen-ui stop; rm -f /opt/etc/init.d/S99hostsgen-ui; rm -rf /opt/share/hostsgen-ui'
		;;
	*)
		echo "Использование: $0 [deploy|status|uninstall]" >&2
		exit 1
		;;
esac
