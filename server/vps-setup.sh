#!/bin/sh
# Сервер AmneziaWG на VPS для подключения из роутера — в формате приложения Amnezia: контейнер amnezia-awg2,
# настройки внутри него в /opt/amnezia/awg (awg0.conf, ключи сервера, общий PSK и clientsTable — список
# подключений с именами). Поэтому сервер, настроенный роутером, видит приложение AmneziaVPN, а на сервер,
# настроенный приложением, роутер добавляется новым пользователем — подключение видно и там, и там.
#
# Запускает помощник роутера (helper/hostsgen-ui.c, vps-start) по SSH: «sh -s» под root, текст скрипта
# приходит на stdin, а перед ним — строки с переменными:
#   PROFILE   какую AmneziaWG понимает роутер: 3 — 3.1 (KeeneticOS 5.2 Alpha 11 и новее), 2 — 2.0 (с 5.1 Alpha 3),
#             1 — 1.0 (прошивки постарше)
#   SUBNET    первые три октета сети VPN для нового сервера, например 10.77.12 (сервер .1, подключения .2 и дальше)
#   ENDPOINT  адрес, по которому роутер подключился к серверу (IP или домен), — он же Endpoint в настройках
#   OPTIONS   необязательно: настройки из раздела «Для опытных» — строки «Параметр = значение» в base64
#   MODE      пусто — подключить роутер (и настроить сервер, если он новый). Остальное — для уже настроенного
#             сервера, PROFILE, SUBNET и OPTIONS тогда не нужны: list — показать его подключения, device —
#             добавить устройство (телефон, компьютер) с именем NAME (base64), remove — удалить подключение
#             с открытым ключом PEER
#
# Строки для роутера начинаются с @@: «@@step КОД ТЕКСТ», «@@warn ТЕКСТ» (предупреждение, настройка идёт
# дальше), «@@error ТЕКСТ», затем «@@conf-begin», настройки подключения в base64 и «@@conf-end», в конце
# «@@done». list, device и remove перед @@done выдают «@@server ВЕРСИЯ ПОРТ», «@@format amnezia|old» (отдельной
# строкой: вкладка, открытая до обновления модуля, «@@server» с лишним полем не поняла бы), «@@now ВРЕМЯ»
# и по строке «@@peer КЛЮЧ АДРЕС РУКОПОЖАТИЕ ПРИНЯТО ОТПРАВЛЕНО ПОДПИСЬ» на подключение (время — секунды Unix,
# подпись в base64 или «-»: «роутер Keenetic, ДАТА», «устройство: ИМЯ, ДАТА»). Остальной вывод — подробный журнал.
# Повторный запуск на том же сервере ничего не переустанавливает: добавляет ещё одно подключение.
#
# Серверы, настроенные модулем до версии 1.5, — в прежнем формате: контейнер keenetic-awg, настройки
# в /opt/keenetic-vpn на самом сервере, подписи подключений — комментариями в конфигурации. Такой сервер при
# первом изменении (новый роутер, устройство, удаление) переводится в формат Amnezia с теми же ключом, портом
# и параметрами: подключения через несколько секунд восстанавливаются сами. Не вышло — работает по-старому.
#
# Параметры маскировки AmneziaWG бывают двух видов — так их разбирает amneziawg-go (device/receive.go, send.go):
#  - общие: по ним приёмник опознаёт пакеты, поэтому у сервера и всех его роутеров они одни и те же —
#    S1–S4, H1–H4, HeaderProtectionKey, RandomTrailers. Выбираются случайно, когда сервер настраивается впервые;
#  - свои у каждой стороны: мусорные и сигнатурные пакеты перед рукопожатием (Jc, Jmin, Jmax, I1–I5), добивка
#    пакетов данных (ContentPaddingAddition) и таймеры — получатель о них ничего не знает. Каждый роутер получает
#    свои случайные значения, и подключения разных роутеров к одному серверу не похожи друг на друга.

IMAGE=amneziavpn/amneziawg-go:latest
# Формат Amnezia: контейнер (и образ с тем же именем), папка его Dockerfile на сервере, настройки в контейнере
AMNEZIA=amnezia-awg2
AMNEZIA_BUILD=/opt/amnezia/amnezia-awg2
AWG_DIR=/opt/amnezia/awg
# Сеть Docker приложения Amnezia: через неё подключения ходят к его DNS (AmneziaDNS), если его поставят
AMNEZIA_NET=amnezia-dns-net
# Прежний формат
OLD_DIR=/opt/keenetic-vpn
OLD_CONTAINER=keenetic-awg
# Имя роутера в списке подключений сервера (clientsTable) — его показывает и приложение Amnezia
ROUTER_NAME='Роутер Keenetic'
OS_RELEASE=/etc/os-release
TUN=/dev/net/tun
# Домены для маскировки первого пакета под DNS-запрос
DNS_NAMES='ya.ru yandex.ru vk.com mail.ru ok.ru dzen.ru avito.ru ozon.ru wildberries.ru gosuslugi.ru rutube.ru
kinopoisk.ru 2gis.ru hh.ru lenta.ru ria.ru rbc.ru habr.com google.com youtube.com apple.com icloud.com
microsoft.com github.com wikipedia.org cloudflare.com telegram.org whatsapp.com'
# Устройству, в отличие от роутера, DNS нужен в настройках подключения — как у Amnezia (1.1.1.1 и 1.0.0.1), —
# и MTU пониже: его приложения на телефонах ставят 1280, в мобильных сетях пакеты крупнее теряются
DEVICE_DNS='1.1.1.1, 1.0.0.1'
DEVICE_MTU=1280

# Какой сервер на VPS (find_server): new — ещё никакого, amnezia — контейнер Amnezia, old — прежний формат.
# CONF и TABLE — рабочие копии awg0.conf и clientsTable (у прежнего формата CONF — сам файл на сервере)
KIND=new
CONTAINER=$AMNEZIA
IFACE=awg0
TOOL=awg
CPATH=$AWG_DIR/awg0.conf

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

# Утилита awg: в работающем контейнере Amnezia — его собственная, иначе — из образа AmneziaWG
awg() {
	if [ "$KIND" = amnezia ]; then
		docker exec -i "$CONTAINER" "$TOOL" "$@"
	else
		docker run --rm -i --entrypoint awg "$IMAGE" "$@"
	fi
}

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

# Что прислал роутер
check_server() {
	[ "$(id -u)" = 0 ] || fail "нужен вход под root"
	case "${PROFILE:-}" in 1 | 2 | 3) ;; *) fail "неизвестная версия AmneziaWG: ${PROFILE:-}" ;; esac
	case "${SUBNET:-}" in "" | *[!0-9.]*) fail "неверная сеть VPN: ${SUBNET:-}" ;; esac
	check_endpoint
}

# Подойдёт ли VPS для нового сервера. На готовый сервер Amnezia роутер добавляется на любой системе
check_host() {
	# Только Ubuntu: на Debian и других системах VPN, по опыту, не настраивается даже приложением Amnezia
	os=$(. "$OS_RELEASE" 2>/dev/null && echo "$ID")
	[ "$os" = ubuntu ] ||
		fail "нужна Ubuntu, а на сервере $(. "$OS_RELEASE" 2>/dev/null && echo "${PRETTY_NAME:-другая система}") — переустановите его на Ubuntu 22.04 в панели хостинга"
	# образ amneziawg-go выпускается только для x86_64 — на ARM его не скачать
	[ "$(uname -m)" = x86_64 ] ||
		fail "процессор сервера $(uname -m) не подходит: AmneziaWG в Docker есть только для x86_64 (Intel и AMD) — возьмите такой VPS"
	[ -c "$TUN" ] || fail "на сервере нет /dev/net/tun: это VPS на OpenVZ или LXC, для VPN нужен KVM"
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

# Версия AmneziaWG настроенного сервера — по параметрам, которые нужны приёмнику: 3.1 — защита заголовков или
# случайные хвосты пакетов, 2.0 — S3 и S4 или диапазоны H, иначе 1.0. Как приложение Amnezia, только таймеры
# и добивку не считаем: они у каждой стороны свои
server_profile() {
	if grep -Eq '^(HeaderProtectionKey *= *[^ ]|RandomTrailers *= *on)' "$CONF"; then
		echo 3
	elif grep -Eq '^(S[34] *=|H[1-4] *= *[0-9]+-)' "$CONF"; then
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
	if [ "$KIND" != new ]; then
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

# apt-get с выводом в файл: в журнал роутера — только хвост, если что-то пошло не так
apt_quiet() {
	DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 "$@" >"$WORK/apt.log" 2>&1 && return
	tail -n 20 "$WORK/apt.log"
	return 1
}

install_docker() {
	if ! command -v docker >/dev/null 2>&1; then
		wait_apt
		step docker "Устанавливаю Docker — это пара минут"
		apt_quiet update || fail "не удалось обновить список пакетов (apt-get update)"
		apt_quiet install -y docker.io || fail "не удалось установить Docker"
	fi
	systemctl enable --now docker >/dev/null 2>&1 || service docker start >/dev/null 2>&1
	docker info >/dev/null 2>&1 || fail "Docker установлен, но не запускается"
	step image "Скачиваю AmneziaWG"
	docker pull -q "$IMAGE" >/dev/null || fail "не удалось скачать образ $IMAGE"
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

# Новый сервер: awg0.conf.new, ключ сервера и общий PSK (его берёт приложение Amnezia для своих подключений;
# у подключений роутера PSK свои) — в рабочей папке, контейнер запустит apply
new_server() {
	step config "Настраиваю $(awg_name "$PROFILE")"
	pick_port
	pick_shared
	key=$(awg genkey) && shared_psk=$(awg genpsk) || fail "не удалось создать ключи AmneziaWG"
	if [ "$PROFILE" = 3 ]; then
		hpk=$(awg genkey) || fail "не удалось создать ключи AmneziaWG"
	fi
	{
		echo "[Interface]"
		echo "PrivateKey = $key"
		echo "Address = $SUBNET.1/24"
		echo "ListenPort = $port"
		# S4 больше 20 — пакет из туннеля с MTU 1420 уже не помещается в 1500, уменьшаем MTU
		if [ "${s4:-0}" -gt 20 ]; then echo "MTU = $((1440 - s4))"; fi
		# свои мусорные пакеты сервера — для рукопожатий, которые начинает он сам; «Для опытных» — роутеру.
		# Их же приложение Amnezia даёт подключениям, которые создаёт само
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
		# I1 для подключений, которые создаст приложение Amnezia: оно берёт его из такого комментария
		if [ "$PROFILE" != 1 ]; then echo "# I1 = $(mask_packet dns 2>/dev/null)"; fi
	} >"$CONF.new" || fail "не удалось записать настройки сервера"
	printf '%s\n' "$key" >"$WORK/wireguard_server_private_key.key"
	printf '%s\n' "$shared_psk" >"$WORK/wireguard_psk.key"
	note "Общие параметры сервера: порт $port, S1 $s1, S2 $s2${s3:+, S3 $s3, S4 $s4}, H1–H4 $h1 $h2 $h3 $h4"
}

# Список подключений приложения Amnezia (clientsTable, JSON) — по нему приложение показывает имена:
#   table add КЛЮЧ ИМЯ_BASE64 [«ГГГГ-ММ-ДД ЧЧ:ММ» | -]   добавить (дата — когда добавлено: по умолчанию сейчас,
#                   «-» — неизвестно, без даты)
#   table remove КЛЮЧ
#   table init КЛЮЧ…  пустой список — заполнить подключениями сервера, как это делает приложение, когда
#                   открывает список пользователей («Client N»): в непустой оно уже ничего не добавляет
#   table labels    «КЛЮЧ ПОДПИСЬ_BASE64» на подключение, подписи — как в прежнем формате: «роутер Keenetic,
#                   ДАТА» или «устройство: ИМЯ, ДАТА»
# JSON разбирает python3 — на Ubuntu он есть всегда; если нет, имена просто не обновятся.
table() {
	if ! command -v python3 >/dev/null 2>&1; then
		note "На сервере нет python3 — список подключений приложения Amnezia не обновлён"
		return 0
	fi
	python3 - "$TABLE" "$ROUTER_NAME" "$@" <<'END'
import base64, datetime, json, sys

path, router, cmd, args = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
DAYS = 'Mon Tue Wed Thu Fri Sat Sun'.split()
MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split()
try:
    with open(path, encoding='utf-8') as f:
        table = json.load(f)
except (OSError, ValueError):
    table = []
if not isinstance(table, list):
    table = []

def key_of(client):
    return client.get('clientId') if isinstance(client, dict) else None

def save():
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(table, f, ensure_ascii=False, indent=4)
        f.write('\n')

def parse_date(text):
    for fmt in ('%a %b %d %H:%M:%S %Y', '%Y-%m-%d %H:%M', '%Y-%m-%dT%H:%M:%S', '%Y-%m-%d %H:%M:%S'):
        try:
            return datetime.datetime.strptime(text.strip(), fmt)
        except ValueError:
            pass
    return None

if cmd == 'add':
    key, name = args[0], base64.b64decode(args[1]).decode('utf-8', 'replace')
    user = {'clientName': name}
    when = parse_date(args[2]) if len(args) > 2 else datetime.datetime.now()
    if when:
        # как QDateTime::toString() у приложения: «Thu Nov 19 21:04:00 2026»
        user['creationDate'] = f'{DAYS[when.weekday()]} {MONTHS[when.month - 1]} {when.day} {when:%H:%M:%S} {when.year}'
    table = [c for c in table if key_of(c) != key]
    table.append({'clientId': key, 'userData': user})
    save()
elif cmd == 'remove':
    table = [c for c in table if key_of(c) != args[0]]
    save()
elif cmd == 'init':
    if not table and args:
        table = [{'clientId': key, 'userData': {'clientName': f'Client {n}'}} for n, key in enumerate(args)]
        save()
elif cmd == 'labels':
    for client in table:
        key = key_of(client)
        data = client.get('userData') if isinstance(client, dict) else None
        if not isinstance(key, str) or not isinstance(data, dict):
            continue
        name = str(data.get('clientName') or '').strip()
        if not name:
            continue
        label = 'роутер Keenetic' if name == router else 'устройство: ' + name
        when = parse_date(str(data.get('creationDate') or ''))
        if when:
            label += when.strftime(', %Y-%m-%d %H:%M')
        print(key.strip(), base64.b64encode(label.encode('utf-8')).decode())
END
}

# Подключение в список приложения Amnezia: имя — открытым текстом
table_add() {
	name=$(printf '%s' "$2" | base64 | tr -d '\n')
	if [ -n "${3:-}" ]; then table add "$1" "$name" "$3"; else table add "$1" "$name"; fi
}

# Конфигурация сервера: новая (awg0.conf.new) или действующая; в неё дописывается роутер или, если задан
# DEVICE (имя), устройство
add_peer() {
	src=$CONF.new
	[ -f "$src" ] || src=$CONF
	port=$(sed -n 's/^ListenPort *= *//p' "$src")
	# Address у сервера роутера — X.Y.Z.1/24, у сервера приложения Amnezia — X.Y.Z.0/24
	address=$(sed -n 's/^Address *= *\([0-9.]*\).*/\1/p' "$src" | head -n 1)
	SUBNET=${address%.*}
	[ -n "$port" ] && [ -n "$address" ] && [ "$SUBNET" != "$address" ] || fail "не разобрал настройки сервера"
	# Следующий адрес после самого большого — и сервера, и подключений; новое подключение — в конец файла:
	# приложение Amnezia берёт адрес после последнего в файле
	re=$(printf '%s' "$SUBNET" | sed 's/\./\\./g')
	last=$({
		echo "${address##*.}"
		sed -n "s/^AllowedIPs *= *$re\.\([0-9]*\)\/32.*/\1/p" "$src"
	} | sort -n | tail -n 1)
	n=$((last + 1))
	[ "$n" -le 254 ] || fail "в сети $SUBNET.0/24 закончились адреса"

	client_key=$(awg genkey)
	client_pub=$(echo "$client_key" | awg pubkey)
	psk=$(awg genpsk)
	server_pub=$(sed -n 's/^PrivateKey *= *//p' "$src" | awg pubkey)
	[ -n "$client_pub" ] && [ -n "$server_pub" ] && [ -n "$psk" ] || fail "не удалось создать ключи AmneziaWG"

	if [ "$src" = "$CONF" ]; then
		cp "$CONF" "$CONF.bak"
		[ ! -f "${TABLE:-}" ] || cp "$TABLE" "$TABLE.bak"
	fi
	{
		# без пустых строк в конце: приложение Amnezia дописывает подключения сразу за последним
		awk 'NF { while (blank) { print ""; blank-- } print; next } { blank++ }' "$src"
		echo
		echo "[Peer]"
		# в прежнем формате подпись — комментарием, в формате Amnezia — в clientsTable
		if [ "$KIND" = old ] && [ -n "${DEVICE:-}" ]; then
			printf '# устройство: %s, %s\n' "$DEVICE" "$(date '+%Y-%m-%d %H:%M')"
		elif [ "$KIND" = old ]; then
			echo "# роутер Keenetic, $(date '+%Y-%m-%d %H:%M')"
		fi
		echo "PublicKey = $client_pub"
		echo "PresharedKey = $psk"
		echo "AllowedIPs = $SUBNET.$n/32"
	} >"$CONF.tmp" && mv "$CONF.tmp" "$CONF" && rm -f "$CONF.new" || fail "не удалось записать настройки сервера"
	chmod 600 "$CONF"
	[ "$KIND" = old ] || table_add "$client_pub" "${DEVICE:-$ROUTER_NAME}"

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

# Подключения из конфигурации ($1 или CONF): «КЛЮЧ АДРЕС КОММЕНТАРИЙ» на строку. Адрес — первый из AllowedIPs
# без маски, комментарий — первая строка «# …» в блоке [Peer]: подпись прежнего формата, у остальных её нет.
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
	' "${1:-$CONF}"
}

# Ключ подключения из окна: base64 из 44 символов, и такое подключение на сервере есть
check_peer() {
	case ${PEER:-} in "" | *[!A-Za-z0-9+/=]*) fail "неверный ключ подключения" ;; esac
	[ "${#PEER}" = 44 ] || fail "неверный ключ подключения"
	peer_lines | grep -q "^$PEER " || fail "этого подключения на сервере уже нет — обновите список"
}

# Убрать подключение с ключом PEER; прежняя конфигурация остаётся в .bak, пока новая не заработает
remove_peer() {
	cp "$CONF" "$CONF.bak" || fail "не удалось сохранить копию настроек сервера"
	awk -v key="$PEER" '
		function flush() { if (!drop) printf "%s", block; block = ""; drop = 0 }
		/^[ \t]*\[/ { flush() }
		{ block = block $0 "\n" }
		/^[ \t]*PublicKey[ \t]*=/ { v = $0; sub(/^[^=]*=[ \t]*/, "", v); sub(/[ \t\r]*$/, "", v); if (v == key) drop = 1 }
		END { flush() }
	' "$CONF.bak" >"$CONF.tmp" && mv "$CONF.tmp" "$CONF" || {
		mv "$CONF.bak" "$CONF"
		fail "не удалось записать настройки сервера"
	}
	chmod 600 "$CONF"
	if [ "$KIND" != old ] && [ -f "$TABLE" ]; then
		cp "$TABLE" "$TABLE.bak"
		table remove "$PEER"
	fi
}

# ---------- контейнеры ----------

has_container() { docker inspect --type container "$1" >/dev/null 2>&1; }

# Файл в контейнере: прочитать / записать из stdin (через временный — чтобы не оставить половину)
cread() { docker exec "$CONTAINER" cat "$1"; }
cwrite() { docker exec -i "$CONTAINER" sh -c "umask 077 && cat >'$1.new' && mv '$1.new' '$1'"; }

# Где сервер. Прежний формат узнаём по его папке, формат Amnezia — по контейнеру: amnezia-awg2 или
# amnezia-awg (AmneziaWG 1.x старых версий приложения: wg0.conf и утилита wg вместо awg)
find_server() {
	KIND=new CONTAINER=$AMNEZIA IFACE=awg0 TOOL=awg CPATH=$AWG_DIR/awg0.conf
	CONF=$WORK/awg0.conf TABLE=$WORK/clientsTable
	if [ -f "$OLD_DIR/awg0.conf" ]; then
		KIND=old CONTAINER=$OLD_CONTAINER CONF=$OLD_DIR/awg0.conf
	elif command -v docker >/dev/null 2>&1; then
		if has_container "$AMNEZIA"; then
			KIND=amnezia
		elif has_container amnezia-awg; then
			KIND=amnezia CONTAINER=amnezia-awg IFACE=wg0 TOOL=wg CPATH=$AWG_DIR/wg0.conf
		fi
	fi
}

# Настройки сервера Amnezia — в рабочую папку
load_server() {
	[ "$KIND" = amnezia ] || return 0
	if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != true ]; then
		note "Контейнер $CONTAINER остановлен — запускаю"
		docker start "$CONTAINER" >/dev/null 2>&1 || fail "контейнер приложения Amnezia ($CONTAINER) не запускается"
	fi
	cread "$CPATH" >"$CONF" 2>/dev/null && grep -q '^PrivateKey' "$CONF" ||
		fail "не нашёл настройки AmneziaWG в контейнере приложения Amnezia ($CONTAINER)"
	cread "$AWG_DIR/clientsTable" >"$TABLE" 2>/dev/null || rm -f "$TABLE"
	# списка нет (старые версии приложения) — заполняем, иначе добавленное роутером скроет от приложения остальных
	table init $(peer_lines | cut -d ' ' -f 1)
}

# Настройки — в контейнер Amnezia и сразу в работу, как это делает само приложение: syncconf меняет только
# список подключений, без перезапуска — у остальных связь не прерывается
sync_amnezia() {
	cwrite "$CPATH" <"$CONF" &&
		docker exec "$CONTAINER" sh -c "$TOOL-quick strip $CPATH >/tmp/keenetic.conf && $TOOL syncconf $IFACE /tmp/keenetic.conf; r=\$?; rm -f /tmp/keenetic.conf; exit \$r" ||
		return 1
	if [ -f "$TABLE" ]; then
		cwrite "$AWG_DIR/clientsTable" <"$TABLE" || note "Не удалось обновить список подключений приложения Amnezia"
	fi
}

# Ждём, пока в контейнере поднимется интерфейс AmneziaWG
wait_awg() {
	waited=0
	until docker exec "$CONTAINER" "$TOOL" show "$IFACE" >/dev/null 2>&1; do
		waited=$((waited + 1))
		[ "$waited" -le 20 ] || return 1
		sleep 1
	done
}

# /opt/amnezia/start.sh — его контейнер запускает при каждом старте, как у приложения Amnezia: поднимает awg0
# и выпускает подключения сети $1 в интернет через NAT (eth1 — сеть amnezia-dns-net)
start_script() {
	cat <<END
#!/bin/bash
# AmneziaWG в формате приложения Amnezia; контейнер настроил роутер Keenetic (hostsgen-ui)
awg-quick down $AWG_DIR/awg0.conf 2>/dev/null
[ -f $AWG_DIR/awg0.conf ] && awg-quick up $AWG_DIR/awg0.conf
iptables -A INPUT -i awg0 -j ACCEPT
iptables -A FORWARD -i awg0 -j ACCEPT
iptables -A OUTPUT -o awg0 -j ACCEPT
for dev in eth0 eth1; do
	iptables -A FORWARD -i awg0 -o \$dev -s $1 -j ACCEPT
	iptables -t nat -A POSTROUTING -s $1 -o \$dev -j MASQUERADE
done
iptables -A FORWARD -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
tail -f /dev/null
END
}

# Образ amnezia-awg2 — как у приложения Amnezia, из папки /opt/amnezia/amnezia-awg2. Тот же amneziawg-go:
# bash, iptables и od в нём уже есть, поэтому сборка обходится без сети. Вместо dumb-init — sh с trap:
# docker stop останавливает контейнер сразу, а не через 10 секунд
build_amnezia() {
	mkdir -p "$AMNEZIA_BUILD" && cat >"$AMNEZIA_BUILD/Dockerfile" <<END || return 1
# Контейнер AmneziaWG в формате приложения Amnezia — собран роутером Keenetic (hostsgen-ui)
FROM $IMAGE
RUN mkdir -p /opt/amnezia && printf '#!/bin/bash\\ntail -f /dev/null\\n' >/opt/amnezia/start.sh && chmod a+x /opt/amnezia/start.sh
ENTRYPOINT ["/bin/sh", "-c", "trap 'exit 0' TERM INT; /opt/amnezia/start.sh & wait \$!"]
END
	docker build -q -t "$AMNEZIA" "$AMNEZIA_BUILD" >"$WORK/build.log" 2>&1 || {
		tail -n 20 "$WORK/build.log"
		return 1
	}
	docker network inspect "$AMNEZIA_NET" >/dev/null 2>&1 ||
		docker network create --driver bridge --subnet=172.29.172.0/24 --opt com.docker.network.bridge.name=amn0 \
			"$AMNEZIA_NET" >/dev/null 2>&1 ||
		note "Не удалось создать сеть Docker $AMNEZIA_NET — она нужна только для AmneziaDNS"
}

# Контейнер amnezia-awg2 из рабочей папки: awg0.conf, ключ сервера, общий PSK и clientsTable — внутрь,
# UDP-порт — наружу. Не вышло — контейнер удаляется (чтобы повторная попытка начала с чистого листа), код 1
run_amnezia() {
	CONTAINER=$AMNEZIA IFACE=awg0 TOOL=awg CPATH=$AWG_DIR/awg0.conf
	subnet=$(sed -n 's/^Address *= *\([0-9]*\.[0-9]*\.[0-9]*\)\.[0-9]*\/\([0-9]*\).*/\1.0\/\2/p' "$CONF" | head -n 1)
	server_pub=$(awg pubkey <"$WORK/wireguard_server_private_key.key")
	[ -n "$subnet" ] && [ -n "$server_pub" ] || return 1
	[ -f "$TABLE" ] || echo '[]' >"$TABLE"
	# docker run может создать контейнер и не запустить его (порт занят) — удаляется и такой
	if docker run -d --name "$AMNEZIA" --restart always --log-opt max-size=1m \
		--cap-add NET_ADMIN --device /dev/net/tun --sysctl net.ipv4.ip_forward=1 \
		-p "$port:$port/udp" "$AMNEZIA" >/dev/null; then
		docker network connect "$AMNEZIA_NET" "$AMNEZIA" >/dev/null 2>&1 ||
			note "Контейнер не подключён к сети $AMNEZIA_NET — AmneziaDNS ему будет недоступен"
		if docker exec "$AMNEZIA" mkdir -p "$AWG_DIR" &&
			cwrite "$CPATH" <"$CONF" &&
			cwrite "$AWG_DIR/wireguard_server_private_key.key" <"$WORK/wireguard_server_private_key.key" &&
			printf '%s\n' "$server_pub" | cwrite "$AWG_DIR/wireguard_server_public_key.key" &&
			cwrite "$AWG_DIR/wireguard_psk.key" <"$WORK/wireguard_psk.key" &&
			cwrite "$AWG_DIR/clientsTable" <"$TABLE" &&
			start_script "$subnet" | cwrite /opt/amnezia/start.sh &&
			docker exec "$AMNEZIA" chmod 755 /opt/amnezia/start.sh &&
			docker restart "$AMNEZIA" >/dev/null && wait_awg; then
			KIND=amnezia
			return 0
		fi
		docker logs --tail 30 "$AMNEZIA" 2>&1
	fi
	docker rm -f "$AMNEZIA" >/dev/null 2>&1
	return 1
}

# Сервер прежнего формата — в формат Amnezia с теми же ключом, портом, параметрами и подключениями:
# подписи из комментариев переходят в clientsTable, комментарии из конфигурации убираются. Прежний контейнер
# останавливается на время, пока запускается новый; не вышло — он запускается снова и всё работает по-старому.
# Прежняя папка остаётся копией в /opt/keenetic-vpn.old
to_amnezia() {
	if has_container "$AMNEZIA" || has_container amnezia-awg; then
		note "На сервере есть и контейнер приложения Amnezia — сервер роутера остаётся в прежнем формате"
		return 1
	fi
	step amnezia "Перевожу сервер в формат приложения Amnezia — так его увидит и AmneziaVPN. Ключи и настройки прежние, связь у подключений прервётся на несколько секунд"
	old=$CONF
	port=$(sed -n 's/^ListenPort *= *//p' "$old")
	CONF=$WORK/awg0.conf
	grep -v '^[[:space:]]*#' "$old" >"$CONF" &&
		sed -n 's/^PrivateKey *= *//p' "$old" >"$WORK/wireguard_server_private_key.key" &&
		awg genpsk >"$WORK/wireguard_psk.key" && [ -s "$WORK/wireguard_psk.key" ] || {
		CONF=$old
		warn "Не удалось перевести сервер в формат приложения Amnezia — он работает как раньше"
		return 1
	}
	# подпись прежнего формата: «роутер Keenetic, ДАТА», «устройство: ИМЯ, ДАТА», что-то своё или ничего
	echo '[]' >"$TABLE"
	peer_lines "$old" | while read -r key addr comment; do
		case $comment in
			"роутер Keenetic"*) name=$ROUTER_NAME ;;
			"устройство: "*) name=${comment#устройство: } ;;
			"") name="Подключение $addr" ;;
			*) name=$comment ;;
		esac
		date=-
		case $comment in
			*", "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]" "[0-9][0-9]:[0-9][0-9])
				date=${comment##*, }
				[ "$name" = "$ROUTER_NAME" ] || name=${name%, *}
				;;
		esac
		table_add "$key" "$name" "$date"
	done
	if ! build_amnezia; then
		CONF=$old
		warn "Не удалось собрать контейнер в формате приложения Amnezia — сервер работает как раньше"
		return 1
	fi
	docker stop "$OLD_CONTAINER" >/dev/null 2>&1 # освобождает UDP-порт
	if run_amnezia; then
		docker rm "$OLD_CONTAINER" >/dev/null 2>&1
		rm -rf "$OLD_DIR.old" && mv "$OLD_DIR" "$OLD_DIR.old"
		note "Прежние настройки сохранены в $OLD_DIR.old"
		return 0
	fi
	KIND=old CONTAINER=$OLD_CONTAINER IFACE=awg0 TOOL=awg CONF=$old
	docker start "$OLD_CONTAINER" >/dev/null 2>&1
	warn "Не удалось перевести сервер в формат приложения Amnezia — он работает как раньше"
	return 1
}

# Сервер прежнего формата: перезапуск контейнера keenetic-awg с новой конфигурацией
start_old() {
	step start "Перезапускаю сервер AmneziaWG (UDP-порт $port)"
	if docker inspect "$OLD_CONTAINER" >/dev/null 2>&1; then
		docker restart "$OLD_CONTAINER" >/dev/null || restore_old "не удалось перезапустить контейнер $OLD_CONTAINER"
	else
		docker run -d --name "$OLD_CONTAINER" --restart unless-stopped \
			--cap-add NET_ADMIN --device /dev/net/tun --sysctl net.ipv4.ip_forward=1 \
			--log-opt max-size=1m -p "$port:$port/udp" -v "$OLD_DIR:/etc/amneziawg" \
			"$IMAGE" /bin/sh /etc/amneziawg/start.sh >/dev/null || restore_old "не удалось запустить контейнер"
	fi
	wait_awg || {
		docker logs --tail 30 "$OLD_CONTAINER" 2>&1
		restore_old "AmneziaWG не запустился (журнал контейнера — выше)"
	}
	rm -f "$CONF.bak"
}

# Не удалось запустить с новым подключением — вернуть прежние настройки, чтобы не сломать уже работающие
restore_old() {
	if [ -f "$CONF.bak" ]; then
		mv "$CONF.bak" "$CONF"
		docker restart "$OLD_CONTAINER" >/dev/null 2>&1
	fi
	fail "$*"
}

# Новые настройки — в работу: новый сервер запускается, у сервера Amnezia меняется только список подключений,
# сервер прежнего формата перезапускается
apply() {
	case $KIND in
		new)
			# порт — в шаге, а не только в журнале: его открывают в брандмауэре хостинга, если он там есть
			step start "Запускаю сервер AmneziaWG (UDP-порт $port)"
			build_amnezia || fail "не удалось собрать контейнер AmneziaWG (журнал — выше)"
			run_amnezia || fail "AmneziaWG не запустился (журнал контейнера — выше)"
			;;
		amnezia)
			step start "Применяю настройки сервера (UDP-порт $port) — без перезапуска, у остальных подключений связь не прерывается"
			if ! sync_amnezia || ! docker exec "$CONTAINER" "$TOOL" show "$IFACE" >/dev/null 2>&1; then
				[ ! -f "$CONF.bak" ] || cp "$CONF.bak" "$CONF"
				[ ! -f "$TABLE.bak" ] || cp "$TABLE.bak" "$TABLE"
				sync_amnezia
				fail "не удалось применить настройки AmneziaWG в контейнере $CONTAINER"
			fi
			;;
		old) start_old ;;
	esac
	if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q 'Status: active'; then
		ufw allow "$port/udp" >/dev/null
	fi
}

# Подключения сервера для окна «Устройства»: версия, порт и формат, время сервера, затем по строке
# на подключение с последним рукопожатием и трафиком из awg show (у остановленного сервера — нули)
list_peers() {
	dump=$(docker exec "$CONTAINER" "$TOOL" show "$IFACE" dump 2>/dev/null)
	labels=
	[ "$KIND" = old ] || labels=$(table labels)
	echo "@@server $PROFILE $port"
	echo "@@format $KIND"
	echo "@@now $(date +%s)"
	peer_lines | while read -r key addr comment; do
		# в dump у пира: ключ, PSK, адрес клиента, AllowedIPs, рукопожатие, принято, отправлено, keepalive
		set -- $(printf '%s\n' "$dump" | awk -v k="$key" '$1 == k { print $5, $6, $7; exit }')
		if [ "$KIND" = old ]; then
			label=$(printf '%s' "$comment" | base64 | tr -d '\n')
		else
			label=$(printf '%s\n' "$labels" | awk -v k="$key" '$1 == k { print $2; exit }')
		fi
		echo "@@peer $key $addr ${1:-0} ${2:-0} ${3:-0} ${label:--}"
	done
}

# Подключения уже настроенного сервера (MODE): список, новое устройство, удаление. Сервер здесь не ставится:
# устройства добавляются к готовому серверу и на его версии AmneziaWG
manage() {
	[ "$(id -u)" = 0 ] || fail "нужен вход под root"
	find_server
	[ "$KIND" != new ] ||
		fail "на этом сервере нет VPN AmneziaWG — сначала подключите к нему роутер кнопкой «Создать на своём сервере»"
	load_server
	PROFILE=$(server_profile)
	port=$(sed -n 's/^ListenPort *= *//p' "$CONF")
	case $MODE in
		list) ;;
		device)
			check_endpoint
			# имя — только для подписи: без управляющих символов, не длиннее 120 байт
			DEVICE=$(printf '%s' "${NAME:-}" | base64 -d 2>/dev/null | tr -d '\000-\037\177')
			[ -n "$DEVICE" ] && [ "$(printf '%s' "$DEVICE" | wc -c)" -le 120 ] || fail "неверное имя устройства"
			[ "$KIND" != old ] || to_amnezia || :
			step config "Добавляю устройство «$DEVICE» ($(awg_name "$PROFILE"))"
			add_peer
			apply
			;;
		remove)
			check_peer
			[ "$KIND" != old ] || to_amnezia || :
			step config "Удаляю подключение"
			remove_peer
			apply
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
	# рабочая папка: копии настроек сервера с ключами — удаляется при любом выходе
	WORK=$(mktemp -d) || fail "не удалось создать временную папку"
	trap 'rm -rf "$WORK"' EXIT
	step check "Проверяю сервер"
	if [ -n "${MODE:-}" ]; then
		manage
		return
	fi
	check_server
	read_options
	find_server
	[ "$KIND" != new ] || check_host
	load_server
	if [ "$KIND" = amnezia ]; then
		step amnezia "На сервере уже есть VPN приложения Amnezia ($(awg_name "$(server_profile)")) — добавляю в него роутер новым пользователем: подключение будет видно и в приложении"
	fi
	choose_profile
	[ "$KIND" = amnezia ] || install_docker
	[ "$KIND" != old ] || to_amnezia || :
	if [ "$KIND" = new ]; then
		new_server
		created=1
	else
		step config "Сервер уже настроен ($(awg_name "$PROFILE")), добавляю ещё одно подключение"
		if echo "$OPTS" | grep -Eq '^(ListenPort|S[1-4]|H[1-4]|Version) '; then
			step shared "Порт, S1–S4, H1–H4 и версия AmneziaWG остаются прежними: они общие для всех подключений этого сервера"
		fi
	fi
	add_peer
	apply
	if [ -n "${created:-}" ]; then
		step app "Сервер — в формате приложения Amnezia: его можно добавить и в AmneziaVPN (свой сервер, те же адрес, логин и пароль), роутер будет в списке пользователей"
	fi
	step done "Сервер готов, подключений на нём: $(grep -c '^\[Peer\]' "$CONF")"
	echo "@@conf-begin"
	printf '%s\n' "$CLIENT_CONF" | base64
	echo "@@conf-end"
	echo "@@done"
}

# Тесты (tests/vps-setup.test.js) подключают сценарий с VPS_SETUP_TEST=1 и вызывают функции по отдельности.
# Команды не должны читать stdin: из него sh -s дочитывает сам скрипт.
[ -n "${VPS_SETUP_TEST:-}" ] || main </dev/null
