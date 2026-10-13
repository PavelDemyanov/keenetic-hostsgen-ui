#!/bin/sh
# Сервер AmneziaWG на VPS для подключения из роутера: Docker-контейнер на образе amneziavpn/amneziawg-go,
# как у приложения Amnezia, только свой (keenetic-awg), чтобы не мешать контейнерам Amnezia.
#
# Запускает помощник роутера (helper/hostsgen-ui.c, vps-start) по SSH: «sh -s» под root, текст скрипта
# приходит на stdin, а перед ним — строки с переменными:
#   PROFILE   3 — AmneziaWG 3.1 (KeeneticOS 5.2 и новее), 1 — AmneziaWG 1.0 (прошивки постарше)
#   SUBNET    первые три октета сети VPN для нового сервера, например 10.77.12 (сервер .1, роутеры .2 и дальше)
#   ENDPOINT  адрес, по которому роутер подключился к серверу (IP или домен), — он же Endpoint в настройках
#
# Строки для роутера начинаются с @@: «@@step КОД ТЕКСТ», «@@error ТЕКСТ», затем «@@conf-begin»,
# настройки подключения в base64 и «@@conf-end», в конце «@@done». Остальной вывод — подробный журнал.
# Повторный запуск на том же сервере ничего не переустанавливает: добавляет ещё одно подключение.

DIR=/opt/keenetic-vpn
CONF=$DIR/awg0.conf
CONTAINER=keenetic-awg
IMAGE=amneziavpn/amneziawg-go:latest
# Специальный мусорный пакет AmneziaWG 1.5+ (I1): ответ DNS про icloud.com, как у Amnezia по умолчанию
I1='<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>'

step() { echo "@@step $*"; }
fail() {
	echo "@@error $*"
	exit 1
}

# Случайное число от $1 до $2 включительно
rnd() { echo $(($(od -An -N4 -tu4 /dev/urandom) % ($2 - $1 + 1) + $1)); }

# Утилита awg из того же образа, что и сервер
awg() { docker run --rm -i --entrypoint awg "$IMAGE" "$@"; }

apt_busy() {
	pgrep -x apt-get >/dev/null || pgrep -x apt >/dev/null || pgrep -x dpkg >/dev/null ||
		pgrep -f /usr/bin/unattended-upgrade >/dev/null
}

# Свежий VPS первые минуты сам ставит обновления и держит блокировку apt
wait_apt() {
	waited=0
	while apt_busy; do
		[ "$waited" = 0 ] && step wait "Жду, пока сервер закончит устанавливать обновления"
		waited=$((waited + 5))
		[ "$waited" -gt 900 ] && fail "сервер уже 15 минут занят обновлениями — попробуйте позже"
		sleep 5
	done
}

check_server() {
	step check "Проверяю сервер"
	[ "$(id -u)" = 0 ] || fail "нужен вход под root"
	case "${PROFILE:-}" in 1 | 3) ;; *) fail "неизвестная версия AmneziaWG: ${PROFILE:-}" ;; esac
	case "${SUBNET:-}" in "" | *[!0-9.]*) fail "неверная сеть VPN: ${SUBNET:-}" ;; esac
	case "${ENDPOINT:-}" in "" | *[!A-Za-z0-9.-]*) fail "неверный адрес сервера: ${ENDPOINT:-}" ;; esac
	# Только Ubuntu: на Debian и других системах VPN, по опыту, не настраивается даже приложением Amnezia
	os=$(. /etc/os-release 2>/dev/null && echo "$ID")
	[ "$os" = ubuntu ] ||
		fail "нужна Ubuntu, а на сервере $(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-другая система}") — переустановите его на Ubuntu 22.04 в панели хостинга"
	case "$(uname -m)" in
		x86_64 | aarch64) ;;
		*) fail "процессор сервера $(uname -m) не поддерживается" ;;
	esac
	[ -c /dev/net/tun ] || fail "на сервере нет /dev/net/tun: это VPS на OpenVZ или LXC, для VPN нужен KVM"
}

# apt-get с выводом в файл на сервере: в журнал роутера — только хвост, если что-то пошло не так
apt_quiet() {
	DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 "$@" >"$DIR/apt.log" 2>&1 && return
	tail -n 20 "$DIR/apt.log"
	return 1
}

install_docker() {
	if ! command -v docker >/dev/null 2>&1; then
		wait_apt
		step docker "Устанавливаю Docker — это пара минут"
		mkdir -p "$DIR" && chmod 700 "$DIR"
		apt_quiet update || fail "не удалось обновить список пакетов (apt-get update)"
		apt_quiet install -y docker.io || fail "не удалось установить Docker"
	fi
	systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1
	docker info >/dev/null 2>&1 || fail "Docker установлен, но не запускается"
	step image "Скачиваю AmneziaWG"
	docker pull -q "$IMAGE" || fail "не удалось скачать образ $IMAGE"
}

# Свободный UDP-порт из 20000–59999
pick_port() {
	used=$(ss -Hlun 2>/dev/null | awk '{ sub(/.*:/, "", $4); print $4 }')
	for _ in 1 2 3 4 5 6 7 8 9 10; do
		port=$(rnd 20000 59999)
		echo "$used" | grep -qx "$port" || {
			echo "$port"
			return
		}
	done
	fail "не нашёл свободный UDP-порт"
}

# Параметры маскировки. 3.1 — как у приложения Amnezia по умолчанию; 1.0 — случайные размеры и заголовки.
awg_params() {
	echo "Jc = $(rnd 4 6)"
	echo "Jmin = 10"
	echo "Jmax = 50"
	if [ "$PROFILE" = 3 ]; then
		printf 'S1 = 12\nS2 = 12\nS3 = 12\nS4 = 12\nH1 = 1\nH2 = 2\nH3 = 3\nH4 = 4\n'
		echo "HeaderProtectionKey = $(awg genkey)"
		printf 'RekeyAfterTime = 100-120\nRekeyTimeout = 3-7\nRejectAfterTime = 150-180\n'
		printf 'KeepaliveTimeout = 5-15\nMaxHandshakeAttempts = 15-20\nRandomTrailers = on\nDisableCookies = on\n'
	else
		# размер начального пакета (148 + S1) не должен совпасть с ответным (92 + S2)
		s1=$(rnd 15 150)
		s2=$(rnd 15 150)
		[ $((s1 + 56)) = "$s2" ] && s2=$((s2 + 1))
		echo "S1 = $s1"
		echo "S2 = $s2"
		used=" "
		for h in H1 H2 H3 H4; do
			value=$(rnd 5 2147483647)
			while [ "${used#* $value }" != "$used" ]; do value=$(rnd 5 2147483647); done
			used="$used$value "
			echo "$h = $value"
		done
	fi
}

new_server() {
	step config "Настраиваю AmneziaWG"
	port=$(pick_port)
	key=$(awg genkey) || fail "не удалось создать ключи AmneziaWG"
	mkdir -p "$DIR" && chmod 700 "$DIR"
	{
		echo "[Interface]"
		echo "PrivateKey = $key"
		echo "Address = $SUBNET.1/24"
		echo "ListenPort = $port"
		awg_params
	} >"$CONF.new" || fail "не удалось записать $CONF"
	echo "$IMAGE" >"$DIR/image"
}

write_start_script() {
	cat >"$DIR/start.sh" <<'EOF'
#!/bin/sh
# Запуск AmneziaWG в контейнере keenetic-awg: интерфейс awg0 и выход клиентов в интернет через NAT.
set -e
awg-quick up /etc/amneziawg/awg0.conf
iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
iptables -A FORWARD -i awg0 -j ACCEPT
iptables -A FORWARD -o awg0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
trap 'awg-quick down /etc/amneziawg/awg0.conf; exit 0' TERM INT
while :; do sleep 3600 & wait $!; done
EOF
	chmod 755 "$DIR/start.sh"
}

# Конфигурация сервера: новая (awg0.conf.new) или действующая; в неё дописывается роутер
add_peer() {
	src=$CONF.new
	[ -f "$src" ] || src=$CONF
	port=$(sed -n 's/^ListenPort *= *//p' "$src")
	SUBNET=$(sed -n 's/^Address *= *\([0-9]*\.[0-9]*\.[0-9]*\)\.1\/.*/\1/p' "$src")
	[ -n "$port" ] && [ -n "$SUBNET" ] || fail "не разобрал настройки сервера в $src"
	last=$(sed -n "s/^AllowedIPs *= *$SUBNET\.\([0-9]*\)\/32.*/\1/p" "$src" | sort -n | tail -1)
	n=$((${last:-1} + 1))
	[ "$n" -le 254 ] || fail "в сети $SUBNET.0/24 закончились адреса"

	client_key=$(awg genkey)
	client_pub=$(echo "$client_key" | awg pubkey)
	psk=$(awg genpsk)
	server_pub=$(sed -n 's/^PrivateKey *= *//p' "$src" | awg pubkey)
	[ -n "$client_pub" ] && [ -n "$server_pub" ] && [ -n "$psk" ] || fail "не удалось создать ключи AmneziaWG"

	[ "$src" = "$CONF" ] && cp "$CONF" "$CONF.bak"
	{
		[ "$src" = "$CONF" ] && cat "$CONF"
		[ "$src" = "$CONF.new" ] && cat "$CONF.new"
		echo
		echo "[Peer]"
		echo "# роутер Keenetic, $(date '+%Y-%m-%d %H:%M')"
		echo "PublicKey = $client_pub"
		echo "PresharedKey = $psk"
		echo "AllowedIPs = $SUBNET.$n/32"
	} >"$CONF.tmp" && mv "$CONF.tmp" "$CONF" && rm -f "$CONF.new" || fail "не удалось записать $CONF"
	chmod 600 "$CONF"

	# Параметры маскировки — общие у сервера и клиентов: всё из [Interface], кроме своих ключей и адресов
	CLIENT_CONF=$(
		echo "[Interface]"
		echo "PrivateKey = $client_key"
		echo "Address = $SUBNET.$n/32"
		sed -n '/^\[Interface\]/,/^\[/{/^\(PrivateKey\|Address\|ListenPort\|\[\)/d;/^ *$/d;p}' "$CONF"
		[ "$PROFILE" = 3 ] && echo "I1 = $I1"
		echo
		echo "[Peer]"
		echo "PublicKey = $server_pub"
		echo "PresharedKey = $psk"
		echo "AllowedIPs = 0.0.0.0/0"
		echo "Endpoint = $ENDPOINT:$port"
		echo "PersistentKeepalive = 25"
	)
}

start_container() {
	step start "Запускаю сервер AmneziaWG"
	if docker inspect "$CONTAINER" >/dev/null 2>&1; then
		docker restart "$CONTAINER" >/dev/null || restore_and_fail "не удалось перезапустить контейнер $CONTAINER"
	else
		docker run -d --name "$CONTAINER" --restart unless-stopped \
			--cap-add NET_ADMIN --device /dev/net/tun --sysctl net.ipv4.ip_forward=1 \
			--log-opt max-size=1m -p "$port:$port/udp" -v "$DIR:/etc/amneziawg" \
			"$IMAGE" /bin/sh /etc/amneziawg/start.sh >/dev/null || restore_and_fail "не удалось запустить контейнер"
	fi
	waited=0
	until docker exec "$CONTAINER" awg show awg0 >/dev/null 2>&1; do
		waited=$((waited + 1))
		if [ "$waited" -gt 20 ]; then
			docker logs --tail 30 "$CONTAINER" 2>&1
			restore_and_fail "AmneziaWG не запустился (журнал контейнера — выше)"
		fi
		sleep 1
	done
	rm -f "$CONF.bak"
	if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
		ufw allow "$port/udp" >/dev/null
	fi
}

# Не удалось запустить с новым роутером — вернуть прежние настройки, чтобы не сломать уже работающие
restore_and_fail() {
	if [ -f "$CONF.bak" ]; then
		mv "$CONF.bak" "$CONF"
		docker restart "$CONTAINER" >/dev/null 2>&1
	fi
	fail "$*"
}

main() {
	check_server
	install_docker
	if [ -f "$CONF" ]; then
		step config "Сервер уже настроен, добавляю ещё одно подключение"
		if grep -q '^HeaderProtectionKey' "$CONF"; then have=3; else have=1; fi
		[ "$have" = 3 ] && [ "$PROFILE" = 1 ] &&
			fail "сервер уже работает на AmneziaWG 3.1, а прошивка этого роутера её не поддерживает — обновите KeeneticOS до 5.2"
		PROFILE=$have
	else
		new_server
	fi
	write_start_script
	add_peer
	start_container
	step done "Сервер готов"
	echo "@@conf-begin"
	printf '%s\n' "$CLIENT_CONF" | base64
	echo "@@conf-end"
	echo "@@done"
}

# Команды не должны читать stdin: из него sh -s дочитывает сам скрипт
main </dev/null
