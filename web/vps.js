/*
 * hostsgen-ui — кнопки «Создать на своём сервере» и «Добавить устройство» в блоке WireGuard на странице
 * «Интернет → Другие подключения» KeeneticOS.
 * «Создать на своём сервере»: адрес VPS, логин и пароль root → роутер сам заходит на сервер по SSH, ставит
 * там AmneziaWG (server/vps-setup.sh через helper/hostsgen-ui.c vps-*) и создаёт подключение тем же
 * импортом конфигурации, что и штатная кнопка «Загрузить из файла».
 * «Добавить устройство»: подключения уже настроенного сервера — список, новое для телефона или компьютера
 * (QR-код и файл .conf), удаление (vps-device).
 */
(() => {
  'use strict';

  const POLL_MS = 1500; // как часто спрашивать помощника о ходе настройки
  const CHECK_SECONDS = 40; // сколько ждать рукопожатия с сервером после создания подключения
  const STORAGE_KEY = 'hostsgen-ui-vps';
  const DEVICES_KEY = 'hostsgen-ui-devices';
  const ONLINE_SECONDS = 180; // рукопожатие свежее — устройство на связи (ключи меняются раз в 2 минуты)
  const DEVICE_NAME_MAX = 32;

  const { plural } = typeof window === 'undefined' ? require('./common.js') : window.hostsgenUi;

  // ---------- чистые функции ----------

  const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
  const ipToInt = (ip) => ip.split('.').reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
  const overlaps = (a, maskA, b, maskB) => {
    const m = (maskA & maskB) >>> 0;
    return ((a & m) >>> 0) === ((b & m) >>> 0);
  };

  /**
   * Какую AmneziaWG понимает прошивка (ответ show version): 3 — AmneziaWG 3.1 (с KeeneticOS 5.2 Alpha 11),
   * 2 — AmneziaWG 2.0 (с 5.1 Alpha 3: S3, S4 и I1–I5 есть, защиты заголовков и таймеров нет — проверено
   * по прошивке 5.1.7), 1 — AmneziaWG 1.0 (прошивки постарше).
   * release выглядит как «5.02.B.0.0-0» (B — beta, A — alpha), title — как «5.2 Beta 0».
   */
  function awgProfile(version) {
    let major;
    let minor;
    let alpha = null;
    const release = String((version && version.release) || '').match(/^(\d+)\.(\d+)\.([A-Z])\.(\d+)/);
    const title = String((version && version.title) || '').match(/^(\d+)\.(\d+)(?:\.\d+)?(?:\s+(alpha|beta|preview|rc)\s*(\d+))?/i);
    if (release) {
      [major, minor] = [Number(release[1]), Number(release[2])];
      if (release[3] === 'A') alpha = Number(release[4]);
    } else if (title) {
      [major, minor] = [Number(title[1]), Number(title[2])];
      if (title[3] && title[3].toLowerCase() === 'alpha') alpha = Number(title[4]);
    } else {
      return 1;
    }
    // не старше major.minor Alpha N; бета и релизы — позже всех альф своей версии
    const since = (sinceMajor, sinceMinor, sinceAlpha) =>
      major !== sinceMajor ? major > sinceMajor
        : minor !== sinceMinor ? minor > sinceMinor
          : alpha === null || alpha >= sinceAlpha;
    if (since(5, 2, 11)) return 3;
    if (since(5, 1, 3)) return 2;
    return 1;
  }

  const AWG_NAMES = { 1: 'AmneziaWG 1.0', 2: 'AmneziaWG 2.0', 3: 'AmneziaWG 3.1' };
  const awgName = (profile) => AWG_NAMES[profile] || AWG_NAMES[1];
  /** С какой KeeneticOS роутер понимает эту версию AmneziaWG. */
  const awgFirmware = (profile) => (profile === 3 ? 'KeeneticOS 5.2' : profile === 2 ? 'KeeneticOS 5.1' : 'любой KeeneticOS');

  /**
   * Сеть VPN 10.X.Y.0/24 (возвращаются первые три октета), не пересекающаяся с сетями интерфейсов
   * роутера: used — [{ address, mask }] из show interface.
   */
  function pickSubnet(used, random = Math.random) {
    const nets = used
      .filter((u) => u && /^\d+\.\d+\.\d+\.\d+$/.test(u.address || '') && /^\d+\.\d+\.\d+\.\d+$/.test(u.mask || ''))
      .map((u) => ({ net: ipToInt(u.address), mask: ipToInt(u.mask) }));
    const mask24 = ipToInt('255.255.255.0');
    for (let i = 0; i < 500; i++) {
      const x = 64 + Math.floor(random() * 64); // 10.64–10.127: реже всего заняты
      const y = Math.floor(random() * 256);
      const net = ipToInt(`10.${x}.${y}.0`);
      if (!nets.some((u) => overlaps(u.net, u.mask, net, mask24))) return `10.${x}.${y}`;
    }
    return null;
  }

  /** Пароль → hex после XOR с одноразовой маской помощника (vps-pad), чтобы не слать его открытым текстом. */
  function maskPassword(password, padHex) {
    const bytes = new TextEncoder().encode(password);
    const pad = (padHex.match(/[0-9a-f]{2}/gi) || []).map((h) => parseInt(h, 16));
    if (!bytes.length) throw new Error('пустой пароль');
    if (bytes.length > pad.length) throw new Error(`пароль длиннее ${pad.length} байт`);
    return [...bytes].map((b, i) => (b ^ pad[i]).toString(16).padStart(2, '0')).join('');
  }

  // kind — чья работа (первая строка журнала @@job): router — «Создать на своём сервере», device — «Добавить
  // устройство»; у помощника до 1.4 её нет. server, now и peers — список подключений сервера (vps-device).
  const newJob = () => ({
    state: 'none', next: 0, total: 0, kind: null, steps: [], log: [], error: null, conf: null, confLines: null, done: false,
    server: null, now: 0, peers: [],
  });

  /** base64 → текст UTF-8 (atob даёт байты по одному на символ). */
  function fromBase64(text) {
    try {
      return new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)));
    } catch {
      return '';
    }
  }
  const toBase64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

  /**
   * Подпись подключения в конфигурации сервера: «роутер Keenetic, ДАТА» или «устройство: ИМЯ, ДАТА» — так её
   * пишет add_peer; у добавленных вручную подписи может не быть или она своя.
   */
  function parsePeerLabel(label) {
    const router = label.match(/^роутер Keenetic(?:, (.+))?$/);
    if (router) return { kind: 'router', name: '', added: router[1] || '' };
    // у подключений, созданных в приложении Amnezia, даты может не быть
    const device = label.match(/^устройство: (.*?)(?:, (\d{4}-\d\d-\d\d \d\d:\d\d))?$/);
    if (device) return { kind: 'device', name: device[1], added: device[2] || '' };
    return { kind: 'other', name: label, added: '' };
  }

  /**
   * Очередная порция vps-status: «@@state СОСТОЯНИЕ СЛЕДУЮЩАЯ_СТРОКА ВСЕГО_СТРОК», дальше журнал
   * со строками сценария «@@step КОД ТЕКСТ», «@@warn ТЕКСТ», «@@error ТЕКСТ», @@conf-begin … @@conf-end,
   * @@done. Предупреждения идут в steps с warn: true — окно показывает их среди шагов.
   */
  function readStatus(lines, job) {
    for (const raw of lines) {
      const line = String(raw).replace(/\r$/, '');
      const state = line.match(/^@@state (\S+) (\d+) (\d+)$/);
      if (state) {
        job.state = state[1];
        job.next = Number(state[2]);
        job.total = Number(state[3]);
      } else if (job.confLines && line !== '@@conf-end') {
        // настройки — base64 по строкам; «process terminated» и пустые строки ndm дописывает в конец вывода exec,
        // а он может кончиться посреди настроек
        if (/^[A-Za-z0-9+/=]+$/.test(line.trim())) job.confLines.push(line.trim());
      } else if (line.startsWith('@@job ')) {
        job.kind = line.slice(6).trim();
      } else if (/^@@server \d \d+$/.test(line)) {
        const [, profile, port] = line.split(' ');
        job.server = { profile: Number(profile), port, format: '' };
      } else if (/^@@format \w+$/.test(line)) {
        // amnezia — сервер в формате приложения Amnezia, old — настроенный модулем до 1.5; идёт после @@server
        if (job.server) job.server.format = line.slice(9);
      } else if (/^@@now \d+$/.test(line)) {
        job.now = Number(line.slice(6));
      } else if (line.startsWith('@@peer ')) {
        const [, key = '', address = '', handshake, rx, tx, label = '-'] = line.split(' ');
        job.peers.push({
          key, address: address === '-' ? '' : address, handshake: Number(handshake) || 0, rx: Number(rx) || 0, tx: Number(tx) || 0,
          ...parsePeerLabel(label === '-' ? '' : fromBase64(label)),
        });
      } else if (line === '@@conf-begin') {
        job.confLines = [];
      } else if (line === '@@conf-end') {
        job.conf = job.confLines ? atob(job.confLines.join('')) : null;
        job.confLines = null;
      } else if (line.startsWith('@@step ')) {
        const [, code = '', text = ''] = line.match(/^@@step (\S+) ?(.*)$/) || [];
        job.steps.push({ code, text });
      } else if (line.startsWith('@@warn ')) {
        job.steps.push({ code: 'warn', text: line.slice(7), warn: true });
      } else if (line.startsWith('@@error ')) {
        job.error = line.slice(8);
      } else if (line === '@@done') {
        job.done = true;
      } else if (line.trim() && line !== 'process terminated') {
        // пустые строки и «process terminated» дописывает ndm в вывод exec
        job.log.push(line);
      }
    }
    return job;
  }

  /**
   * Что сказать в окне о версии AmneziaWG: что понимает прошивка и к каким роутерам подойдёт новый сервер.
   * Сервер на 3.1 недоступен роутерам с прошивкой старше 5.2 — об этом надо знать заранее.
   */
  function profileNote(profile, title) {
    const firmware = title ? `Ваша прошивка (${title})` : 'Ваша прошивка';
    if (profile === 3) {
      return 'Протокол — AmneziaWG 3.1, самая новая маскировка. К новому серверу смогут подключиться только роутеры ' +
        'с KeeneticOS 5.2 и новее; если к нему будут подключаться роутеры с прошивкой постарше, выберите версию 2.0 ' +
        'или 1.0 в разделе «Для опытных».';
    }
    if (profile === 2) {
      return `Протокол — AmneziaWG 2.0: ${firmware.toLowerCase()} понимает её, а 3.1 появится с KeeneticOS 5.2. ` +
        'К новому серверу смогут подключиться роутеры с KeeneticOS 5.1 и новее; для роутеров постарше выберите версию 1.0 ' +
        'в разделе «Для опытных».';
    }
    return `${title ? firmware : 'Ваша прошивка (версия неизвестна)'} понимает только AmneziaWG 1.0 — её проще заблокировать. ` +
      'Версия 2.0 есть в KeeneticOS 5.1, 3.1 — в 5.2.';
  }

  /** Адрес и порт сервера из строки Endpoint готовой конфигурации. */
  const endpointOf = (conf) => (conf || '').match(/^Endpoint\s*=\s*(.+):(\d+)\s*$/m) || [];
  const endpointHost = (conf) => endpointOf(conf)[1] || '';
  const endpointPort = (conf) => endpointOf(conf)[2] || '';

  // ---------- устройства ----------

  /** Как назвать подключение в списке; own — описание подключения этого роутера с тем же ключом. */
  function peerTitle(peer, own) {
    if (own) return `Этот роутер — ${own}`;
    if (peer.kind === 'router') return 'Роутер Keenetic';
    return peer.name || 'Без подписи';
  }

  /** Сколько времени прошло, по-человечески: «5 минут», «2 часа», «3 дня». */
  function ago(seconds) {
    if (seconds < 3600) {
      const n = Math.max(1, Math.round(seconds / 60));
      return `${n} ${plural(n, 'минуту', 'минуты', 'минут')}`;
    }
    if (seconds < 86400) {
      const n = Math.round(seconds / 3600);
      return `${n} ${plural(n, 'час', 'часа', 'часов')}`;
    }
    const n = Math.round(seconds / 86400);
    return `${n} ${plural(n, 'день', 'дня', 'дней')}`;
  }

  /** Связь по последнему рукопожатию (секунды Unix по часам сервера, как и now). */
  function linkText(peer, now) {
    if (!peer.handshake) return 'ещё не подключалось';
    const age = Math.max(0, now - peer.handshake);
    return age <= ONLINE_SECONDS ? 'на связи' : `был на связи ${ago(age)} назад`;
  }

  function formatBytes(n) {
    const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    let i = 0;
    let value = n;
    for (; value >= 1024 && i < units.length - 1; i++) value /= 1024;
    const text = i && value < 10 ? value.toFixed(1).replace('.', ',') : String(Math.round(value));
    return `${text} ${units[i]}`;
  }

  /** Имя устройства: от 1 до 32 символов, без управляющих — ошибка или пустая строка. */
  function deviceNameError(name) {
    if (!name) return 'введите имя устройства — например, «Телефон Паши»';
    if ([...name].length > DEVICE_NAME_MAX) return `имя устройства — не длиннее ${DEVICE_NAME_MAX} символов`;
    if (/[\u0000-\u001f\u007f]/.test(name)) return 'в имени устройства — недопустимые символы';
    return '';
  }

  const TRANSLIT = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o',
    п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  };

  /**
   * Имя файла .conf: приложения AmneziaWG и WireGuard называют подключение по имени файла и принимают
   * в нём только латиницу, цифры и «_=+.-», не длиннее 15 символов.
   */
  function deviceFileName(name) {
    const latin = [...name].map((c) => {
      const t = TRANSLIT[c.toLowerCase()];
      if (t === undefined) return c;
      return c === c.toLowerCase() ? t : t.charAt(0).toUpperCase() + t.slice(1);
    }).join('');
    const safe = latin.replace(/[^A-Za-z0-9_=+.-]+/g, '_').replace(/^[_.]+|_+$/g, '').slice(0, 15).replace(/_+$/, '');
    return `${safe || 'amneziawg'}.conf`;
  }

  /** Какие приложения подключатся к серверу этой версии AmneziaWG. */
  /** Чем сервер связан с приложением AmneziaVPN — по формату из @@server. */
  function formatNote(format) {
    if (format === 'amnezia') {
      return 'Сервер — в формате приложения Amnezia: подключения, добавленные здесь, видны в приложении AmneziaVPN, и наоборот.';
    }
    if (format === 'old') {
      return 'Сервер настроен прежней версией модуля: при следующем добавлении или удалении он перейдёт в формат приложения Amnezia ' +
        '(ключи и подключения сохранятся) — тогда его увидит и AmneziaVPN.';
    }
    return '';
  }

  function deviceAppNote(profile) {
    const plain = 'Обычное приложение WireGuard не подойдёт: сервер ждёт маскировку AmneziaWG.';
    if (profile === 3) {
      return 'Сервер работает на AmneziaWG 3.1 — нужно свежее приложение: AmneziaVPN 5 и новее (на iPhone — только оно) ' +
        `или AmneziaWG 3.1 и новее для Android и Windows. ${plain}`;
    }
    if (profile === 2) return `Сервер работает на AmneziaWG 2.0 — нужно приложение AmneziaVPN или AmneziaWG 2.0 и новее. ${plain}`;
    return `Сервер работает на AmneziaWG 1.0 — подойдёт любое приложение AmneziaVPN или AmneziaWG. ${plain}`;
  }

  // ---------- настройки «Для опытных» ----------

  /*
   * Параметры AmneziaWG, которые можно задать вручную. shared — общие для сервера и всех его роутеров:
   * действуют, только когда сервер настраивается впервые; since — с какой версии AmneziaWG параметр есть
   * (2 — с 2.0, 3 — только в 3.1).
   * Границы — что принимает импорт KeeneticOS 5.2 (проверено на роутере) и что не рвёт связь с сервером:
   * он отвергает ключи старше 150 с, поэтому RekeyAfterTime — до 140 с, а RejectAfterTime — от 150.
   */
  const EXPERT_PARAMS = {
    ListenPort: { kind: 'number', min: 1, max: 65535, shared: true },
    Jc: { kind: 'number', min: 0, max: 128 },
    Jmin: { kind: 'number', min: 0, max: 1280 },
    Jmax: { kind: 'number', min: 0, max: 1280 },
    S1: { kind: 'number', min: 0, max: 1132, shared: true },
    S2: { kind: 'number', min: 0, max: 1132, shared: true },
    S3: { kind: 'number', min: 0, max: 1216, shared: true, since: 2 },
    S4: { kind: 'number', min: 0, max: 32, shared: true, since: 2 },
    H1: { kind: 'header', shared: true },
    H2: { kind: 'header', shared: true },
    H3: { kind: 'header', shared: true },
    H4: { kind: 'header', shared: true },
    I1: { kind: 'chain', since: 2 },
    I2: { kind: 'chain', since: 2 },
    I3: { kind: 'chain', since: 2 },
    I4: { kind: 'chain', since: 2 },
    I5: { kind: 'chain', since: 2 },
    ContentPaddingAddition: { kind: 'range', min: 0, max: 1000, since: 3 },
    RekeyAfterTime: { kind: 'range', min: 30, max: 140, since: 3 },
    RekeyTimeout: { kind: 'range', min: 1, max: 20, since: 3 },
    RejectAfterTime: { kind: 'range', min: 150, max: 600, since: 3 },
    KeepaliveTimeout: { kind: 'range', min: 1, max: 60, since: 3 },
    MaxHandshakeAttempts: { kind: 'range', min: 1, max: 60, since: 3 },
    PersistentKeepalive: { kind: 'number', min: 0, max: 300 },
    MTU: { kind: 'number', min: 1280, max: 1420 },
  };
  // Строки чужой конфигурации, которые мастер задаёт сам, — их пропускаем молча
  const EXPERT_SKIPPED = /^(PrivateKey|PublicKey|PresharedKey|Address|DNS|AllowedIPs|Endpoint|HeaderProtectionKey|RandomTrailers|DisableCookies|Table|SaveConfig|FwMark|PreUp|PostUp|PreDown|PostDown)$/i;
  const UINT32_MAX = 4294967295;
  const CHAIN_MAX = 1280; // байт в пакете I1–I5: больше — пакет разобьётся на части, а это заметно

  /** «N» или «N-M» → [N, M]; null, если не так. */
  function parseRange(value) {
    const m = String(value).match(/^(\d{1,10})(?:-(\d{1,10}))?$/);
    if (!m) return null;
    const lo = Number(m[1]);
    const hi = m[2] === undefined ? lo : Number(m[2]);
    return lo <= hi ? [lo, hi] : null;
  }

  /**
   * Длина пакета I1–I5 в байтах или текст ошибки. Теги для 3.1 — <b 0x…>, <r N>, <rd N>, <rc N>, <t>
   * (что принимает импорт KeeneticOS 5.2); для 2.0 — только <b 0x…>, <r N>, <t>: в модуле ядра 5.1.7
   * они точно есть, а <rd> и <rc> там не проверить.
   */
  function chainSize(value, profile = 3) {
    if (/<c>/.test(value)) return 'тег <c> прошивка Keenetic не принимает';
    if (profile !== 3 && /<r[dc] /.test(value)) return 'в AmneziaWG 2.0 — только теги <b 0x…>, <r N> и <t>';
    if (!/^(<(b 0x([0-9a-f]{2})+|r \d{1,4}|rd \d{1,4}|rc \d{1,4}|t)>)+$/i.test(value)) {
      return profile === 3 ? 'нужна цепочка тегов <b 0x…>, <r N>, <rd N>, <rc N>, <t>' : 'нужна цепочка тегов <b 0x…>, <r N>, <t>';
    }
    let size = 0;
    for (const [, tag, arg] of value.matchAll(/<(\w+) ?([^>]*)>/g)) {
      if (tag === 'b') size += (arg.length - 2) / 2;
      else if (tag === 't') size += 4;
      else if (Number(arg) > 1000) return 'в одном теге — не больше 1000 байт';
      else size += Number(arg);
    }
    return size > CHAIN_MAX ? `пакет больше ${CHAIN_MAX} байт` : size;
  }

  /**
   * Настройки «Для опытных» → строки «Параметр = значение» для vps-setup.sh (OPTIONS) и ошибки.
   * custom — свои параметры AmneziaWG, можно вставить целую конфигурацию: ключи, адреса и прочее,
   * что мастер создаёт сам, пропускаются. mask — первый пакет перед рукопожатием (dns, noise, off),
   * port — UDP-порт сервера, version — версия AmneziaWG нового сервера (не новее profile).
   * profile — версия AmneziaWG, которую понимает прошивка (awgProfile).
   */
  function expertOptions({ mask = 'dns', port = '', custom = '', version = '' } = {}, profile = 3) {
    const values = {};
    const errors = [];
    // Параметры проверяем по версии будущего сервера: старше выбранной в «Для опытных» её не сделать
    const target = Number(version) || profile;
    if (!AWG_NAMES[target] || target > profile) {
      return { text: '', errors: [`прошивка роутера понимает только ${awgName(profile)}, а для сервера выбрана ${awgName(target)}`] };
    }
    const why = target < profile ? `для сервера выбрана ${awgName(target)}` : `прошивка роутера понимает только ${awgName(target)}`;
    for (const raw of String(custom).split(/\r?\n/)) {
      const line = raw.replace(/#.*/, '').trim();
      if (!line || /^\[\w+\]$/.test(line)) continue;
      const m = line.match(/^([A-Za-z0-9]+)\s*=\s*(.*)$/);
      if (!m) {
        errors.push(`непонятная строка «${line}»`);
        continue;
      }
      const key = Object.keys(EXPERT_PARAMS).find((k) => k.toLowerCase() === m[1].toLowerCase());
      if (!key) {
        if (!EXPERT_SKIPPED.test(m[1])) errors.push(`неизвестный параметр «${m[1]}»`);
        continue;
      }
      values[key] = m[2].trim();
    }
    const portText = String(port).trim();
    if (portText) values.ListenPort = portText;

    for (const [key, value] of Object.entries(values)) {
      const spec = EXPERT_PARAMS[key];
      const bad = (why) => errors.push(`«${key} = ${value}»: ${why}`);
      if (spec.since > target) {
        errors.push(`«${key}» есть только в ${awgName(spec.since)}${spec.since < 3 ? ' и новее' : ''}, а ${why}`);
        continue;
      }
      const min = target === 3 && /^S[1-4]$/.test(key) ? 12 : spec.min; // защита заголовков — S от 12
      if (spec.kind === 'number') {
        if (!/^\d{1,10}$/.test(value) || Number(value) < min || Number(value) > spec.max) bad(`нужно число от ${min} до ${spec.max}`);
      } else if (spec.kind === 'range') {
        const range = parseRange(value);
        if (!range || range[0] < min || range[1] > spec.max) bad(`нужно число или диапазон «от-до» в пределах ${min}–${spec.max}`);
      } else if (spec.kind === 'header') {
        const range = parseRange(value);
        if (!range || range[1] > UINT32_MAX) bad(target === 3 ? 'нужно число или диапазон «от-до» до 4294967295' : 'нужно число до 4294967295');
        else if (target !== 3 && range[0] !== range[1]) bad(`для ${awgName(target)} — только одно число, без диапазона`);
      } else {
        const size = chainSize(value, target);
        if (typeof size === 'string') bad(size);
      }
    }
    if (errors.length) return { text: '', errors };

    // Заголовки разных типов не должны пересекаться; у 3.1 незаданные — 1, 2, 3, 4
    const headers = [1, 2, 3, 4]
      .map((n) => ({ key: `H${n}`, range: parseRange(values[`H${n}`] || (target === 3 ? String(n) : '')) }))
      .filter((h) => h.range);
    headers.forEach((a, i) =>
      headers.slice(i + 1).forEach((b) => {
        if (a.range[0] <= b.range[1] && b.range[0] <= a.range[1]) errors.push(`${a.key} и ${b.key} пересекаются`);
      }),
    );
    // Длины пакетов разных типов — 148+S1, 92+S2, 64+S3, 32+S4 — не должны совпадать
    const sizes = [148, 92, 64, 32]
      .map((base, i) => ({ key: `S${i + 1}`, size: values[`S${i + 1}`] === undefined ? null : base + Number(values[`S${i + 1}`]) }))
      .filter((s) => s.size !== null);
    sizes.forEach((a, i) =>
      sizes.slice(i + 1).forEach((b) => {
        if (a.size === b.size) errors.push(`с такими ${a.key} и ${b.key} пакеты разных типов одной длины`);
      }),
    );
    if (values.Jmin !== undefined && values.Jmax !== undefined && Number(values.Jmin) > Number(values.Jmax)) {
      errors.push('Jmin больше Jmax');
    }
    if (errors.length) return { text: '', errors };

    const lines = Object.entries(values).map(([key, value]) => `${key} = ${value}`);
    if (target >= 2 && ['noise', 'off'].includes(mask)) lines.push(`Mask = ${mask}`); // dns — и так по умолчанию
    if (target < profile) lines.push(`Version = ${target}`);
    return { text: lines.length ? `${lines.join('\n')}\n` : '', errors };
  }

  if (typeof window === 'undefined') {
    // node --test: чистые функции без DOM
    module.exports = {
      awgProfile, awgName, profileNote, pickSubnet, maskPassword, newJob, readStatus, endpointHost, endpointPort, expertOptions, HOST_RE,
      parsePeerLabel, peerTitle, linkText, formatBytes, deviceNameError, deviceFileName, deviceAppNote, formatNote, toBase64, fromBase64,
    };
    return;
  }

  // ---------- роутер ----------

  const { sleep, rciFetch, rciPost, errorsOf, execHelper, openOverlay, cloneButton, watchPage } = window.hostsgenUi;

  const findKey = (node, key) => {
    if (!node || typeof node !== 'object') return undefined;
    if (key in node) return node[key];
    for (const value of Object.values(node)) {
      const found = findKey(value, key);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  async function loadRouter() {
    const [version, interfaces] = await Promise.all([rciFetch('show/version'), rciFetch('show/interface')]);
    const list = Object.values(interfaces || {}).filter((i) => i && typeof i === 'object');
    return { profile: awgProfile(version), title: (version && version.title) || '', interfaces: list };
  }

  /** Штатный импорт WireGuard-конфигурации — тот же вызов, что у кнопки «Загрузить из файла». */
  async function importConf(conf, name) {
    const replies = await rciPost('', [{ interface: { wireguard: { import: { import: btoa(conf), name: '', filename: `${name}.conf` } } } }]);
    const errors = errorsOf(replies);
    if (errors.length) throw new Error(`роутер не принял настройки подключения: ${errors.join('; ')}`);
    const created = findKey(replies, 'created');
    if (!created) throw new Error('роутер не сообщил, какое подключение создал');
    return { created: String(created), intersects: String(findKey(replies, 'intersects') || '') };
  }

  async function peerOnline(name) {
    const replies = await rciPost('', [{ show: { interface: { name } } }]);
    const peers = findKey(replies, 'peer');
    return [].concat(peers || []).some((p) => p && (p.online === true || p.online === 'yes'));
  }

  /**
   * Подключения WireGuard роутера: own — открытый ключ → описание подключения (так окно «Устройства» узнаёт
   * в списке сервера этот роутер), servers — адреса их серверов с описаниями, для подсказки в поле адреса.
   */
  function wireguardOf(interfaces) {
    const own = {};
    const servers = new Map();
    for (const i of interfaces) {
      const wg = i.wireguard;
      if (!wg || typeof wg !== 'object') continue;
      const title = i.description || i.id || i['interface-name'] || '';
      if (wg['public-key']) own[wg['public-key']] = title;
      for (const peer of [].concat(wg.peer || [])) {
        const address = peer && peer['remote-endpoint-address'];
        if (address && HOST_RE.test(address) && !servers.has(address)) servers.set(address, title);
      }
    }
    return { own, servers: [...servers].map(([address, title]) => ({ address, title })) };
  }

  function loadPrefs(key = STORAGE_KEY) {
    try {
      return JSON.parse(localStorage.getItem(key)) || {};
    } catch {
      return {};
    }
  }

  function savePrefs(prefs, key = STORAGE_KEY) {
    try {
      localStorage.setItem(key, JSON.stringify(prefs));
    } catch {
      // приватный режим — просто не запоминаем
    }
  }

  /**
   * Опрашивать vps-status, пока фоновая работа помощника не кончится. onUpdate(job) — после каждой порции
   * журнала; closed() — окно закрыли: роутер доделает сам, а опрос прекращается (тогда — null), даже если
   * работа как раз кончилась: досмотрит её следующее окно, а закрытое ничего не импортирует и не стирает.
   * Работа идёт на роутере сама по себе — один неудачный опрос не повод её бросать.
   */
  async function pollJob(job, { closed = () => false, onUpdate = () => {}, onRetry = () => {} } = {}) {
    for (;;) {
      if (closed()) return null;
      onUpdate(job);
      if (job.state !== 'running' && job.next >= job.total) return job;
      await sleep(job.state === 'running' ? POLL_MS : 0);
      for (let attempt = 1; ; attempt++) {
        try {
          readStatus(await execHelper(['vps-status', job.next]), job);
          break;
        } catch (err) {
          if (attempt >= 5 || /сессия истекла/.test(err.message)) throw err;
          onRetry(err);
          await sleep(3000);
        }
      }
    }
  }

  /** Список шагов в окне: текущий «…», готовые «✓», ошибка «✕», предупреждения оранжевым «!». */
  function makeSteps(list) {
    const steps = { items: [], shown: 0, warned: false };
    const draw = () => {
      list.textContent = '';
      for (const step of steps.items) {
        const li = document.createElement('li');
        li.textContent = step.text;
        li.className = { now: 'hg-now', done: 'hg-done', fail: 'hg-fail', warn: 'hg-warn' }[step.state];
        list.append(li);
      }
    };
    steps.reset = () => {
      steps.items = [];
      steps.shown = 0;
      steps.warned = false;
      draw();
    };
    steps.push = (text) => {
      steps.items.forEach((s) => {
        if (s.state === 'now') s.state = 'done';
      });
      steps.items.push({ text, state: 'now' });
      draw();
    };
    // предупреждение — отдельной строкой; текущий шаг остаётся текущим
    steps.warn = (text) => {
      steps.items.push({ text, state: 'warn' });
      steps.warned = true;
      draw();
    };
    steps.finish = (ok) => {
      const last = steps.items.filter((s) => s.state === 'now').pop();
      if (last) last.state = ok ? 'done' : 'fail';
      draw();
    };
    /** Новые шаги и предупреждения из журнала работы помощника. */
    steps.sync = (job) => {
      for (; steps.shown < job.steps.length; steps.shown++) {
        const step = job.steps[steps.shown];
        if (step.warn) steps.warn(step.text);
        else steps.push(step.text);
      }
    };
    return steps;
  }

  /** Пароль сервера → hex для vps-start и vps-device: маска — новая на каждый запуск. */
  async function maskedPassword(password) {
    const pad = (await execHelper(['vps-pad'])).map((l) => l.trim()).find((l) => /^[0-9a-f]{64,}$/.test(l));
    if (!pad) throw new Error('модуль на роутере устарел — переустановите его');
    return maskPassword(password, pad);
  }

  /** Запустить фоновую работу помощника; он отвечает «started», иначе — что помешало. */
  async function startJob(args) {
    const out = await execHelper(args);
    if (!out.some((l) => l.trim() === 'started')) {
      throw new Error(out.filter((l) => l.trim() && l !== 'process terminated').join('; ') || 'помощник на роутере не начал работу с сервером');
    }
  }

  // ---------- окно ----------

  const TEMPLATE = `
<div class="hg-dialog" role="dialog" aria-modal="true" aria-labelledby="hv-title">
  <div class="hg-head">
    <h2 class="hg-title" id="hv-title">VPN на своём сервере</h2>
    <button type="button" class="hg-x" data-role="close" aria-label="Закрыть">×</button>
  </div>
  <div class="hg-body">
    <div data-role="form">
      <p class="hg-hint">Роутер сам зайдёт на сервер по SSH, установит Docker и AmneziaWG и создаст здесь подключение. Нужен VPS на Ubuntu (лучше 22.04) с доступом root по паролю. Займёт 3–5 минут.</p>
      <div class="hg-row">
        <label class="hg-field"><span class="hg-label">IP-адрес или домен сервера</span><input class="hg-input" data-role="host" placeholder="203.0.113.10" autocomplete="off" spellcheck="false"></label>
        <label class="hg-field hg-field--narrow"><span class="hg-label">Порт SSH</span><input class="hg-input" data-role="port" value="22" inputmode="numeric" maxlength="5"></label>
      </div>
      <div class="hg-row">
        <label class="hg-field"><span class="hg-label">Логин</span><input class="hg-input" data-role="user" value="root" autocomplete="off" spellcheck="false"></label>
        <label class="hg-field"><span class="hg-label">Пароль</span><input class="hg-input" data-role="password" type="password" autocomplete="off"></label>
      </div>
      <div class="hg-row">
        <label class="hg-field"><span class="hg-label">Название подключения</span><input class="hg-input" data-role="name" maxlength="48" placeholder="например, VPN Нидерланды"></label>
      </div>
      <ul class="hg-notes">
        <li data-role="profile">Проверяю, какую версию AmneziaWG понимает прошивка…</li>
        <li>Пароль нужен один раз: роутер не сохраняет его и не пишет в журнал.</li>
        <li>Если сервер уже настраивали этой кнопкой, на нём ничего не переустановится — добавится ещё одно подключение. Параметры маскировки у каждого роутера свои, поэтому один сервер можно отдать нескольким людям.</li>
        <li>Телефон или компьютер к этому серверу подключаются кнопкой «Добавить устройство».</li>
      </ul>
      <details class="hg-expert" data-role="expert">
        <summary>Для опытных</summary>
        <p class="hg-hint">Обычно здесь ничего менять не нужно: параметры маскировки AmneziaWG и так выбираются случайно — свои у каждого сервера и у каждого роутера.</p>
        <div class="hg-row" data-role="version-row">
          <label class="hg-field"><span class="hg-label">Версия AmneziaWG нового сервера</span><select class="hg-select" data-role="version"></select></label>
        </div>
        <div class="hg-row">
          <label class="hg-field" data-role="mask-field"><span class="hg-label">Пакет перед рукопожатием (I1)</span><select class="hg-select" data-role="mask"><option value="dns">Похож на DNS-запрос</option><option value="noise">Случайные байты</option><option value="off">Не отправлять</option></select></label>
          <label class="hg-field hg-field--narrow"><span class="hg-label">UDP-порт VPN</span><input class="hg-input" data-role="awg-port" placeholder="любой" inputmode="numeric" maxlength="5"></label>
        </div>
        <div class="hg-row">
          <label class="hg-field"><span class="hg-label">Свои параметры AmneziaWG — строки «Параметр = значение»</span><textarea class="hg-text hg-text--short" data-role="custom" spellcheck="false" placeholder="Jc = 4&#10;Jmin = 40&#10;Jmax = 120&#10;I1 = &lt;r 2&gt;&lt;b 0x…&gt;"></textarea></label>
        </div>
        <p class="hg-hint hg-hint--small">Версия AmneziaWG, порт, S1–S4 и H1–H4 общие для сервера и всех его роутеров — они действуют, только когда сервер настраивается впервые. Остальное (Jc, Jmin, Jmax, I1–I5, таймеры, MTU) — параметры этого роутера. Ключи и адреса из вставленной конфигурации мастер пропускает: их он создаёт сам.</p>
      </details>
    </div>
    <div data-role="progress" hidden>
      <ul class="hg-steps" data-role="steps"></ul>
      <details class="hg-log"><summary>Подробный журнал</summary><pre data-role="log"></pre></details>
      <p class="hg-hint" data-role="background" hidden>Окно можно закрыть — роутер закончит настройку сам. Откройте его снова этой же кнопкой, чтобы увидеть результат и создать подключение.</p>
    </div>
    <div class="hg-status" data-role="status" aria-live="polite"></div>
  </div>
  <div class="hg-foot">
    <button type="button" class="hg-btn" data-role="secondary">Отмена</button>
    <button type="button" class="hg-btn hg-btn--primary" data-role="primary">Создать подключение</button>
  </div>
</div>`;

  function openDialog() {
    const state = { busy: false, closed: false, router: null, view: 'form' };
    const dialog = openOverlay(TEMPLATE, {
      onClose: () => {
        state.closed = true;
      },
    });
    if (!dialog) return;
    const { $, close } = dialog;
    const prefs = loadPrefs();
    if (prefs.port) $('port').value = prefs.port;
    if (prefs.user) $('user').value = prefs.user;
    const steps = makeSteps($('steps'));

    const setStatus = (text, kind = '') => {
      $('status').textContent = text;
      $('status').classList.toggle('hg-status--error', kind === 'error');
      $('status').classList.toggle('hg-status--ok', kind === 'ok');
    };

    // Виды окна: form — ввод, progress — настройка сервера, finishing — создание подключения в роутере,
    // finished — готово, failed — ошибка
    const show = (view) => {
      state.view = view;
      $('form').hidden = view !== 'form';
      $('progress').hidden = view === 'form';
      $('background').hidden = view !== 'progress';
      const buttons = {
        form: ['Отмена', 'Создать подключение'],
        progress: ['Прервать настройку', null],
        finishing: [null, null],
        finished: [null, 'Готово'],
        failed: ['Закрыть', 'Назад к настройкам'],
      }[view];
      $('secondary').hidden = !buttons[0];
      $('secondary').textContent = buttons[0] || '';
      $('primary').hidden = !buttons[1];
      $('primary').textContent = buttons[1] || '';
    };

    const run = async (task) => {
      if (state.busy) return;
      state.busy = true;
      $('primary').disabled = true;
      try {
        await task();
      } catch (err) {
        if (state.view === 'progress' || state.view === 'finishing') {
          steps.finish(false);
          show('failed');
        }
        setStatus(`Ошибка: ${err.message}`, 'error');
      } finally {
        state.busy = false;
        $('primary').disabled = false;
      }
    };

    // Следить за настройкой на роутере, пока она идёт; журнал может прийти несколькими порциями
    const follow = async (job) => {
      show('progress');
      setStatus('');
      const done = await pollJob(job, {
        closed: () => state.closed,
        onUpdate: () => {
          steps.sync(job);
          $('log').textContent = job.log.slice(-400).join('\n');
          setStatus('');
        },
        onRetry: (err) => setStatus(`Роутер не ответил (${err.message}) — спрашиваю ещё раз…`),
      });
      if (!done) return null; // окно закрыли: роутер доделает сам
      if (job.state !== 'done' || !job.conf) {
        if (job.state === 'lost') throw new Error('настройка прервалась — роутер перезагружался или модуль переустанавливали');
        throw new Error(job.error || 'настройка сервера не удалась — подробности в журнале');
      }
      return job.conf;
    };

    // Сервер готов: создать подключение штатным импортом, назвать, включить и дождаться связи
    const finish = async (conf) => {
      const name = ($('name').value.trim() || prefs.name || `VPS ${endpointHost(conf)}`).slice(0, 48);
      show('finishing');
      steps.push('Создаю подключение в роутере');
      const { created, intersects } = await importConf(conf, name);
      await execHelper(['vps-clear']).catch(() => {}); // в журнале был ключ подключения — больше не нужен
      const replies = await rciPost('', [
        { interface: { name: created, description: name } },
        { interface: { name: created, up: true } },
        { system: { configuration: { save: {} } } },
      ]);
      const errors = errorsOf(replies);
      if (errors.length) throw new Error(`подключение ${created} создано, но не включилось: ${errors.join('; ')}`);

      steps.push('Проверяю связь с сервером');
      let online = false;
      for (let waited = 0; waited < CHECK_SECONDS && !online && !state.closed; waited += 2) {
        await sleep(2000);
        online = await peerOnline(created).catch(() => false);
      }
      steps.finish(online);
      show('finished');
      const tips = 'Чтобы пустить через VPN весь интернет, откройте подключение и включите «Использовать для выхода в интернет». ' +
        'Чтобы только отдельные сайты — «Маршрутизация» → «Добавить списком».';
      const overlap = intersects ? ` Сеть VPN пересекается с подключениями: ${intersects}.` : '';
      const warned = steps.warned ? ' Обратите внимание на предупреждение в списке шагов.' : '';
      if (online) setStatus(`Готово: подключение «${name}» (${created}) работает.${warned} ${tips}${overlap}`, 'ok');
      else {
        // Чаще всего так бывает, когда облачный брандмауэр хостинга не пускает UDP к серверу
        const port = endpointPort(conf);
        setStatus(`Подключение «${name}» (${created}) создано, но сервер пока не ответил. Подождите минуту и обновите страницу; ` +
          `если связи так и не будет, откройте входящий ${port ? `UDP-порт ${port}` : 'UDP-порт сервера'} в брандмауэре (группах безопасности) ` +
          `в панели хостинга.${overlap} ${tips}`, 'error');
      }
    };

    const start = async () => {
      const host = $('host').value.trim();
      const port = $('port').value.trim() || '22';
      const user = $('user').value.trim() || 'root';
      const password = $('password').value;
      if (!HOST_RE.test(host)) throw new Error('укажите IP-адрес или домен сервера');
      if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('неверный порт SSH');
      if (!/^[a-z_][a-z0-9_.-]{0,31}$/.test(user)) throw new Error('неверный логин');
      if (!password) throw new Error('введите пароль от сервера');
      if (!state.router) state.router = await loadRouter();
      const options = expertOptions(
        { mask: $('mask').value, port: $('awg-port').value, custom: $('custom').value, version: $('version').value },
        state.router.profile,
      );
      if (options.errors.length) {
        $('expert').open = true;
        throw new Error(`в разделе «Для опытных»: ${options.errors.join('; ')}`);
      }
      const subnet = pickSubnet(state.router.interfaces.map((i) => ({ address: i.address, mask: i.mask })));
      if (!subnet) throw new Error('не нашёл свободную сеть для VPN среди 10.64.0.0–10.127.255.0');
      savePrefs({ port, user, name: $('name').value.trim() });

      const secret = await maskedPassword(password);
      $('password').value = '';
      const args = ['vps-start', host, port, user, secret, state.router.profile, subnet];
      if (options.text) args.push(btoa(options.text)); // восьмой, последний аргумент exec
      await startJob(args);
      steps.reset();
      const conf = await follow(readStatus([], { ...newJob(), state: 'running' }));
      if (conf) await finish(conf);
    };

    // Пакета I1 в AmneziaWG 1.0 нет
    const updateMask = () => {
      $('mask-field').hidden = Number($('version').value || (state.router && state.router.profile) || 1) < 2;
    };
    $('version').addEventListener('change', updateMask);

    $('close').addEventListener('click', close);
    $('secondary').addEventListener('click', () => {
      if (state.view === 'progress') {
        execHelper(['vps-cancel']).catch(() => {});
        setStatus('Прерываю настройку…');
      } else {
        close();
      }
    });
    $('primary').addEventListener('click', () => {
      if (state.view === 'finished') {
        close();
        location.reload();
      } else if (state.view === 'failed') {
        show('form');
        setStatus('');
      } else {
        run(start);
      }
    });

    // При открытии: какая AmneziaWG доступна и не идёт ли уже настройка (окно могли закрыть посреди неё)
    show('form');
    setStatus('Проверяю роутер…');
    run(async () => {
      state.router = await loadRouter();
      const { profile } = state.router;
      $('profile').textContent = profileNote(profile, state.router.title);
      // Версии нового сервера — не новее той, что понимает прошивка
      for (let v = profile; v >= 1; v--) {
        const option = document.createElement('option');
        option.value = String(v);
        option.textContent = `${awgName(v)} — ${v === 1 ? 'подойдёт роутерам с любой прошивкой' : `для роутеров с KeeneticOS ${v === 3 ? '5.2' : '5.1'} и новее`}`;
        $('version').append(option);
      }
      $('version-row').hidden = profile === 1;
      updateMask();
      const job = readStatus(await execHelper(['vps-status', 0]), newJob());
      setStatus('');
      if (job.kind === 'device') {
        // журнал окна «Добавить устройство» — не наш; пока оно работает с сервером, помощник занят
        if (job.state === 'running') setStatus('Сейчас роутер работает с сервером в окне «Добавить устройство» — дождитесь, пока оно закончит.', 'error');
      } else if (job.state === 'running' || (job.state === 'done' && job.next < job.total) || (job.state === 'done' && job.conf)) {
        const conf = await follow(job);
        if (conf) await finish(conf);
      } else if ((job.state === 'failed' || job.state === 'lost') && job.error) {
        setStatus(`Прошлая попытка не удалась: ${job.error}`, 'error');
      }
    }).then(() => {
      if (state.view === 'form') $('host').focus();
    });
  }

  // ---------- окно «Устройства на своём сервере» ----------

  const DEVICES_TEMPLATE = `
<div class="hg-dialog" role="dialog" aria-modal="true" aria-labelledby="hd-title">
  <div class="hg-head">
    <h2 class="hg-title" id="hd-title">Устройства на своём сервере</h2>
    <button type="button" class="hg-x" data-role="close" aria-label="Закрыть">×</button>
  </div>
  <div class="hg-body">
    <div data-role="login">
      <p class="hg-hint">Телефон, компьютер или роутер другой марки можно подключить к серверу, который настроен кнопкой «Создать на своём сервере». Каждое устройство получает своё подключение со своим ключом, а ненужное можно удалить.</p>
      <div class="hg-row">
        <label class="hg-field"><span class="hg-label">IP-адрес или домен сервера</span><input class="hg-input" data-role="host" list="hd-servers" placeholder="203.0.113.10" autocomplete="off" spellcheck="false"></label>
        <label class="hg-field hg-field--narrow"><span class="hg-label">Порт SSH</span><input class="hg-input" data-role="port" value="22" inputmode="numeric" maxlength="5"></label>
      </div>
      <datalist id="hd-servers" data-role="servers"></datalist>
      <div class="hg-row">
        <label class="hg-field"><span class="hg-label">Логин</span><input class="hg-input" data-role="user" value="root" autocomplete="off" spellcheck="false"></label>
        <label class="hg-field"><span class="hg-label">Пароль</span><input class="hg-input" data-role="password" type="password" autocomplete="off"></label>
      </div>
      <ul class="hg-notes">
        <li>Пароль нужен, чтобы роутер зашёл на сервер. Роутер его не сохраняет; пока окно открыто, его помнит только эта страница — закроете окно, и пароль понадобится снова.</li>
        <li>Другой роутер Keenetic лучше подключить его собственной кнопкой «Создать на своём сервере»: так он получит настройки под свою прошивку.</li>
      </ul>
    </div>
    <div data-role="progress" hidden>
      <ul class="hg-steps" data-role="steps"></ul>
      <details class="hg-log"><summary>Подробный журнал</summary><pre data-role="log"></pre></details>
    </div>
    <div data-role="list" hidden>
      <p class="hg-hint" data-role="server-note"></p>
      <div class="hg-tablewrap"><table class="hg-table hg-devices">
        <thead><tr><th>Подключение</th><th>Адрес в VPN</th><th>Связь</th><th></th></tr></thead>
        <tbody data-role="peers"></tbody>
      </table></div>
      <div class="hg-row">
        <label class="hg-field"><span class="hg-label">Новое устройство</span><input class="hg-input" data-role="device-name" maxlength="${DEVICE_NAME_MAX}" placeholder="например, Телефон Паши" autocomplete="off"></label>
        <button type="button" class="hg-btn hg-btn--primary" data-role="add">Добавить устройство</button>
      </div>
      <p class="hg-hint hg-hint--small" data-role="app-note"></p>
    </div>
    <div data-role="result" hidden>
      <p class="hg-summary" data-role="result-title"></p>
      <div class="hg-qr" data-role="qr"></div>
      <ol class="hg-notes">
        <li>Установите на устройство приложение AmneziaVPN (App Store, Google Play или amnezia.org для компьютеров) или AmneziaWG.</li>
        <li>В приложении добавьте подключение по QR-коду и наведите камеру на код. На компьютере — из файла: скачайте его кнопкой ниже.</li>
      </ol>
      <p class="hg-hint hg-hint--small" data-role="result-app"></p>
      <div class="hg-row">
        <button type="button" class="hg-btn" data-role="download">Скачать файл .conf</button>
      </div>
      <details class="hg-log"><summary>Настройки текстом</summary><textarea class="hg-text hg-text--short" data-role="conf-text" readonly spellcheck="false"></textarea></details>
      <p class="hg-hint hg-hint--small">QR-код и файл — это ключ к вашему VPN: кто их получит, тот сможет им пользоваться. Отправляйте только тем, кому доверяете. Роутер их не сохраняет — после закрытия окна показать их снова нельзя; если не успели, удалите устройство и добавьте заново.</p>
    </div>
    <div class="hg-status" data-role="status" aria-live="polite"></div>
  </div>
  <div class="hg-foot">
    <button type="button" class="hg-btn" data-role="secondary">Отмена</button>
    <button type="button" class="hg-btn hg-btn--primary" data-role="primary">Показать устройства</button>
  </div>
</div>`;

  function openDevices() {
    // password — только в памяти, пока окно открыто: каждая операция — новый вход на сервер по SSH
    const state = { busy: false, closed: false, view: 'login', password: '', target: null, own: {}, peers: [], server: null, now: 0, conf: null, added: 'новое устройство' };
    const dialog = openOverlay(DEVICES_TEMPLATE, {
      onClose: () => {
        state.closed = true;
        state.password = '';
        state.conf = null;
      },
    });
    if (!dialog) return;
    const { $, close } = dialog;
    const { qrMatrix, qrSvg } = window.hostsgenUi;
    const prefs = loadPrefs(DEVICES_KEY);
    if (prefs.host) $('host').value = prefs.host;
    if (prefs.port) $('port').value = prefs.port;
    if (prefs.user) $('user').value = prefs.user;
    const steps = makeSteps($('steps'));

    const setStatus = (text, kind = '') => {
      $('status').textContent = text;
      $('status').classList.toggle('hg-status--error', kind === 'error');
      $('status').classList.toggle('hg-status--ok', kind === 'ok');
    };

    // Виды окна: login — сервер и пароль, progress — роутер работает с сервером, list — подключения сервера,
    // result — новое устройство (QR-код и файл), failed — ошибка
    const show = (view) => {
      state.view = view;
      for (const part of ['login', 'progress', 'list', 'result']) $(part).hidden = part !== (view === 'failed' ? 'progress' : view);
      const buttons = {
        login: ['Отмена', 'Показать устройства'],
        progress: ['Прервать', null],
        list: ['Закрыть', 'Обновить список'],
        result: ['Закрыть', 'К списку устройств'],
        failed: ['Закрыть', 'Назад'],
      }[view];
      $('secondary').hidden = !buttons[0];
      $('secondary').textContent = buttons[0] || '';
      $('primary').hidden = !buttons[1];
      $('primary').textContent = buttons[1] || '';
      if (view !== 'result') forgetConf();
    };

    // Настройки устройства — только пока они на экране
    const forgetConf = () => {
      state.conf = null;
      $('qr').textContent = '';
      $('conf-text').value = '';
    };

    const run = async (task) => {
      if (state.busy) return;
      state.busy = true;
      const buttons = [$('primary'), $('add'), ...$('peers').querySelectorAll('button')];
      buttons.forEach((b) => {
        b.disabled = true;
      });
      try {
        await task();
      } catch (err) {
        if (state.view === 'progress') {
          steps.finish(false);
          show('failed');
        }
        setStatus(`Ошибка: ${err.message}`, 'error');
      } finally {
        state.busy = false;
        buttons.forEach((b) => {
          b.disabled = false;
        });
      }
    };

    const showList = () => {
      const tbody = $('peers');
      tbody.textContent = '';
      const cell = (tr, text, className = '') => {
        const td = document.createElement('td');
        if (className) td.className = className;
        td.textContent = text;
        tr.append(td);
        return td;
      };
      for (const peer of state.peers) {
        const tr = document.createElement('tr');
        const own = state.own[peer.key];
        const title = peerTitle(peer, own);
        const name = cell(tr, title);
        const sub = document.createElement('div');
        sub.className = 'hg-muted hg-small';
        sub.textContent = [peer.kind === 'device' ? 'устройство' : peer.kind === 'router' && own ? 'роутер Keenetic' : '', peer.added && `добавлено ${peer.added}`]
          .filter(Boolean).join(', ');
        if (sub.textContent) name.append(sub);
        cell(tr, peer.address || '—', 'hg-net');
        const link = cell(tr, linkText(peer, state.now));
        if (peer.rx || peer.tx) {
          const traffic = document.createElement('div');
          traffic.className = 'hg-muted hg-small';
          traffic.textContent = `трафик ${formatBytes(peer.rx + peer.tx)}`;
          link.append(traffic);
        }
        const actions = cell(tr, '');
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'hg-btn hg-btn--small';
        remove.textContent = 'Удалить';
        remove.addEventListener('click', () =>
          run(async () => {
            const question = own
              ? `Это подключение этого роутера (${own}). После удаления оно перестанет работать. Всё равно удалить?`
              : `Удалить «${title}»? С этими настройками к серверу больше нельзя будет подключиться.`;
            if (!window.confirm(question)) return;
            await operate('remove', peer.key);
            if (state.view === 'list') setStatus(`«${title}» удалено с сервера.`, 'ok');
          }),
        );
        actions.append(remove);
        tr.append(actions);
        tbody.append(tr);
      }
      if (!state.peers.length) {
        const tr = document.createElement('tr');
        cell(tr, 'Подключений на сервере нет', 'hg-muted').colSpan = 4;
        tbody.append(tr);
      }
      const { profile, port } = state.server || {};
      const count = state.peers.length;
      $('server-note').textContent = `Сервер ${state.target ? state.target.host : ''}: ${awgName(profile)}, UDP-порт ${port || '—'}, ` +
        `${count} ${plural(count, 'подключение', 'подключения', 'подключений')}. ${formatNote(state.server && state.server.format)}`;
      $('app-note').textContent = deviceAppNote(profile);
      show('list');
    };

    const showResult = () => {
      const { conf } = state;
      show('result');
      // L — на экране код не пачкается, а модули крупнее и камера читает его легче
      $('qr').innerHTML = qrSvg(qrMatrix(conf, 'L'), 320);
      $('conf-text').value = conf;
      $('result-title').textContent = `Устройство «${state.added}» добавлено на сервер. Отсканируйте QR-код в приложении на нём.`;
      $('result-app').textContent = deviceAppNote(state.server && state.server.profile);
      setStatus('');
    };

    // Работа помощника с сервером: шаги, затем список подключений и, после добавления, настройки устройства
    const watch = async (job) => {
      show('progress');
      setStatus('');
      const done = await pollJob(job, {
        closed: () => state.closed,
        onUpdate: () => {
          steps.sync(job);
          $('log').textContent = job.log.slice(-400).join('\n');
          setStatus('');
        },
        onRetry: (err) => setStatus(`Роутер не ответил (${err.message}) — спрашиваю ещё раз…`),
      });
      if (!done) return; // окно закрыли: роутер доделает сам, результат покажет следующее окно
      if (job.state !== 'done' || !job.server) {
        if (/логин или пароль/.test(job.error || '')) state.password = '';
        if (job.state === 'lost') throw new Error('работа с сервером прервалась — роутер перезагружался или модуль переустанавливали');
        throw new Error(job.error || 'не получилось — подробности в журнале');
      }
      steps.finish(true);
      await execHelper(['vps-clear']).catch(() => {}); // в журнале могли быть настройки устройства с ключом
      Object.assign(state, { peers: job.peers, server: job.server, now: job.now });
      if (job.conf) {
        // имя — из шага сценария: окно могли открыть заново, и своего имени у него нет
        const step = job.steps.find((s) => s.code === 'config');
        const added = step && step.text.match(/^Добавляю устройство «(.*)» \(/);
        if (added) state.added = added[1];
        state.conf = job.conf;
        showResult();
      } else {
        showList();
      }
    };

    // Одна операция на сервере: vps-device … list | device ИМЯ | remove КЛЮЧ
    const operate = async (action, arg) => {
      if (!state.password || !state.target) {
        show('login');
        throw new Error('чтобы продолжить, введите пароль от сервера ещё раз');
      }
      const { host, port, user } = state.target;
      const args = ['vps-device', host, port, user, await maskedPassword(state.password), action];
      if (arg) args.push(arg);
      await startJob(args);
      steps.reset();
      await watch(readStatus([], { ...newJob(), kind: 'device', state: 'running' }));
    };

    const login = async () => {
      const host = $('host').value.trim();
      const port = $('port').value.trim() || '22';
      const user = $('user').value.trim() || 'root';
      const password = $('password').value;
      if (!HOST_RE.test(host)) throw new Error('укажите IP-адрес или домен сервера');
      if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('неверный порт SSH');
      if (!/^[a-z_][a-z0-9_.-]{0,31}$/.test(user)) throw new Error('неверный логин');
      if (!password && !state.password) throw new Error('введите пароль от сервера');
      if (password) state.password = password;
      $('password').value = '';
      state.target = { host, port, user };
      savePrefs({ host, port, user }, DEVICES_KEY);
      await operate('list');
    };

    const add = async () => {
      const name = $('device-name').value.trim();
      const error = deviceNameError(name);
      if (error) throw new Error(error);
      if (state.peers.some((p) => p.kind === 'device' && p.name === name) &&
        !window.confirm(`Устройство «${name}» на сервере уже есть. Добавить ещё одно с таким же именем?`)) return;
      state.added = name;
      await operate('device', toBase64(name));
      $('device-name').value = '';
    };

    $('close').addEventListener('click', close);
    $('secondary').addEventListener('click', () => {
      if (state.view === 'progress') {
        execHelper(['vps-cancel']).catch(() => {});
        setStatus('Прерываю…');
      } else {
        close();
      }
    });
    $('primary').addEventListener('click', () => {
      if (state.view === 'login') run(login);
      else if (state.view === 'list') run(() => operate('list'));
      else if (state.view === 'result') {
        showList();
        setStatus('');
      } else if (state.view === 'failed') {
        if (state.password && state.server) showList();
        else show('login');
      }
    });
    $('add').addEventListener('click', () => run(add));
    $('download').addEventListener('click', () => {
      if (!state.conf) return;
      const url = URL.createObjectURL(new Blob([state.conf], { type: 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = deviceFileName(state.added);
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
    $('conf-text').addEventListener('focus', () => $('conf-text').select());

    // При открытии: подключения роутера (свои ключи и адреса серверов) и не идёт ли уже работа с сервером
    show('login');
    setStatus('Проверяю роутер…');
    run(async () => {
      const router = await loadRouter();
      const { own, servers } = wireguardOf(router.interfaces);
      state.own = own;
      for (const server of servers) {
        const option = document.createElement('option');
        option.value = server.address;
        option.label = server.title;
        $('servers').append(option);
      }
      if (!$('host').value && servers.length === 1) $('host').value = servers[0].address;
      const job = readStatus(await execHelper(['vps-status', 0]), newJob());
      setStatus('');
      if (job.kind === 'device' && (job.state === 'running' || (job.state === 'done' && job.next < job.total) || job.conf)) {
        // окно закрыли посреди работы — досмотреть её; пароль для следующих операций спросим заново
        state.target = { host: $('host').value.trim(), port: $('port').value.trim(), user: $('user').value.trim() };
        steps.reset();
        await watch(job);
      } else if (job.kind !== 'device' && job.state === 'running') {
        setStatus('Сейчас роутер настраивает сервер в окне «Создать на своём сервере» — дождитесь, пока оно закончит.', 'error');
      }
    }).then(() => {
      if (state.view === 'login') ($('host').value ? $('password') : $('host')).focus();
    });
  }

  // ---------- кнопки на странице ----------

  // Кнопки — копии штатной «Загрузить из файла» в блоке WireGuard, после штатных
  const BUTTONS = [
    {
      marker: 'data-hostsgen-vps',
      label: 'Создать на своём сервере',
      icon: 'globe',
      title: 'Роутер сам настроит AmneziaWG на вашем VPS и создаст подключение',
      onClick: openDialog,
    },
    {
      marker: 'data-hostsgen-devices',
      label: 'Добавить устройство',
      icon: 'qr_code',
      title: 'Подключить телефон или компьютер к вашему VPS: QR-код или файл для приложения AmneziaVPN',
      onClick: openDevices,
    },
  ];

  function injectButton() {
    if (!/\/otherConnections\/?$/.test(location.pathname)) return;
    const row = document.querySelector('.wireguard__buttons');
    if (!row || BUTTONS.every((b) => row.querySelector(`[${b.marker}]`))) return;
    const native = [...row.querySelectorAll('ndw-button')].filter((el) => !BUTTONS.some((b) => el.hasAttribute(b.marker)));
    const template = native[1] || native[0];
    if (!template) return;
    let last = native[native.length - 1];
    for (const spec of BUTTONS) {
      const existing = row.querySelector(`[${spec.marker}]`);
      if (existing) {
        last = existing;
        continue;
      }
      const host = cloneButton(template, spec);
      if (!host) return;
      last.after(host);
      last = host;
    }
  }

  watchPage(injectButton);
})();
