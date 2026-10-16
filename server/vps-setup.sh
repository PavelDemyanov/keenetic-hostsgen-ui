#!/bin/sh
# Сервер AmneziaWG на VPS для подключения из роутера: Docker-контейнер на образе amneziavpn/amneziawg-go,
# как у приложения Amnezia, только свой (keenetic-awg), чтобы не мешать контейнерам Amnezia.
#
# Запускает помощник роутера (helper/hostsgen-ui.c, vps-start) по SSH: «sh -s» под root, текст скрипта
# приходит на stdin, а перед ним — строки с переменными:
#   PROFILE   3 — AmneziaWG 3.1 (KeeneticOS 5.2 и новее), 1 — AmneziaWG 1.0 (прошивки постарше)
#   SUBNET    первые три октета сети VPN для нового сервера, например 10.77.12 (сервер .1, роутеры .2 и дальше)
#   ENDPOINT  адрес, по которому роутер подключился к серверу (IP или домен), — он же Endpoint в настройках
#   OPTIONS   необязательно: настройки из раздела «Для опытных» — строки «Параметр = значение» в base64
#
# Строки для роутера начинаются с @@: «@@step КОД ТЕКСТ», «@@error ТЕКСТ», затем «@@conf-begin»,
# настройки подключения в base64 и «@@conf-end», в конце «@@done». Остальной вывод — подробный журнал.
# Повторный запуск на том же сервере ничего не переустанавливает: добавляет ещё одно подключение.
#
# Параметры маскировки AmneziaWG бывают двух видов — так их разбирает amneziawg-go (device/receive.go, send.go):
#  - общие: по ним приёмник опознаёт пакеты, поэтому у сервера и всех его роутеров они одни и те же —
#    S1–S4, H1–H4, HeaderProtectionKey, RandomTrailers. Выбираются случайно, когда сервер настраивается впервые;
#  - свои у каждой стороны: мусорные и сигнатурные пакеты перед рукопожатием (Jc, Jmin, Jmax, I1–I5), добивка
#    пакетов данных (ContentPaddingAddition) и таймеры — получатель о них ничего не знает. Каждый роутер получает
#    свои случайные значения, и подключения разных роутеров к одному серверу не похожи друг на друга.

DIR=/opt/keenetic-vpn
CONF=$DIR/awg0.conf
CONTAINER=keenetic-awg
IMAGE=amneziavpn/amneziawg-go:latest
# Домены для маскировки первого пакета под DNS-запрос
DNS_NAMES='ya.ru yandex.ru vk.com mail.ru ok.ru dzen.ru avito.ru ozon.ru wildberries.ru gosuslugi.ru rutube.ru
kinopoisk.ru 2gis.ru hh.ru lenta.ru ria.ru rbc.ru habr.com google.com youtube.com apple.com icloud.com
microsoft.com github.com wikipedia.org cloudflare.com telegram.org whatsapp.com'

step() { echo "@@step $*"; }
fail() {
	echo "@@error $*"
	exit 1
}
# Строка в подробный журнал — и из функций, вывод которых собирается в переменную
note() { echo "$*" >&2; }

# Случайное число от $1 до $2 включительно
rnd() { echo $(($(od -An -N4 -tu4 /dev/urandom) % ($2 - $1 + 1) + $1)); }
# Случайный из аргументов
pick() {
	shift "$(rnd 0 $(($# - 1)))"
	echo "$1"
}
# $1 случайных байт в hex
rhex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }

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

is_number() {
	case $1 in '' | *[!0-9]*) return 1 ;; esac
	[ ${#1} -le 10 ]
}
# «N» или «N-M», N ≤ M
is_range() { is_number "${1%-*}" && is_number "${1#*-}" && [ "${1%-*}" -le "${1#*-}" ]; }
# Цепочка тегов I1–I5: <b 0x…>, <r N>, <rd N>, <rc N>, <t>; счётчик <c> прошивка Keenetic не принимает
is_chain() { printf '%s\n' "$1" | grep -Eqx '(<(b 0x([0-9a-fA-F]{2})+|r [0-9]{1,4}|rd [0-9]{1,4}|rc [0-9]{1,4}|t)>)+'; }

# Настройки «Для опытных». Роутер их уже проверил; здесь — белый список параметров и формат значений,
# чтобы в конфигурацию не попало ничего, кроме чисел, диапазонов и тегов AmneziaWG.
read_options() {
	OPTS=
	[ -n "${OPTIONS:-}" ] || return 0
	text=$(printf '%s' "$OPTIONS" | base64 -d 2>/dev/null) || fail "не разобрал настройки «Для опытных»"
	while IFS= read -r line; do
		[ -n "$line" ] || continue
		key=${line%% = *}
		value=${line#* = }
		case $key in
			Mask) case $value in dns | noise | off) ;; *) value= ;; esac ;;
			ListenPort | Jc | Jmin | Jmax | S1 | S2 | S3 | S4 | PersistentKeepalive | MTU)
				is_number "$value" || value= ;;
			H1 | H2 | H3 | H4 | ContentPaddingAddition | RekeyAfterTime | RekeyTimeout | RejectAfterTime | \
				KeepaliveTimeout | MaxHandshakeAttempts) is_range "$value" || value= ;;
			I1 | I2 | I3 | I4 | I5) is_chain "$value" || value= ;;
			*) value= ;;
		esac
		[ "$key" != "$line" ] && [ -n "$value" ] || fail "неверная строка в настройках «Для опытных»: $line"
		OPTS="$OPTS$key = $value
"
	done <<END
$text
END
}

# Значение настройки «Для опытных»; если её не задали — код возврата 1
opt() {
	value=$(printf '%s' "$OPTS" | sed -n "s/^$1 = //p" | tail -n 1)
	[ -n "$value" ] && echo "$value"
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

# UDP-порт сервера: заданный в «Для опытных» или случайный свободный из 20000–59999
pick_port() {
	used=$(ss -Hlun 2>/dev/null | awk '{ sub(/.*:/, "", $4); print $4 }')
	if port=$(opt ListenPort); then
		echo "$used" | grep -qx "$port" && fail "UDP-порт $port на сервере уже занят — выберите другой"
		return 0
	fi
	for _ in 1 2 3 4 5 6 7 8 9 10; do
		port=$(rnd 20000 59999)
		echo "$used" | grep -qx "$port" || return 0
	done
	fail "не нашёл свободный UDP-порт"
}

# Длины пакетов разных типов — 148+S1, 92+S2, 64+S3, 32+S4 — не должны совпадать: по длине приёмник
# отличает рукопожатие от данных
sizes_differ() {
	set -- $((148 + s1)) $((92 + s2)) ${s3:+$((64 + s3))} ${s4:+$((32 + s4))}
	[ $(printf '%s\n' "$@" | sort -u | wc -l) -eq $# ]
}

# Общие параметры нового сервера: s1…s4, h1…h4
pick_shared() {
	tries=0
	while :; do
		if [ "$PROFILE" = 3 ]; then
			# Защита заголовков берёт nonce из первых 12 байт добивки — отсюда S от 12. S4 добавляется к каждому
			# пакету данных: с ней до 20 байт пакет из туннеля с MTU 1420 ещё помещается в 1500
			s1=$(opt S1 || rnd 12 96)
			s2=$(opt S2 || rnd 12 96)
			s3=$(opt S3 || rnd 12 64)
			s4=$(opt S4 || rnd 12 20)
		else
			s1=$(opt S1 || rnd 15 150)
			s2=$(opt S2 || rnd 15 150)
			s3= s4=
		fi
		sizes_differ && break
		tries=$((tries + 1))
		[ "$tries" -lt 20 ] || fail "у пакетов разных типов совпадают длины — поменяйте S1–S4"
	done
	if [ "$PROFILE" = 3 ]; then
		# Тип пакета и так зашифрован защитой заголовков — заголовки обычные, 1–4, как у Amnezia
		h1=$(opt H1 || echo 1) h2=$(opt H2 || echo 2) h3=$(opt H3 || echo 3) h4=$(opt H4 || echo 4)
	else
		# AmneziaWG 1.0: случайные несовпадающие заголовки вместо 1–4 у WireGuard
		used=" $(opt H1) $(opt H2) $(opt H3) $(opt H4) "
		for n in 1 2 3 4; do
			value=$(opt "H$n") || {
				value=$(rnd 5 2147483647)
				while [ "${used#* $value }" != "$used" ]; do value=$(rnd 5 2147483647); done
				used="$used$value "
			}
			eval "h$n=\$value"
		done
	fi
}

# Мусорные пакеты перед рукопожатием: сколько и какой длины
junk_params() {
	jc=$(opt Jc || rnd 4 7)
	jmin=$(opt Jmin || rnd 12 48)
	jmax=$(opt Jmax || echo $((jmin + $(rnd 64 200))))
	[ "$jmin" -le "$jmax" ] || jmin=$jmax
	echo "Jc = $jc"
	echo "Jmin = $jmin"
	echo "Jmax = $jmax"
}

# Домен в виде меток DNS (hex)
dns_name() {
	for label in $(echo "$1" | tr . ' '); do
		printf '%02x' ${#label}
		printf '%s' "$label" | od -An -tx1 | tr -d ' \n'
	done
	printf 00
}

# I1 — пакет перед каждым рукопожатием. dns — DNS-запрос, как у Amnezia, только у каждого роутера свой:
# случайный ID (<r 2>), флаги «нужна рекурсия» (у части — ещё AD, как у dig), вопрос A, AAAA или HTTPS
# о популярном домене и у части — EDNS, иногда с cookie клиента. noise — случайные байты, off — без пакета.
mask_packet() {
	case $1 in
		off)
			note "I1: без маскировки первого пакета"
			return 0
			;;
		noise)
			size=$(rnd 48 96)
			note "I1: $size случайных байт"
			echo "<r $size>"
			return 0
			;;
	esac
	name=$(pick $DNS_NAMES)
	qtype=$(pick A AAAA HTTPS)
	case $qtype in A) qcode=0001 ;; AAAA) qcode=001c ;; *) qcode=0041 ;; esac
	# Запись EDNS (OPT) — у двух роутеров из трёх: корень, тип 41, размер UDP 1232/1200/4096, расширенный код
	# и версия, флаг DO; данные — пусто или cookie клиента (у настоящих клиентов она тоже постоянная)
	ar=0 rr=
	if [ "$(rnd 0 2)" != 0 ]; then
		ar=1
		rr=000029$(pick 04d0 04b0 1000)0000$(pick 0000 8000)
		if [ "$(rnd 0 1)" = 1 ]; then rr=${rr}000c000a0008$(rhex 8); else rr=${rr}0000; fi
	fi
	note "I1: DNS-запрос $qtype $name"
	# ID запроса, флаги, один вопрос, ответов и NS нет, дополнительных — 0 или 1; вопрос; EDNS
	echo "<r 2><b 0x$(pick 0100 0120)000100000000000$ar$(dns_name "$name")${qcode}0001$rr>"
}

# Свои параметры роутера: случайные у каждого, если не заданы в «Для опытных»
client_params() {
	junk_params
	[ "$PROFILE" = 3 ] || return 0
	i1=$(opt I1) || i1=$(mask_packet "$(opt Mask || echo dns)")
	[ -z "$i1" ] || echo "I1 = $i1"
	for key in I2 I3 I4 I5 ContentPaddingAddition; do
		value=$(opt $key) && echo "$key = $value"
	done
	# Таймеры — около значений Amnezia, но у каждого роутера свои. Роутер меняет ключи не реже чем через
	# 120 с (RekeyAfterTime), а сервер отвергает их через 150–180 с — с запасом на повторы рукопожатия
	a=$(rnd 95 110) b=$(rnd 3 5) c=$(rnd 150 165) d=$(rnd 5 9) e=$(rnd 14 18)
	echo "RekeyAfterTime = $(opt RekeyAfterTime || echo "$a-$((a + $(rnd 5 10)))")"
	echo "RekeyTimeout = $(opt RekeyTimeout || echo "$b-$((b + $(rnd 2 4)))")"
	echo "RejectAfterTime = $(opt RejectAfterTime || echo "$c-$((c + $(rnd 10 25)))")"
	echo "KeepaliveTimeout = $(opt KeepaliveTimeout || echo "$d-$((d + $(rnd 5 9)))")"
	echo "MaxHandshakeAttempts = $(opt MaxHandshakeAttempts || echo "$e-$((e + $(rnd 2 5)))")"
	echo "DisableCookies = on"
}

new_server() {
	step config "Настраиваю AmneziaWG"
	pick_port
	pick_shared
	key=$(awg genkey) || fail "не удалось создать ключи AmneziaWG"
	if [ "$PROFILE" = 3 ]; then
		hpk=$(awg genkey) || fail "не удалось создать ключи AmneziaWG"
	fi
	mkdir -p "$DIR" && chmod 700 "$DIR"
	{
		echo "[Interface]"
		echo "PrivateKey = $key"
		echo "Address = $SUBNET.1/24"
		echo "ListenPort = $port"
		# S4 больше 20 — пакет из туннеля с MTU 1420 уже не помещается в 1500, уменьшаем MTU
		if [ "${s4:-0}" -gt 20 ]; then echo "MTU = $((1440 - s4))"; fi
		# свои мусорные пакеты сервера — для рукопожатий, которые начинает он сам; «Для опытных» — роутеру
		(OPTS= && junk_params)
		echo "S1 = $s1"
		echo "S2 = $s2"
		if [ "$PROFILE" = 3 ]; then
			echo "S3 = $s3"
			echo "S4 = $s4"
		fi
		echo "H1 = $h1"
		echo "H2 = $h2"
		echo "H3 = $h3"
		echo "H4 = $h4"
		if [ "$PROFILE" = 3 ]; then
			echo "HeaderProtectionKey = $hpk"
			printf 'RekeyAfterTime = 100-120\nRekeyTimeout = 3-7\nRejectAfterTime = 150-180\n'
			printf 'KeepaliveTimeout = 5-15\nMaxHandshakeAttempts = 15-20\nRandomTrailers = on\nDisableCookies = on\n'
		fi
	} >"$CONF.new" || fail "не удалось записать $CONF"
	echo "$IMAGE" >"$DIR/image"
	note "Общие параметры сервера: порт $port, S1 $s1, S2 $s2${s3:+, S3 $s3, S4 $s4}, H1–H4 $h1 $h2 $h3 $h4"
}

write_start_script() {
	cat >"$DIR/start.sh" <<'END'
#!/bin/sh
# Запуск AmneziaWG в контейнере keenetic-awg: интерфейс awg0 и выход клиентов в интернет через NAT.
set -e
awg-quick up /etc/amneziawg/awg0.conf
iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE
iptables -A FORWARD -i awg0 -j ACCEPT
iptables -A FORWARD -o awg0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
trap 'awg-quick down /etc/amneziawg/awg0.conf; exit 0' TERM INT
while :; do sleep 3600 & wait $!; done
END
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
		cat "$src"
		echo
		echo "[Peer]"
		echo "# роутер Keenetic, $(date '+%Y-%m-%d %H:%M')"
		echo "PublicKey = $client_pub"
		echo "PresharedKey = $psk"
		echo "AllowedIPs = $SUBNET.$n/32"
	} >"$CONF.tmp" && mv "$CONF.tmp" "$CONF" && rm -f "$CONF.new" || fail "не удалось записать $CONF"
	chmod 600 "$CONF"

	# Общие параметры — с сервера, свои — новые для этого роутера
	shared=$(grep -E '^(S[1-4]|H[1-4]|HeaderProtectionKey|RandomTrailers) *=' "$CONF" | sed 's/ *= */ = /')
	own=$(client_params)
	keepalive=$(opt PersistentKeepalive || rnd 20 30)
	note "Свои параметры роутера: $(echo "$own" | grep -E '^J' | tr '\n' ' ')PersistentKeepalive = $keepalive"
	CLIENT_CONF=$(
		echo "[Interface]"
		echo "PrivateKey = $client_key"
		echo "Address = $SUBNET.$n/32"
		mtu=$(opt MTU) && echo "MTU = $mtu"
		echo "$shared"
		echo "$own"
		echo
		echo "[Peer]"
		echo "PublicKey = $server_pub"
		echo "PresharedKey = $psk"
		echo "AllowedIPs = 0.0.0.0/0"
		echo "Endpoint = $ENDPOINT:$port"
		echo "PersistentKeepalive = $keepalive"
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
	read_options
	install_docker
	if [ -f "$CONF" ]; then
		step config "Сервер уже настроен, добавляю ещё одно подключение"
		if grep -q '^HeaderProtectionKey' "$CONF"; then have=3; else have=1; fi
		[ "$have" = 3 ] && [ "$PROFILE" = 1 ] &&
			fail "сервер уже работает на AmneziaWG 3.1, а прошивка этого роутера её не поддерживает — обновите KeeneticOS до 5.2"
		PROFILE=$have
		if echo "$OPTS" | grep -Eq '^(ListenPort|S[1-4]|H[1-4]) '; then
			step shared "Порт, S1–S4 и H1–H4 остаются прежними: они общие для всех роутеров этого сервера"
		fi
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

# Тесты (tests/vps-setup.test.js) подключают сценарий с VPS_SETUP_TEST=1 и вызывают функции по отдельности.
# Команды не должны читать stdin: из него sh -s дочитывает сам скрипт.
[ -n "${VPS_SETUP_TEST:-}" ] || main </dev/null
