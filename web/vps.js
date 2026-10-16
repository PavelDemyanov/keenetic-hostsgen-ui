/*
 * hostsgen-ui — кнопка «Создать на своём сервере» в блоке WireGuard на странице «Интернет → Другие
 * подключения» KeeneticOS. Адрес VPS, логин и пароль root → роутер сам заходит на сервер по SSH,
 * ставит там AmneziaWG (server/vps-setup.sh через helper/hostsgen-ui.c vps-*) и создаёт подключение
 * тем же импортом конфигурации, что и штатная кнопка «Загрузить из файла».
 */
(() => {
  'use strict';

  const POLL_MS = 1500; // как часто спрашивать помощника о ходе настройки
  const CHECK_SECONDS = 40; // сколько ждать рукопожатия с сервером после создания подключения
  const STORAGE_KEY = 'hostsgen-ui-vps';

  // ---------- чистые функции ----------

  const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
  const ipToInt = (ip) => ip.split('.').reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
  const overlaps = (a, maskA, b, maskB) => {
    const m = (maskA & maskB) >>> 0;
    return ((a & m) >>> 0) === ((b & m) >>> 0);
  };

  /**
   * Какую AmneziaWG понимает прошивка (ответ show version): 3 — AmneziaWG 3.1, она появилась
   * в KeeneticOS 5.2 Alpha 11; прошивки постарше — только 1.0.
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
    if (major !== 5) return major > 5 ? 3 : 1;
    if (minor !== 2) return minor > 2 ? 3 : 1;
    return alpha !== null && alpha < 11 ? 1 : 3;
  }

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

  const newJob = () => ({ state: 'none', next: 0, total: 0, steps: [], log: [], error: null, conf: null, confLines: null, done: false });

  /**
   * Очередная порция vps-status: «@@state СОСТОЯНИЕ СЛЕДУЮЩАЯ_СТРОКА ВСЕГО_СТРОК», дальше журнал
   * со строками сценария «@@step КОД ТЕКСТ», «@@error ТЕКСТ», @@conf-begin … @@conf-end, @@done.
   */
  function readStatus(lines, job) {
    for (const raw of lines) {
      const line = String(raw).replace(/\r$/, '');
      const state = line.match(/^@@state (\S+) (\d+) (\d+)$/);
      if (state) {
        job.state = state[1];
        job.next = Number(state[2]);
        job.total = Number(state[3]);
      } else if (line === '@@conf-begin') {
        job.confLines = [];
      } else if (line === '@@conf-end') {
        job.conf = job.confLines ? atob(job.confLines.join('')) : null;
        job.confLines = null;
      } else if (job.confLines) {
        job.confLines.push(line.trim());
      } else if (line.startsWith('@@step ')) {
        const [, code = '', text = ''] = line.match(/^@@step (\S+) ?(.*)$/) || [];
        job.steps.push({ code, text });
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

  /** Адрес сервера из строки Endpoint готовой конфигурации. */
  const endpointHost = (conf) => ((conf || '').match(/^Endpoint\s*=\s*(.+):\d+\s*$/m) || [])[1] || '';

  // ---------- настройки «Для опытных» ----------

  /*
   * Параметры AmneziaWG, которые можно задать вручную. shared — общие для сервера и всех его роутеров:
   * действуют, только когда сервер настраивается впервые; v3 — есть только в AmneziaWG 3.1.
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
    S3: { kind: 'number', min: 12, max: 1216, shared: true, v3: true },
    S4: { kind: 'number', min: 12, max: 32, shared: true, v3: true },
    H1: { kind: 'header', shared: true },
    H2: { kind: 'header', shared: true },
    H3: { kind: 'header', shared: true },
    H4: { kind: 'header', shared: true },
    I1: { kind: 'chain', v3: true },
    I2: { kind: 'chain', v3: true },
    I3: { kind: 'chain', v3: true },
    I4: { kind: 'chain', v3: true },
    I5: { kind: 'chain', v3: true },
    ContentPaddingAddition: { kind: 'range', min: 0, max: 1000, v3: true },
    RekeyAfterTime: { kind: 'range', min: 30, max: 140, v3: true },
    RekeyTimeout: { kind: 'range', min: 1, max: 20, v3: true },
    RejectAfterTime: { kind: 'range', min: 150, max: 600, v3: true },
    KeepaliveTimeout: { kind: 'range', min: 1, max: 60, v3: true },
    MaxHandshakeAttempts: { kind: 'range', min: 1, max: 60, v3: true },
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

  /** Длина пакета I1–I5 в байтах или текст ошибки: теги <b 0x…>, <r N>, <rd N>, <rc N>, <t>. */
  function chainSize(value) {
    if (/<c>/.test(value)) return 'тег <c> прошивка Keenetic не принимает';
    if (!/^(<(b 0x([0-9a-f]{2})+|r \d{1,4}|rd \d{1,4}|rc \d{1,4}|t)>)+$/i.test(value)) {
      return 'нужна цепочка тегов <b 0x…>, <r N>, <rd N>, <rc N>, <t>';
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
   * port — UDP-порт сервера. profile — версия AmneziaWG, которую понимает прошивка (awgProfile).
   */
  function expertOptions({ mask = 'dns', port = '', custom = '' } = {}, profile = 3) {
    const values = {};
    const errors = [];
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
      if (spec.v3 && profile !== 3) {
        errors.push(`«${key}» есть только в AmneziaWG 3.1, а прошивка роутера понимает 1.0`);
        continue;
      }
      const min = profile === 3 && /^S[1-4]$/.test(key) ? 12 : spec.min; // защита заголовков — S от 12
      if (spec.kind === 'number') {
        if (!/^\d{1,10}$/.test(value) || Number(value) < min || Number(value) > spec.max) bad(`нужно число от ${min} до ${spec.max}`);
      } else if (spec.kind === 'range') {
        const range = parseRange(value);
        if (!range || range[0] < min || range[1] > spec.max) bad(`нужно число или диапазон «от-до» в пределах ${min}–${spec.max}`);
      } else if (spec.kind === 'header') {
        const range = parseRange(value);
        if (!range || range[1] > UINT32_MAX) bad(profile === 3 ? 'нужно число или диапазон «от-до» до 4294967295' : 'нужно число до 4294967295');
        else if (profile !== 3 && range[0] !== range[1]) bad('AmneziaWG 1.0 понимает только одно число, без диапазона');
      } else {
        const size = chainSize(value);
        if (typeof size === 'string') bad(size);
      }
    }
    if (errors.length) return { text: '', errors };

    // Заголовки разных типов не должны пересекаться; у 3.1 незаданные — 1, 2, 3, 4
    const headers = [1, 2, 3, 4]
      .map((n) => ({ key: `H${n}`, range: parseRange(values[`H${n}`] || (profile === 3 ? String(n) : '')) }))
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
    if (profile === 3 && ['noise', 'off'].includes(mask)) lines.push(`Mask = ${mask}`); // dns — и так по умолчанию
    return { text: lines.length ? `${lines.join('\n')}\n` : '', errors };
  }

  if (typeof window === 'undefined') {
    // node --test: чистые функции без DOM
    module.exports = { awgProfile, pickSubnet, maskPassword, newJob, readStatus, endpointHost, expertOptions, HOST_RE };
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

  function loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    } catch {
      return {};
    }
  }

  function savePrefs(prefs) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // приватный режим — просто не запоминаем
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
      </ul>
      <details class="hg-expert" data-role="expert">
        <summary>Для опытных</summary>
        <p class="hg-hint">Обычно здесь ничего менять не нужно: параметры маскировки AmneziaWG и так выбираются случайно — свои у каждого сервера и у каждого роутера.</p>
        <div class="hg-row">
          <label class="hg-field" data-role="mask-field"><span class="hg-label">Пакет перед рукопожатием (I1)</span><select class="hg-select" data-role="mask"><option value="dns">Похож на DNS-запрос</option><option value="noise">Случайные байты</option><option value="off">Не отправлять</option></select></label>
          <label class="hg-field hg-field--narrow"><span class="hg-label">UDP-порт VPN</span><input class="hg-input" data-role="awg-port" placeholder="любой" inputmode="numeric" maxlength="5"></label>
        </div>
        <div class="hg-row">
          <label class="hg-field"><span class="hg-label">Свои параметры AmneziaWG — строки «Параметр = значение»</span><textarea class="hg-text hg-text--short" data-role="custom" spellcheck="false" placeholder="Jc = 4&#10;Jmin = 40&#10;Jmax = 120&#10;I1 = &lt;r 2&gt;&lt;b 0x…&gt;"></textarea></label>
        </div>
        <p class="hg-hint hg-hint--small">Порт, S1–S4 и H1–H4 общие для сервера и всех его роутеров — они действуют, только когда сервер настраивается впервые. Остальное (Jc, Jmin, Jmax, I1–I5, таймеры, MTU) — параметры этого роутера. Ключи и адреса из вставленной конфигурации мастер пропускает: их он создаёт сам.</p>
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
    const state = { busy: false, closed: false, router: null, steps: [], shownSteps: 0, view: 'form' };
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

    const drawSteps = () => {
      const list = $('steps');
      list.textContent = '';
      for (const step of state.steps) {
        const li = document.createElement('li');
        li.textContent = step.text;
        li.className = { now: 'hg-now', done: 'hg-done', fail: 'hg-fail' }[step.state];
        list.append(li);
      }
    };
    const pushStep = (text) => {
      state.steps.forEach((s) => {
        if (s.state === 'now') s.state = 'done';
      });
      state.steps.push({ text, state: 'now' });
      drawSteps();
    };
    const finishSteps = (ok) => {
      const last = state.steps[state.steps.length - 1];
      if (last && last.state === 'now') last.state = ok ? 'done' : 'fail';
      drawSteps();
    };

    const run = async (task) => {
      if (state.busy) return;
      state.busy = true;
      $('primary').disabled = true;
      try {
        await task();
      } catch (err) {
        if (state.view === 'progress' || state.view === 'finishing') {
          finishSteps(false);
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
      for (;;) {
        for (; state.shownSteps < job.steps.length; state.shownSteps++) pushStep(job.steps[state.shownSteps].text);
        $('log').textContent = job.log.slice(-400).join('\n');
        if (job.state !== 'running' && job.next >= job.total) break;
        if (state.closed) return null; // окно закрыли: роутер доделает сам
        await sleep(job.state === 'running' ? POLL_MS : 0);
        // Настройка идёт на роутере сама по себе — один неудачный опрос не повод её бросать
        for (let attempt = 1; ; attempt++) {
          try {
            readStatus(await execHelper(['vps-status', job.next]), job);
            break;
          } catch (err) {
            if (attempt >= 5 || /сессия истекла/.test(err.message)) throw err;
            setStatus(`Роутер не ответил (${err.message}) — спрашиваю ещё раз…`);
            await sleep(3000);
          }
        }
        setStatus('');
      }
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
      pushStep('Создаю подключение в роутере');
      const { created, intersects } = await importConf(conf, name);
      await execHelper(['vps-clear']).catch(() => {}); // в журнале был ключ подключения — больше не нужен
      const replies = await rciPost('', [
        { interface: { name: created, description: name } },
        { interface: { name: created, up: true } },
        { system: { configuration: { save: {} } } },
      ]);
      const errors = errorsOf(replies);
      if (errors.length) throw new Error(`подключение ${created} создано, но не включилось: ${errors.join('; ')}`);

      pushStep('Проверяю связь с сервером');
      let online = false;
      for (let waited = 0; waited < CHECK_SECONDS && !online && !state.closed; waited += 2) {
        await sleep(2000);
        online = await peerOnline(created).catch(() => false);
      }
      finishSteps(online);
      show('finished');
      const tips = 'Чтобы пустить через VPN весь интернет, откройте подключение и включите «Использовать для выхода в интернет». ' +
        'Чтобы только отдельные сайты — «Маршрутизация» → «Добавить списком».';
      const overlap = intersects ? ` Сеть VPN пересекается с подключениями: ${intersects}.` : '';
      if (online) setStatus(`Готово: подключение «${name}» (${created}) работает. ${tips}${overlap}`, 'ok');
      else setStatus(`Подключение «${name}» (${created}) создано, но сервер пока не ответил — проверьте его статус через минуту.${overlap} ${tips}`, 'error');
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
      const options = expertOptions({ mask: $('mask').value, port: $('awg-port').value, custom: $('custom').value }, state.router.profile);
      if (options.errors.length) {
        $('expert').open = true;
        throw new Error(`в разделе «Для опытных»: ${options.errors.join('; ')}`);
      }
      const subnet = pickSubnet(state.router.interfaces.map((i) => ({ address: i.address, mask: i.mask })));
      if (!subnet) throw new Error('не нашёл свободную сеть для VPN среди 10.64.0.0–10.127.255.0');
      savePrefs({ port, user, name: $('name').value.trim() });

      const pad = (await execHelper(['vps-pad'])).map((l) => l.trim()).find((l) => /^[0-9a-f]{64,}$/.test(l));
      if (!pad) throw new Error('модуль на роутере устарел — переустановите его');
      const secret = maskPassword(password, pad);
      $('password').value = '';
      const args = ['vps-start', host, port, user, secret, state.router.profile, subnet];
      if (options.text) args.push(btoa(options.text)); // восьмой, последний аргумент exec
      const out = await execHelper(args);
      if (!out.some((l) => l.trim() === 'started')) {
        throw new Error(out.filter((l) => l.trim() && l !== 'process terminated').join('; ') || 'помощник на роутере не начал настройку');
      }
      state.steps = [];
      state.shownSteps = 0;
      const conf = await follow(readStatus([], { ...newJob(), state: 'running' }));
      if (conf) await finish(conf);
    };

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
      $('profile').textContent =
        state.router.profile === 3
          ? 'Протокол — AmneziaWG 3.1: самая новая маскировка, ваша прошивка её поддерживает.'
          : `Ваша прошивка (${state.router.title || 'версия неизвестна'}) понимает только AmneziaWG 1.0 — её проще заблокировать. AmneziaWG 3.1 появилась в KeeneticOS 5.2.`;
      $('mask-field').hidden = state.router.profile !== 3; // в AmneziaWG 1.0 пакета I1 нет
      const job = readStatus(await execHelper(['vps-status', 0]), newJob());
      setStatus('');
      if (job.state === 'running' || (job.state === 'done' && job.next < job.total) || (job.state === 'done' && job.conf)) {
        const conf = await follow(job);
        if (conf) await finish(conf);
      } else if ((job.state === 'failed' || job.state === 'lost') && job.error) {
        setStatus(`Прошлая попытка не удалась: ${job.error}`, 'error');
      }
    }).then(() => {
      if (state.view === 'form') $('host').focus();
    });
  }

  // ---------- кнопка на странице ----------

  // Кнопка — копия штатной «Загрузить из файла» в блоке WireGuard
  function injectButton() {
    if (!/\/otherConnections\/?$/.test(location.pathname)) return;
    const row = document.querySelector('.wireguard__buttons');
    if (!row || row.querySelector('[data-hostsgen-vps]')) return;
    const buttons = row.querySelectorAll('ndw-button');
    const template = buttons[1] || buttons[0];
    if (!template) return;
    const host = cloneButton(template, {
      marker: 'data-hostsgen-vps',
      label: 'Создать на своём сервере',
      icon: 'globe',
      title: 'Роутер сам настроит AmneziaWG на вашем VPS и создаст подключение',
      onClick: openDialog,
    });
    if (host) buttons[buttons.length - 1].after(host);
  }

  watchPage(injectButton);
})();
