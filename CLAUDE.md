# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Что это

hostsgen-ui — пакет кнопок для веб-интерфейса KeeneticOS 5, ставится одним архивом:
- «Добавить списком» на странице «Маршрутизация → IPv4-маршруты»: домены, IP-адреса, подсети, строки
  `route ADD …` или HAR-файл → маска (/32, /24, /16, /8) → интерфейс и политика → маршруты сразу добавляются
  в роутер. Замена связки «генератор маршрутов (hostsgen) → .bat → кнопка «Загрузить»».
- «Сменить интерфейс» там же, рядом со штатной «Удалить выделенные»: отмеченные маршруты переезжают на
  другое подключение.
- «Создать на своём сервере» в блоке WireGuard на странице «Интернет → Другие подключения»: адрес VPS,
  логин и пароль root → роутер сам заходит на сервер по SSH, ставит AmneziaWG в Docker (как приложение
  Amnezia) и создаёт подключение штатным импортом конфигурации.

Прошивка не пересобирается: модуль ставится штатным механизмом OPKG (архив в папке `install` на
накопителе) и при каждом подключении накопителя подкладывается поверх штатного интерфейса.
Описание и пошаговая установка для людей без консоли — [README.md](README.md).

## Как устроено

- `web/common.js`, `web/addon.js`, `web/vps.js` — модули страницы; `build.sh` склеивает их в один
  `addon.js`, который помощник отдаёт отдельным файлом. `common.js` — общая часть в `window.hostsgenUi`: RCI,
  вызов помощника через `exec`, окно со стилями и изоляцией клавиш, клон штатной кнопки, слежение за страницей.
  `addon.js` — «Добавить списком», `vps.js` — «Создать на своём сервере».
- `helper/hostsgen-ui.c` — статическая программа (musl), не зависит от Entware: в голой прошивке нет
  даже `mount`, `awk` и `grep`, только маленький `/bin/sh`.
  - `start` копирует папку значков `/usr/share/htdocs_/assets/images/favicon` (`ASSETS`) в
    `/tmp/hostsgen-ui/assets`, кладёт туда `addon.js` как `hostsgen-ui.js` и монтирует копию поверх
    оригинала (`MS_BIND`); затем копирует `index.html` и `index-cloud.html`, вписывает перед `</body>`
    только `<script src="/assets/images/favicon/hostsgen-ui.js" defer>` (`LOADER`) и тоже монтирует.
    Весь модуль в страницу не встраивать: её отдаёт ndm, а он в 5.1 режет ответ на 64 КБ (см. грабли).
    Ссылка — на сам роутер, поэтому модуль виден и по LAN, и через KeenDNS, и в облачной странице, которая
    грузит скрипты интерфейса с CDN. Перед этим `start` снимает прежние копии страниц (и встроенные целиком
    версиями до 1.2.1); `umask(022)` — копии читает nginx от имени `nobody`.
    Ещё `start` кладёт копию себя в `/opt/share/hostsgen-ui/hostsgen-ui` — её вызывает веб-модуль.
  - `stop` снимает монтирование, `status` показывает состояние.
  - `resolve` распознаёт домены через DNS роутера (`getaddrinfo` → `/etc/resolv.conf` → 127.0.0.1).
    Браузер вызывает её RCI-командой `exec`: POST `/rci/exec` с `{path, arg1: "resolve", arg2: "a,b,…"}`,
    затем GET `/rci/exec`, пока в ответе `continued`. Авторизация — сессия веб-интерфейса.
  - `vps-*` — настройка VPS. Пароль идёт не открытым текстом: `vps-pad` выдаёт одноразовую маску, браузер
    шлёт пароль XOR маска, `vps-start` сразу удаляет маску и отвязывается от `exec` (двойной fork + setsid),
    а в фоне запускает `bin/dbclient.<arch>` (dropbear) с паролем в `DROPBEAR_PASSWORD`; stdin — переменные
    `PROFILE/SUBNET/ENDPOINT` (и `OPTIONS`, если в окне что-то задано «Для опытных») и `server/vps-setup.sh`
    для `sh -s`, вывод — в `/tmp/hostsgen-ui/vps/log`.
    `vps-status N` отдаёт состояние и журнал с N-й строки, `vps-cancel` прерывает, `vps-clear` удаляет
    журнал (в нём ключ подключения) — веб-модуль зовёт его сразу после импорта.
- `server/vps-setup.sh` — выполняется на VPS (только Ubuntu — так решил владелец: на Debian, по его опыту,
  VPN не настраивается даже приложением Amnezia; root): ждёт apt свежего сервера, ставит
  `docker.io`, запускает контейнер `keenetic-awg` на `amneziavpn/amneziawg-go` (конфигурация и `start.sh`
  в `/opt/keenetic-vpn`, NAT внутри контейнера), печатает строки `@@step/@@error/@@done` и настройки
  клиента в base64 между `@@conf-begin` и `@@conf-end`. Повторный запуск добавляет пира, а не переустанавливает.
  Параметры AmneziaWG делятся так, как их разбирает amneziawg-go (`device/receive.go`, `send.go`):
  - общие — по ним приёмник опознаёт пакет: S1–S4, H1–H4, HeaderProtectionKey, RandomTrailers. Случайные при
    первой настройке сервера (`pick_shared`: 3.1 — S1/S2 12–96, S3 12–64, S4 12–20, H 1–4 под защитой заголовков;
    1.0 — S1/S2 15–150, H случайные), длины 148+S1, 92+S2, 64+S3, 32+S4 различны (`sizes_differ`). `add_peer`
    копирует роутеру с сервера только их — так работают и серверы версий 1.1.x (S 12, как у Amnezia);
  - свои у роутера — `client_params`, новые на каждого: Jc 4–7, Jmin 12–48, Jmax на 64–200 больше, I1 —
    DNS-запрос (`mask_packet`: `<r 2>` ID, A/AAAA/HTTPS о домене из `DNS_NAMES`, иногда EDNS и cookie),
    таймеры около значений Amnezia (RekeyAfterTime до 120 с: сервер отвергает ключи через 150–180),
    PersistentKeepalive 20–30. ContentPaddingAddition и I2–I5 — только из «Для опытных».
  Тесты (`tests/vps-setup.test.js`) подключают сценарий с `VPS_SETUP_TEST=1` (тогда `main` не запускается)
  и зовут функции в dash с заглушкой `awg`.
- «Для опытных» в окне: `expertOptions` в `vps.js` проверяет параметры (границы — что принимает импорт
  KeeneticOS, см. грабли) и собирает строки «Параметр = значение» (плюс `Mask = noise|off`), браузер шлёт
  их base64 последним аргументом `vps-start`, помощник проверяет только алфавит base64 и длину
  (`OPTIONS_MAX`), `read_options` в сценарии ещё раз сверяет ключи с белым списком и формат значений, `opt КЛЮЧ`
  отдаёт значение. Порт, S и H применяются только к новому серверу.
- Подключение создаёт `vps.js` тем же вызовом, что кнопка «Загрузить из файла»:
  `{"interface":{"wireguard":{"import":{"import": base64(.conf), "name": "", "filename": "…"}}}}`, в ответе
  `created` и `intersects`; затем `{"interface":{"name": …, "description": …}}`, `{…, "up": true}` и сохранение.
  Связь — `show interface` → `wireguard.peer[].online`. Версию AWG выбирает `awgProfile` по `show version`.
- Архив — по одному на процессор (`hostsgen-ui-{mipsel,mips,aarch64}.tar.gz`): кроме сборок своего процессора,
  в нём ссылка `bin/sh` → `/opt/share/hostsgen-ui/bin/hostsgen-ui.<процессор>`. Всё из `/opt` KeeneticOS
  запускает только через `/opt/bin/sh` (см. грабли), а без Entware её больше некому дать. Вызванный как `sh`,
  помощник работает в `sh_mode`: есть Entware (`/opt/bin/busybox`) — возвращает его ссылку `sh → busybox`
  и передаёт ему управление с теми же аргументами; нет — сам выполняет `sh /opt/etc/initrc start|stop`
  (и `sh …/S99hostsgen-ui …`), то есть встраивает или снимает модуль.
- `router/S99hostsgen-ui` и `router/initrc` нужны роутерам с Entware: прошивка зовёт `/opt/etc/initrc start|stop`
  его оболочкой, `initrc` запускает `/opt/etc/init.d/S*`, а `S99` — сборку под процессор (по заголовку ELF
  `/bin/sh`). После переподключения накопителя прошивка сбрасывает сценарий запуска на `/opt/etc/initrc`,
  так что у пользователей Entware наш `initrc` заменяет `rc.unslung`.
- Маршруты добавляются так же, как это делает сам интерфейс: `POST /rci/` с пачками
  `{"ip":{"route":{network, mask | host, interface, auto, comment}}}` (для политики доступа —
  `{"ip":{"policy":{"name": "Policy1", "route": {…}}}}`), затем `{"system":{"configuration":{"save":{}}}}`.
  Удаление — `{"index": …, "no": true}`: у каждого маршрута в `ip/route` есть `index`.
- «Сменить интерфейс» (`moveCommands` в `addon.js`) повторяет штатный редактор маршрута (`saveIpv4Route`):
  удалить старый по `index` и добавить такой же без `index` с новым интерфейсом; не добавился — старый
  возвращаем. Выделение берётся из DOM: строки `.user-routes-table table.ndw-table` с отмеченным
  `input.ndw-checkbox__checkbox__input`, колонки «выбор, включено, назначение, шлюз, интерфейс, …»
  (узел — без /32, интерфейс — его описание); политика — из `<select>` над таблицей (`permit` — по умолчанию).
  Строки сопоставляются с `ip/route` по назначению, шлюзу и подписи интерфейса (`matchRows`).

### Связки между файлами

- Путь `/opt/share/hostsgen-ui/hostsgen-ui` — это `SELF` в `helper/hostsgen-ui.c` и `HELPER` в
  `web/common.js`; `ADDON` в помощнике — куда `build.sh`/`deploy.sh` кладут склеенный `addon.js`,
  `DBCLIENT` и `VPS_SCRIPT` — куда кладут `bin/dbclient.<arch>` и `vps-setup.sh`. Менять вместе.
- Ссылка `bin/sh` в архиве ведёт на `HOME/bin/hostsgen-ui.<процессор>` (`build.sh`), а `restore_entware_sh`
  узнаёт свою ссылку по префиксу `HOME/` и вызов в роли оболочки — по имени `sh`/`-sh` в `argv[0]` (`main`).
- `resolve` печатает строку на домен: «домен ip1 ip2 …» или «домен -». `addon.js` берёт только строки,
  начинающиеся с домена из своей пачки (ndm дописывает в вывод `exec` «process terminated»). Пачка
  `HOSTS_PER_EXEC` (30) должна укладываться в `MAX_HOSTS` помощника (64).
- Строки `@@…` — договор между `vps-setup.sh`, помощником (`vps_failure`, ищет `@@step check`, `@@done`,
  `@@error`) и `readStatus` в `vps.js`; заголовок `vps-status` — «@@state СОСТОЯНИЕ СЛЕДУЮЩАЯ ВСЕГО».
  Аргументов у `exec` не больше восьми: `vps-start` с настройками «Для опытных» занимает все восемь.
- Список параметров «Для опытных» — `EXPERT_PARAMS` в `vps.js` и `case` в `read_options` (`vps-setup.sh`):
  новый параметр добавлять в оба места (и решить, общий он или свой у роутера).
- `S99hostsgen-ui` запускает сборку из `bin/`, а не постоянную копию: `start` обновляет копию, только
  когда запущен не из неё.
- Модуль опирается на внутренности прошивки: веб-корень `/usr/share/htdocs_`, `</body>` в `index.html`,
  папку `assets/images/favicon` (в 5.1 и 5.2 в ней только файлы; если появится подпапка, `start` модуль не
  встраивает),
  пути `/staticRoutes/ipv4` и `/otherConnections`, классы `.user-routes-table__buttons-row`,
  `.user-routes-table__buttons` (там «Удалить по интерфейсу» и появляющаяся при выделении «Удалить выделенные»),
  `.wireguard__buttons` и `ndw-button` (кнопки — клоны штатных, чтобы получить их стили), значки спрайта
  `list`, `globe` и `wan-connection`. Если обновление KeeneticOS их поменяет, кнопка просто не появится — после обновлений
  прошивки проверять обе страницы.
- Тесты подключают `web/*.js` через `require`: при `typeof window === 'undefined'` каждый экспортирует чистые
  функции (`module.exports` посередине файла) и выходит до кода DOM — новые чистые функции добавлять туда.

## Сборка, тесты, выкладка

```bash
./build.sh                                              # тесты + помощник и dbclient под три процессора + dist/install/hostsgen-ui-<процессор>.tar.gz
node --test tests/*.test.js                             # только тесты: веб-модули, функции vps-setup.sh в dash
node --test --test-name-pattern='parseHar' tests/addon.test.js   # один тест
node --check web/vps.js                                 # синтаксис модуля
./deploy.sh                                             # выложить архив ARCH (mipsel по умолчанию) на роутер с Entware (SSH)
./deploy.sh status                                      # встроен ли модуль
./deploy.sh uninstall                                   # вернуть родной интерфейс, удалить файлы
```

Линтера нет; помощник собирается с `-Wall -Wextra -Werror` — любое предупреждение ломает `build.sh`.
dbclient собирается из dropbear (версия и SHA-256 — в `build.sh`, настройки — `tools/dropbear-localoptions.h`)
один раз на процессор и кэшируется в `.cache/`; при смене версии dropbear сверять хеш с Alpine (aports).

На самом роутере RCI без входа доступен на `127.0.0.1:79` — так удобно проверять `exec` по SSH:
`wget -qO- --header='Content-Type: application/json' --post-data='{"path":"…","arg1":"vps-status"}' http://127.0.0.1:79/rci/exec`,
дальше `GET /rci/exec`, пока `continued`.

Выпуск: поднять `VERSION` в `helper/hostsgen-ui.c`, `./build.sh`, закоммитить и запушить, затем
`gh release create vX.Y.Z dist/install/hostsgen-ui-*.tar.gz --repo PavelDemyanov/keenetic-hostsgen-ui`.
Ссылки «Скачать» в README ведут на `releases/latest/download/hostsgen-ui-{mipsel,aarch64,mips}.tar.gz` —
имена файлов не менять.

`build.sh` нужен `zig` в PATH (проверено на 0.17.0), плюс `node` и `python3`. Zig из Homebrew тянет
отдельные LLVM и LLD, а ziglang.org и ghcr.io (бутылки Homebrew) из российских сетей душат; официальный архив `zig-aarch64-macos-<версия>.tar.xz` быстро отдаёт зеркало fs.liujiacai.net/zigbuilds
(список зеркал — ziglang.org/download/community-mirrors.txt), хеш сверять со вторым зеркалом.
Архив пакует `tools/pack.py` (формат GNU tar), а не `tar` из macOS — см. грабли.

Доступ к роутеру для deploy.sh: `ssh -p 222 root@<роутер>` (Entware, вход по ключу; адрес — переменная ROUTER).
Ключи root у dropbear в Entware лежат в `/opt/etc/dropbear/authorized_keys`, не в `~/.ssh`.
Штатный «Сервер SSH» на порту 22 — это CLI KeeneticOS, не Linux.

## Инварианты и грабли

- Ничего не писать в прошивку: только `/opt` (накопитель OPKG) и `/tmp`.
- Распаковщик архивов OPKG в прошивке (`npkg`) принимает только заголовки tar с числовыми полями,
  оканчивающимися NUL (GNU tar). Архив от bsdtar из macOS он отвергает: «bad size (00000000000)».
- Архив из `install` распаковывается только при подключении накопителя («Накопитель» в OPKG); если он уже
  выбран — сначала «Не выбран». После распаковки папка `install` удаляется.
- Остановка OPKG (`no opkg disk`) убивает процессы, запущенные из окружения Entware, даже отвязанные
  через `start-stop-daemon -b` — сценарии, которые переподключают накопитель, гонять через RCI из браузера.
- DoH-серверы (1.1.1.1, 9.9.9.9, dns.google) в российских сетях часто недоступны — домены распознаёт только роутер.
- bin.entware.net (107.189.14.230) у части российских провайдеров душат до ~1 КБ/с; помогает маршрут `107.189.14.230`
  через VPN-интерфейс — без него `opkg` не работает.
- `syslog()` из musl ставит время в UTC — помощник пишет в `/dev/log` сам, с часовым поясом из `/var/TZ`.
- Сервис горячих клавиш KeeneticOS (`registerContext`) слушает `keydown` на `document` в фазе перехвата
  и, пока активен контекст выпадающего списка (`stopKeydownEvents = true`), отменяет любые нажатия —
  в том числе набор и Cmd+V в поле диалога. Поэтому диалог останавливает свои keydown/paste/cut/copy
  ещё на `window` (фаза перехвата). Проверять ввод только настоящими нажатиями: CDP `insertText` и
  присвоение `value` обходят keydown и такую проблему не покажут; в фоновой вкладке Chrome нажатия не доходят.
- Импорт файлом в штатном интерфейсе ограничен 1024 строками; модуль шлёт `ip route` пачками по 50,
  этого ограничения у него нет. Общего лимита маршрутов нет, но после ~1000 интерфейс роутера тормозит.
- Таблица маршрутов в интерфейсе показывает сохранённую конфигурацию (`show sc ip route`), а `GET /rci/ip/route` —
  текущую. Маршрут, добавленный через RCI без `system configuration save`, в таблице не виден — тестовые
  маршруты сохранять (и после удаления сохранять снова). Для проверок подходят сети без трафика (проверено
  на AMPRNet 44.31.x); 198.51.100.0/24 не брать — на ней служебный адрес роутера (ezcfg0).
- Страницы интерфейса — `/`, `/dashboard` и прочие пути Angular — nginx отдаёт не сам: `try_files $uri @ndm`,
  и ndm (`Core::Scgi::Session::ProcessStaticHtmlFileRequest_` в `/lib/libndmCorePack.so`) читает
  `htdocs_/index.html` (или `index-cloud.html`), подставляет `<!-- sso-script /-->` и `<!-- cors-meta /-->`
  и собирает ответ в `Io::StringStream` с потолком 64 КБ (`DEFAULT_MAX_SIZE`, `libndmBase.so`). В 5.1
  страница больше 64 КБ приходит пустой — белый экран (issues #1 и #2, KN-1012 на 5.1.x; в 5.2 страница
  в 90 КБ проходила). Прямой адрес `/index.html` nginx отдаёт сам, без ndm, — обходной путь, если интерфейс
  уже не открывается. Статику (`*.js`, `*.css`, значки) nginx отдаёт сам: `expires 0m`, `etag`,
  `Cache-Control: private, must-revalidate` — подменённый файл браузер берёт сразу.
- Прошивки всех версий — на osvault.keenetic.net (`/KN-1012/5.01/…`, ссылка из Download Center Keenetic).
  Образ KN-1012 — FIT, внутри squashfs 4.0 с XZ со смещения 0x200000; инструментов на Mac нет, хватает
  разбора на Python (модуль `lzma`). Символы в `libndm*.so` не вырезаны, `objdump` из Xcode дизассемблирует
  aarch64; так и нашлась причина белого экрана.
- ndm отдаёт вывод `exec` порциями примерно по 8 строк и обрывает его ошибкой «system failed [0xcffd005d],
  unable to communicate with a process: invalid input» на управляющих символах — dpkg пишет прогресс через
  `\r`. Поэтому `vps-status` чистит строки (`print_clean_line`), а `vps-setup.sh` прячет вывод apt в файл.
  Аргументы `exec` ndm в журнал не пишет; процесс, отвязанный двойным fork и setsid, переживает конец `exec`.
- В прошивке нет SSH-клиента: `/usr/sbin/dropbear` — мультибинарник только из сервера и `dropbearkey`.
- AmneziaWG 3.1 прошивка понимает с 5.2 Alpha 11 (параметры — в `/lib/libndmWireguard.so`); в конфигурации
  роутера это одна строка `wireguard asc` со всеми параметрами, диапазоны — парами чисел: Jc Jmin Jmax S1 S2
  H1–H4 S3 S4 "I1"…"I5" ключ, затем пары ContentPaddingAddition, RekeyAfterTime, RekeyTimeout, RejectAfterTime,
  KeepaliveTimeout, MaxHandshakeAttempts и флаги RandomTrailers, DisableCookies. На старых прошивках `vps.js`
  выбирает AmneziaWG 1.0, а уже настроенный на 3.1 сервер `vps-setup.sh` для такого роутера не трогает
  (ошибка с советом обновиться).
- Импорт KeeneticOS 5.2 (проверено на Beta 0) принимает в I1–I5 теги `<b 0x…>`, `<r N>`, `<rd N>`, `<rc N>`,
  `<t>`, а на `<c>` отвечает «invalid I4 value»; принимает диапазоны H1–H4, S1/S2 до 1132, S3 до 1216, S4 до 32,
  Jc 128, Jmax 1280 и конфигурацию в стиле 1.0 (без S3/S4 и ключа). Импорт сам сохраняет конфигурацию
  роутера, а удаление интерфейса (`{"interface":{"name": …, "no": true}}`) — нет: после проверочного импорта
  удалить интерфейс и сохранить, иначе он вернётся после перезагрузки. Сохранённая конфигурация интерфейса —
  `{"show":{"sc":{"interface":{"name": …}}}}`; для проверок — Endpoint из TEST-NET (192.0.2.1).
- Пароль VPS и пароль роутера Claude не вводит: финальную проверку окна делает пользователь, а для отладки
  `vps-setup.sh` без роутера нужен вход на тестовый VPS по ключу.
- Прошивка (ndm) запускает `initrc` и хуки `/opt/etc/ndm/*.d` только как `/opt/bin/sh …`, а `/bin/sh` прошивки —
  не оболочка, а «NDM Shell Wrapper»: без аргументов открывает CLI, а скрипты передаёт `/opt/bin/sh`, требуя,
  чтобы та лежала в `/opt` («Bad interpreter …: origin is not /opt»). Без Entware в журнале «"/opt/bin/sh"
  executable not found», с архивом не того процессора — «exec format error»: так и проверять выбор архива.
- `npkg` (распаковщик прошивки, `npkg -i архив -o корень` — удобно проверять в `/tmp`) ссылку из архива ставит
  вместо существующей, а обычный файл пишет сквозь существующую ссылку. Поэтому `bin/sh` в архиве — только
  ссылка: файл на этом месте у пользователя Entware затёр бы его `busybox`.
- Название модели процессор не определяет: Giga KN-1011 — mipsel, Giga KN-1012 — aarch64. Выбор — по коду KN-…
  (в журнале загрузки: «Machine model: Keenetic KN-1012»).
- Проверено на KeeneticOS 5.2: Giga KN-1011 (mipsel, с Entware) и Giga KN-1012 (aarch64, без Entware —
  установка архивом целиком). Сборка mips на железе не запускалась. VPS: Ubuntu 22.04 x86_64 (KVM) —
  второй роутер на тот же сервер получил своё подключение без переустановки, первый связь не потерял;
  версия 1.2 настроила с KN-1011 новый сервер на другом VPS (случайные S1–S4 и свои параметры роутера) — связь есть.
  KeeneticOS 5.1 на железе не проверялась: веб-интерфейс 5.1.7 из прошивки проверен на стенде (статика из образа,
  `/auth` и `/rci` — с роутера на 5.2) — родной, с модулем по ссылке и с модулем внутри страницы.
