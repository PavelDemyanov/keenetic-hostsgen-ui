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
  `addon.js`, который встраивается inline в `index.html`, поэтому в них нельзя писать закрывающий тег script
  и открытие HTML-комментария (это проверяет тест). `common.js` — общая часть в `window.hostsgenUi`: RCI,
  вызов помощника через `exec`, окно со стилями и изоляцией клавиш, клон штатной кнопки, слежение за страницей.
  `addon.js` — «Добавить списком», `vps.js` — «Создать на своём сервере».
- `helper/hostsgen-ui.c` — статическая программа (musl), не зависит от Entware: в голой прошивке нет
  даже `mount`, `awk` и `grep`, только маленький `/bin/sh`.
  - `start` копирует `/usr/share/htdocs_/index.html` и `index-cloud.html` в `/tmp/hostsgen-ui/`,
    вписывает перед `</body>` содержимое `addon.js` и монтирует копии поверх оригиналов (`MS_BIND`).
    nginx раздаёт интерфейс из этих файлов, поэтому модуль виден и по LAN, и через KeenDNS.
    Ещё `start` кладёт копию себя в `/opt/share/hostsgen-ui/hostsgen-ui` — её вызывает веб-модуль.
  - `stop` снимает монтирование, `status` показывает состояние.
  - `resolve` распознаёт домены через DNS роутера (`getaddrinfo` → `/etc/resolv.conf` → 127.0.0.1).
    Браузер вызывает её RCI-командой `exec`: POST `/rci/exec` с `{path, arg1: "resolve", arg2: "a,b,…"}`,
    затем GET `/rci/exec`, пока в ответе `continued`. Авторизация — сессия веб-интерфейса.
  - `vps-*` — настройка VPS. Пароль идёт не открытым текстом: `vps-pad` выдаёт одноразовую маску, браузер
    шлёт пароль XOR маска, `vps-start` сразу удаляет маску и отвязывается от `exec` (двойной fork + setsid),
    а в фоне запускает `bin/dbclient.<arch>` (dropbear) с паролем в `DROPBEAR_PASSWORD`; stdin — переменные
    `PROFILE/SUBNET/ENDPOINT` и `server/vps-setup.sh` для `sh -s`, вывод — в `/tmp/hostsgen-ui/vps/log`.
    `vps-status N` отдаёт состояние и журнал с N-й строки, `vps-cancel` прерывает, `vps-clear` удаляет
    журнал (в нём ключ подключения) — веб-модуль зовёт его сразу после импорта.
- `server/vps-setup.sh` — выполняется на VPS (Ubuntu/Debian, root): ждёт apt свежего сервера, ставит
  `docker.io`, запускает контейнер `keenetic-awg` на `amneziavpn/amneziawg-go` (конфигурация и `start.sh`
  в `/opt/keenetic-vpn`, NAT внутри контейнера), печатает строки `@@step/@@error/@@done` и настройки
  клиента в base64 между `@@conf-begin` и `@@conf-end`. Повторный запуск добавляет пира, а не переустанавливает.
  Параметры AmneziaWG 3.1 — как `AwgInstaller::generateAwgParameters` у Amnezia (Jc 4–6, Jmin 10, Jmax 50,
  S1–S4 12, H1–H4 1–4, HeaderProtectionKey, диапазоны таймеров, I1 — DNS-ответ про icloud.com).
- Подключение создаёт `vps.js` тем же вызовом, что кнопка «Загрузить из файла»:
  `{"interface":{"wireguard":{"import":{"import": base64(.conf), "name": "", "filename": "…"}}}}`, в ответе
  `created` и `intersects`; затем `{"interface":{"name": …, "description": …}}`, `{…, "up": true}` и сохранение.
  Связь — `show interface` → `wireguard.peer[].online`. Версию AWG выбирает `awgProfile` по `show version`.
- `router/S99hostsgen-ui` — init-скрипт для `/bin/sh` прошивки: определяет процессор по заголовку ELF
  самого `/bin/sh` и запускает `bin/hostsgen-ui.{mipsel,mips,aarch64}`.
- `router/initrc` — сценарий запуска OPKG для накопителя без Entware: KeeneticOS по умолчанию вызывает
  `/opt/etc/initrc start|stop`, он запускает `/opt/etc/init.d/S*`. С Entware вызывается его `rc.unslung`.
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
- `resolve` печатает строку на домен: «домен ip1 ip2 …» или «домен -». `addon.js` берёт только строки,
  начинающиеся с домена из своей пачки (ndm дописывает в вывод `exec` «process terminated»). Пачка
  `HOSTS_PER_EXEC` (30) должна укладываться в `MAX_HOSTS` помощника (64).
- Строки `@@…` — договор между `vps-setup.sh`, помощником (`vps_failure`, ищет `@@step check`, `@@done`,
  `@@error`) и `readStatus` в `vps.js`; заголовок `vps-status` — «@@state СОСТОЯНИЕ СЛЕДУЮЩАЯ ВСЕГО».
  Аргументов у `exec` не больше восьми: `vps-start` занимает семь.
- `S99hostsgen-ui` запускает сборку из `bin/`, а не постоянную копию: `start` обновляет копию, только
  когда запущен не из неё.
- Модуль опирается на внутренности прошивки: веб-корень `/usr/share/htdocs_`, `</body>` в `index.html`,
  пути `/staticRoutes/ipv4` и `/otherConnections`, классы `.user-routes-table__buttons-row`,
  `.user-routes-table__buttons` (там «Удалить по интерфейсу» и появляющаяся при выделении «Удалить выделенные»),
  `.wireguard__buttons` и `ndw-button` (кнопки — клоны штатных, чтобы получить их стили), значки спрайта
  `list`, `globe` и `wan-connection`. Если обновление KeeneticOS их поменяет, кнопка просто не появится — после обновлений
  прошивки проверять обе страницы.
- Тесты подключают `web/*.js` через `require`: при `typeof window === 'undefined'` каждый экспортирует чистые
  функции (`module.exports` посередине файла) и выходит до кода DOM — новые чистые функции добавлять туда.

## Сборка, тесты, выкладка

```bash
./build.sh                                              # тесты + помощник и dbclient под три процессора + dist/install/hostsgen-ui.tar.gz
node --test tests/*.test.js                             # только тесты веб-модулей и синтаксиса vps-setup.sh
node --test --test-name-pattern='parseHar' tests/addon.test.js   # один тест
node --check web/vps.js                                 # синтаксис модуля
./deploy.sh                                             # выложить dist/ на роутер с Entware (SSH) и перевстроить модуль
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
`gh release create vX.Y.Z dist/install/hostsgen-ui.tar.gz --repo PavelDemyanov/keenetic-hostsgen-ui`.
Кнопка «Скачать» в README ведёт на `releases/latest/download/hostsgen-ui.tar.gz` — имя файла не менять.

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
- ndm отдаёт вывод `exec` порциями примерно по 8 строк и обрывает его ошибкой «system failed [0xcffd005d],
  unable to communicate with a process: invalid input» на управляющих символах — dpkg пишет прогресс через
  `\r`. Поэтому `vps-status` чистит строки (`print_clean_line`), а `vps-setup.sh` прячет вывод apt в файл.
  Аргументы `exec` ndm в журнал не пишет; процесс, отвязанный двойным fork и setsid, переживает конец `exec`.
- В прошивке нет SSH-клиента: `/usr/sbin/dropbear` — мультибинарник только из сервера и `dropbearkey`.
- AmneziaWG 3.1 прошивка понимает с 5.2 Alpha 11 (параметры — в `/lib/libndmWireguard.so`); в конфигурации
  роутера это одна строка `wireguard asc` со всеми параметрами, диапазоны — парами чисел. На старых прошивках `vps.js` выбирает AmneziaWG 1.0,
  а уже настроенный на 3.1 сервер `vps-setup.sh` для такого роутера не трогает (ошибка с советом обновиться).
- Пароль VPS и пароль роутера Claude не вводит: финальную проверку окна делает пользователь, а для отладки
  `vps-setup.sh` без роутера нужен вход на тестовый VPS по ключу.
- Проверено только на mipsel (Giga KN-1011, KeeneticOS 5.2); сборки mips и aarch64 на железе не запускались.
  VPS проверен один: Ubuntu 22.04 x86_64 (KVM).
