#!/bin/sh
# Сервер AmneziaWG на VPS для подключения из роутера: Docker-контейнер на образе amneziavpn/amneziawg-go,
# как у приложения Amnezia, только свой (keenetic-awg), чтобы не мешать контейнерам Amnezia.
#
# Запускает помощник роутера (helper/hostsgen-ui.c, vps-start) по SSH: «sh -s» под root, текст скрипта
# приходит на stdin, а перед ним — строки с переменными:
#   PROFILE   какую AmneziaWG понимает роутер: 3 — 3.1 (KeeneticOS 5.2 Alpha 11 и новее), 2 — 2.0 (с 5.1 Alpha 3),
#             1 — 1.0 (прошивки постарше)
#   SUBNET    первые три октета сети VPN для нового сервера, например 10.77.12 (сервер .1, роутеры .2 и дальше)
#   ENDPOINT  адрес, по которому роутер подключился к серверу (IP или домен), — он же Endpoint в настройках
#   OPTIONS   необязательно: настройки из раздела «Для опытных» — строки «Параметр = значение» в base64
#   MODE      пусто — подключить роутер (и настроить сервер, если он новый). Остальное — для уже настроенного
#             сервера, PROFILE, SUBNET и OPTIONS тогда не нужны: list — показать его подключения, device —
#             добавить устройство (телефон, компьютер) с именем NAME (base64), remove — удалить подключение
#             с открытым ключом PEER
#
# Строки для роутера начинаются с @@: «@@step КОД ТЕКСТ», «@@warn ТЕКСТ» (предупреждение, настройка идёт
# дальше), «@@error ТЕКСТ», затем «@@conf-begin», настройки подключения в base64 и «@@conf-end», в конце
# «@@done». list, device и remove перед @@done выдают «@@server ВЕРСИЯ ПОРТ», «@@now ВРЕМЯ» и по строке
# «@@peer КЛЮЧ АДРЕС РУКОПОЖАТИЕ ПРИНЯТО ОТПРАВЛЕНО ПОДПИСЬ» на подключение (время — секунды Unix, подпись —
# комментарий из конфигурации в base64 или «-»). Остальной вывод — подробный журнал.
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
# Устройству, в отличие от роутера, DNS нужен в настройках подключения — как у Amnezia (1.1.1.1 и 1.0.0.1), —
# и MTU пониже: его приложения на телефонах ставят 1280, в мобильных сетях пакеты крупнее теряются
DEVICE_DNS='1.1.1.1, 1.0.0.1'
DEVICE_MTU=1280

# printf, а не echo: echo в dash разбирает \n и прочее, а в тексте бывает имя устройства
step() { printf '%s\n' "@@step $*"; }
warn() { printf '%s\n' "@@warn $*"; }
fail() {
	printf '%s\n' "@@error $*"
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

check_endpoint() {
	case "${ENDPOINT:-}" in "" | *[!A-Za-z0-9.-]*) fail "неверный адрес сервера: ${ENDPOINT:-}" ;; esac
}

check_server() {
	step check "Проверяю сервер"
	[ "$(id -u)" = 0 ] || fail "нужен вход под root"
	case "${PROFILE:-}" in 1 | 2 | 3) ;; *) fail "неизвестная версия AmneziaWG: ${PROFILE:-}" ;; esac
	case "${SUBNET:-}" in "" | *[!0-9.]*) fail "неверная сеть VPN: ${SUBNET:-}" ;; esac
	check_endpoint
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
			Version) case $value in 1 | 2 | 3) ;; *) value= ;; esac ;;
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

awg_name() {
	case $1 in
		1) echo "AmneziaWG 1.0" ;;
		2) echo "AmneziaWG 2.0" ;;
		*) echo "AmneziaWG 3.1" ;;
	esac
}
# С какой прошивки KeeneticOS роутер понимает эту версию
awg_firmware() { if [ "$1" = 3 ]; then echo "5.2"; else echo "5.1"; fi; }

# Версия AmneziaWG настроенного сервера: 3.1 — с ключом защиты заголовков, 2.0 — с S3 и S4, иначе 1.0
server_profile() {
	if grep -q '^HeaderProtectionKey' "$CONF"; then
		echo 3
	elif grep -q '^S[34] *=' "$CONF"; then
		echo 2
	else
		echo 1
	fi
}

# Настройки «Для опытных» для этого роутера, которых нет в версии $1
unsupported_options() {
	case $1 in
		1) pattern='^(I[1-5]|Mask|ContentPaddingAddition|RekeyAfterTime|RekeyTimeout|RejectAfterTime|KeepaliveTimeout|MaxHandshakeAttempts) ' ;;
		2) pattern='^(ContentPaddingAddition|RekeyAfterTime|RekeyTimeout|RejectAfterTime|KeepaliveTimeout|MaxHandshakeAttempts) ' ;;
		*) return 0 ;;
	esac
	printf '%s' "$OPTS" | grep -E "$pattern" | sed 's/ = .*//' | tr '\n' ' ' | sed 's/ $//'
}

# Версия AmneziaWG этого подключения — до установки Docker, чтобы несовместимость была видна сразу.
# Настроенный сервер диктует её сам: роутер, который её не понимает, подключить нельзя, а роутер новее
# подключается на версии сервера — с предупреждением. Новый сервер — на версии роутера или на выбранной
# в «Для опытных» постарше, чтобы к нему могли подключаться и роутеры со старыми прошивками.
choose_profile() {
	if [ -f "$CONF" ]; then
		have=$(server_profile)
		[ "$have" -le "$PROFILE" ] ||
			fail "сервер уже работает на $(awg_name "$have"), а прошивка этого роутера понимает только $(awg_name "$PROFILE") — обновите KeeneticOS до $(awg_firmware "$have") или подключите роутер к другому серверу"
		if [ "$have" -lt "$PROFILE" ]; then
			warn "Сервер уже работает на $(awg_name "$have") — подключение будет на ней же, хотя роутер понимает $(awg_name "$PROFILE"): к серверу могут подключаться роутеры со старыми прошивками, но маскировка слабее"
			skipped=$(unsupported_options "$have")
			[ -z "$skipped" ] || warn "Из настроек «Для опытных» не применены ($(awg_name "$have") их не знает): $skipped"
		fi
		PROFILE=$have
	elif version=$(opt Version); then
		[ "$version" -le "$PROFILE" ] ||
			fail "прошивка роутера понимает только $(awg_name "$PROFILE"), а для сервера выбрана $(awg_name "$version")"
		PROFILE=$version
	fi
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
		elif [ "$PROFILE" = 2 ]; then
			# без защиты заголовков S могут быть меньше 12; S4 — тоже до 20 байт, как у 3.1
			s1=$(opt S1 || rnd 15 150)
			s2=$(opt S2 || rnd 15 150)
			s3=$(opt S3 || rnd 8 64)
			s4=$(opt S4 || rnd 4 20)
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
		# 1.0 и 2.0 — без защиты заголовков: случайные несовпадающие числа вместо 1–4 у WireGuard (диапазоны
		# в 2.0 есть, но на KeeneticOS 5.1 их не проверить)
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

# Свои параметры роутера: случайные у каждого, если не заданы в «Для опытных». I1–I5 — с AmneziaWG 2.0,
# добивка и таймеры — с 3.1
client_params() {
	junk_params
	[ "$PROFILE" != 1 ] || return 0
	i1=$(opt I1) || i1=$(mask_packet "$(opt Mask || echo dns)")
	[ -z "$i1" ] || echo "I1 = $i1"
	for key in I2 I3 I4 I5; do
		value=$(opt $key) && echo "$key = $value"
	done
	[ "$PROFILE" = 3 ] || return 0
	value=$(opt ContentPaddingAddition) && echo "ContentPaddingAddition = $value"
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
	step config "Настраиваю $(awg_name "$PROFILE")"
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
		if [ "$PROFILE" != 1 ]; then
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

# Конфигурация сервера: новая (awg0.conf.new) или действующая; в неё дописывается роутер или, если задан
# DEVICE (имя), устройство
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
		if [ -n "${DEVICE:-}" ]; then
			printf '# устройство: %s, %s\n' "$DEVICE" "$(date '+%Y-%m-%d %H:%M')"
		else
			echo "# роутер Keenetic, $(date '+%Y-%m-%d %H:%M')"
		fi
		echo "PublicKey = $client_pub"
		echo "PresharedKey = $psk"
		echo "AllowedIPs = $SUBNET.$n/32"
	} >"$CONF.tmp" && mv "$CONF.tmp" "$CONF" && rm -f "$CONF.new" || fail "не удалось записать $CONF"
	chmod 600 "$CONF"

	# Общие параметры — с сервера, свои — новые для этого роутера или устройства. Устройству — как у Amnezia:
	# DNS и весь трафик, IPv6 тоже (его сервер не выпускает, зато адрес IPv6 устройства не виден сайтам)
	shared=$(grep -E '^(S[1-4]|H[1-4]|HeaderProtectionKey|RandomTrailers) *=' "$CONF" | sed 's/ *= */ = /')
	own=$(client_params)
	keepalive=$(opt PersistentKeepalive || rnd 20 30)
	who=роутера
	[ -z "${DEVICE:-}" ] || who=устройства
	note "Свои параметры $who: $(echo "$own" | grep -E '^J' | tr '\n' ' ')PersistentKeepalive = $keepalive"
	CLIENT_CONF=$(
		echo "[Interface]"
		echo "PrivateKey = $client_key"
		echo "Address = $SUBNET.$n/32"
		if [ -n "${DEVICE:-}" ]; then
			echo "DNS = $DEVICE_DNS"
			echo "MTU = $DEVICE_MTU"
		else
			mtu=$(opt MTU) && echo "MTU = $mtu"
		fi
		echo "$shared"
		echo "$own"
		echo
		echo "[Peer]"
		echo "PublicKey = $server_pub"
		echo "PresharedKey = $psk"
		if [ -n "${DEVICE:-}" ]; then echo "AllowedIPs = 0.0.0.0/0, ::/0"; else echo "AllowedIPs = 0.0.0.0/0"; fi
		echo "Endpoint = $ENDPOINT:$port"
		echo "PersistentKeepalive = $keepalive"
	)
}

start_container() {
	# порт — в шаге, а не только в журнале: его открывают в брандмауэре хостинга, если он там есть
	if docker inspect "$CONTAINER" >/dev/null 2>&1; then
		step start "Перезапускаю сервер AmneziaWG (UDP-порт $port)"
		docker restart "$CONTAINER" >/dev/null || restore_and_fail "не удалось перезапустить контейнер $CONTAINER"
	else
		step start "Запускаю сервер AmneziaWG (UDP-порт $port)"
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

# Подключения из конфигурации: «КЛЮЧ АДРЕС КОММЕНТАРИЙ» на строку. Адрес — первый из AllowedIPs без маски,
# комментарий — первая строка «# …» в блоке [Peer]: её пишет add_peer, у добавленных вручную её может не быть.
peer_lines() {
	awk '
		function value(line) { sub(/^[^=]*=[ \t]*/, "", line); sub(/[ \t\r]*$/, "", line); return line }
		function flush() { if (peer && key != "") print key, (addr == "" ? "-" : addr), comment; peer = 0; key = addr = comment = "" }
		/^[ \t]*\[/ { flush(); peer = $0 ~ /^[ \t]*\[Peer\]/; next }
		!peer { next }
		/^[ \t]*#/ { if (comment == "") { comment = $0; sub(/^[ \t]*#[ \t]*/, "", comment) } next }
		/^[ \t]*PublicKey[ \t]*=/ { key = value($0) }
		/^[ \t]*AllowedIPs[ \t]*=/ { addr = value($0); sub(/[\/, ].*/, "", addr) }
		END { flush() }
	' "$CONF"
}

# Убрать подключение с ключом PEER; старая конфигурация остаётся в .bak до перезапуска сервера
remove_peer() {
	case ${PEER:-} in "" | *[!A-Za-z0-9+/=]*) fail "неверный ключ подключения" ;; esac
	[ "${#PEER}" = 44 ] || fail "неверный ключ подключения"
	peer_lines | grep -q "^$PEER " || fail "этого подключения на сервере уже нет — обновите список"
	cp "$CONF" "$CONF.bak" || fail "не удалось сохранить копию $CONF"
	awk -v key="$PEER" '
		function flush() { if (!drop) printf "%s", block; block = ""; drop = 0 }
		/^[ \t]*\[/ { flush() }
		{ block = block $0 "\n" }
		/^[ \t]*PublicKey[ \t]*=/ { v = $0; sub(/^[^=]*=[ \t]*/, "", v); sub(/[ \t\r]*$/, "", v); if (v == key) drop = 1 }
		END { flush() }
	' "$CONF.bak" >"$CONF.tmp" && mv "$CONF.tmp" "$CONF" || {
		mv "$CONF.bak" "$CONF"
		fail "не удалось записать $CONF"
	}
	chmod 600 "$CONF"
}

# Подключения сервера для окна «Устройства»: версия и порт, время сервера, затем по строке на подключение
# с последним рукопожатием и трафиком из awg show (у остановленного сервера — нули)
list_peers() {
	dump=$(docker exec "$CONTAINER" awg show awg0 dump 2>/dev/null)
	echo "@@server $PROFILE $port"
	echo "@@now $(date +%s)"
	peer_lines | while read -r key addr comment; do
		# в dump у пира: ключ, PSK, адрес клиента, AllowedIPs, рукопожатие, принято, отправлено, keepalive
		set -- $(printf '%s\n' "$dump" | awk -v k="$key" '$1 == k { print $5, $6, $7; exit }')
		label=$(printf '%s' "$comment" | base64 | tr -d '\n')
		echo "@@peer $key $addr ${1:-0} ${2:-0} ${3:-0} ${label:--}"
	done
}

# Подключения уже настроенного сервера (MODE): список, новое устройство, удаление. Сервер здесь не ставится:
# устройства добавляются к серверу, который настроил роутер, и на его версии AmneziaWG
manage() {
	step check "Проверяю сервер"
	[ "$(id -u)" = 0 ] || fail "нужен вход под root"
	[ -f "$CONF" ] && command -v docker >/dev/null 2>&1 ||
		fail "на этом сервере нет VPN, настроенного роутером Keenetic, — сначала создайте подключение кнопкой «Создать на своём сервере»"
	PROFILE=$(server_profile)
	port=$(sed -n 's/^ListenPort *= *//p' "$CONF")
	case $MODE in
		list) ;;
		device)
			check_endpoint
			# имя — только для подписи в конфигурации: без управляющих символов, не длиннее 120 байт
			DEVICE=$(printf '%s' "${NAME:-}" | base64 -d 2>/dev/null | tr -d '\000-\037\177')
			[ -n "$DEVICE" ] && [ "$(printf '%s' "$DEVICE" | wc -c)" -le 120 ] || fail "неверное имя устройства"
			step config "Добавляю устройство «$DEVICE» ($(awg_name "$PROFILE"))"
			add_peer
			start_container
			;;
		remove)
			step config "Удаляю подключение"
			remove_peer
			start_container
			;;
		*) fail "неизвестное действие: $MODE" ;;
	esac
	step done "Подключений на сервере: $(grep -c '^\[Peer\]' "$CONF")"
	list_peers
	if [ "$MODE" = device ]; then
		echo "@@conf-begin"
		printf '%s\n' "$CLIENT_CONF" | base64
		echo "@@conf-end"
	fi
	echo "@@done"
}

main() {
	if [ -n "${MODE:-}" ]; then
		manage
		return
	fi
	check_server
	read_options
	choose_profile
	install_docker
	if [ -f "$CONF" ]; then
		step config "Сервер уже настроен ($(awg_name "$PROFILE")), добавляю ещё одно подключение"
		if echo "$OPTS" | grep -Eq '^(ListenPort|S[1-4]|H[1-4]|Version) '; then
			step shared "Порт, S1–S4, H1–H4 и версия AmneziaWG остаются прежними: они общие для всех роутеров этого сервера"
		fi
	else
		new_server
	fi
	write_start_script
	add_peer
	start_container
	step done "Сервер готов, подключений на нём: $(grep -c '^\[Peer\]' "$CONF")"
	echo "@@conf-begin"
	printf '%s\n' "$CLIENT_CONF" | base64
	echo "@@conf-end"
	echo "@@done"
}

# Тесты (tests/vps-setup.test.js) подключают сценарий с VPS_SETUP_TEST=1 и вызывают функции по отдельности.
# Команды не должны читать stdin: из него sh -s дочитывает сам скрипт.
[ -n "${VPS_SETUP_TEST:-}" ] || main </dev/null
