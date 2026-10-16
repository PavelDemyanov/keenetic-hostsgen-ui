/*
 * hostsgen-ui — кнопка «Добавить списком» на странице «Маршрутизация → IPv4-маршруты» KeeneticOS.
 * Домены, IP-адреса, подсети или HAR-файл → маска → маршруты сразу добавляются через RCI.
 *
 * Подключается к веб-интерфейсу вместе с common.js одним файлом (helper/hostsgen-ui.c, start).
 * Домены распознаёт DNS самого роутера: helper/hostsgen-ui.c (resolve), вызывается RCI-командой exec.
 */
(() => {
  'use strict';

  const HOSTS_PER_EXEC = 30; // доменов за один вызов hostsgen-ui resolve
  const ROUTES_PER_REQUEST = 50; // команд ip route в одном POST /rci/
  const MANY_ROUTES = 1000; // дальше веб-интерфейс роутера заметно тормозит
  const STORAGE_KEY = 'hostsgen-ui';
  const MASKS = [
    { bits: 32, label: '/32 — только сам адрес' },
    { bits: 24, label: '/24 — 255.255.255.0' },
    { bits: 16, label: '/16 — 255.255.0.0' },
    { bits: 8, label: '/8 — 255.0.0.0' },
  ];
  const VPN_TYPES = /wireguard|openvpn|pptp|l2tp|sstp|ike|ipsec|proxy|vpn/i;

  // ---------- адреса ----------

  const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

  const isIPv4 = (s) => IPV4_RE.test(s);
  const ipToInt = (ip) => ip.split('.').reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
  const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  const maskOf = (bits) => (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0);
  const netOf = (ip, bits) => (ip & maskOf(bits)) >>> 0;
  const covers = (net, bits, otherNet, otherBits) => bits <= otherBits && netOf(otherNet, bits) === net;
  const cidr = (net, bits) => `${intToIp(net)}/${bits}`;

  function maskToBits(mask) {
    if (!isIPv4(mask)) return null;
    const m = ipToInt(mask);
    let bits = 0;
    while (bits < 32 && m & (0x80000000 >>> bits)) bits++;
    return maskOf(bits) === m ? bits : null;
  }

  // Локальные, служебные и групповые адреса: маршрут к ним через VPN почти всегда ошибка.
  const RESERVED = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3],
  ].map(([ip, bits]) => ({ net: ipToInt(ip), bits }));
  const isReserved = (ip) => RESERVED.some((r) => netOf(ip, r.bits) === r.net);

  // ---------- разбор ввода ----------

  /** Текст из поля: домены, IP, подсети CIDR, URL и строки «route ADD … MASK …», через перевод строки, пробел или запятую. */
  function parseInput(text) {
    const hosts = new Set();
    const ips = new Map(); // ip (число) → как было записано
    const nets = []; // { net, bits, src }
    const skipped = [];

    const addToken = (token) => {
      let t = token.replace(/^["'<(\[]+|["'>)\]]+$/g, '');
      if (!t) return;
      const m = t.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/);
      if (m && isIPv4(m[1]) && Number(m[2]) <= 32) {
        const bits = Number(m[2]);
        nets.push({ net: netOf(ipToInt(m[1]), bits), bits, src: t });
        return;
      }
      if (t.includes('://')) {
        try {
          t = new URL(t).hostname;
        } catch {
          skipped.push(token);
          return;
        }
      } else {
        t = t.replace(/[/?#].*$/, '');
      }
      t = t.replace(/:\d+$/, '').replace(/^\*?\./, '').replace(/\.$/, '').toLowerCase();
      if (/[^\x00-\x7f]/.test(t)) {
        try {
          t = new URL(`http://${t}`).hostname; // кириллический домен → punycode
        } catch {
          // останется как есть и уйдёт в «Не понял»
        }
      }
      if (isIPv4(t)) ips.set(ipToInt(t), t);
      else if (HOST_RE.test(t)) hosts.add(t);
      else skipped.push(token);
    };

    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;
      const route = line.match(/^route\s+add\s+(\S+)\s+mask\s+(\S+)/i);
      if (route) {
        const bits = maskToBits(route[2]);
        if (isIPv4(route[1]) && bits !== null) nets.push({ net: netOf(ipToInt(route[1]), bits), bits, src: line });
        else skipped.push(line);
        continue;
      }
      line.split(/[\s,;]+/).forEach(addToken);
    }
    return { hosts, ips, nets, skipped };
  }

  /** HAR из DevTools: домены всех запросов и адреса серверов, к которым браузер реально подключался. */
  function parseHar(text) {
    let har;
    try {
      har = JSON.parse(text);
    } catch {
      throw new Error('файл не похож на HAR: это не JSON');
    }
    const entries = har && har.log && har.log.entries;
    if (!Array.isArray(entries)) throw new Error('в файле нет log.entries — это не HAR');
    const hosts = new Set();
    const serverIps = new Map(); // домен → Set(ip)
    for (const entry of entries) {
      let host = '';
      try {
        const url = new URL(entry.request.url);
        if (/^(https?|wss?):$/.test(url.protocol)) host = url.hostname.toLowerCase();
      } catch {
        // data:, blob: и прочее без хоста
      }
      if (!host || !(isIPv4(host) || HOST_RE.test(host))) continue;
      hosts.add(host);
      const server = String(entry.serverIPAddress || '').replace(/^\[|\]$/g, '');
      if (isIPv4(server)) {
        if (!serverIps.has(host)) serverIps.set(host, new Set());
        serverIps.get(host).add(server);
      }
    }
    return { hosts, serverIps, entries: entries.length };
  }

  /** Пользовательские маршруты роутера (ответ GET /rci/ip/route) → { net, bits, iface }. Маршрут по умолчанию пропускаем. */
  function parseExisting(routes) {
    const out = [];
    for (const r of routes || []) {
      if (!r || r.disable) continue;
      const iface = r.interface || r.gateway || '';
      if (r.host && isIPv4(r.host)) out.push({ net: ipToInt(r.host), bits: 32, iface });
      else if (r.network && isIPv4(r.network)) {
        const bits = maskToBits(r.mask);
        if (bits !== null) out.push({ net: netOf(ipToInt(r.network), bits), bits, iface });
      }
    }
    return out;
  }

  /**
   * Адреса → подсети с маской bits, явные подсети — как есть. Вложенные склеиваются в более широкие,
   * уже покрытые существующими маршрутами помечаются полем existing.
   * sources: { ips: [{ ip, from }], nets: [{ net, bits, from }] }.
   */
  function buildPlan(sources, bits, existing) {
    const byKey = new Map();
    const add = (net, b, from) => {
      const key = `${net}/${b}`;
      let item = byKey.get(key);
      if (!item) byKey.set(key, (item = { net, bits: b, from: new Set() }));
      item.from.add(from);
    };
    let reserved = 0;
    for (const { ip, from } of sources.ips) {
      if (isReserved(ip)) reserved++;
      else add(netOf(ip, bits), bits, from);
    }
    for (const { net, bits: b, from } of sources.nets) add(net, b, from);

    const kept = [];
    for (const item of [...byKey.values()].sort((a, b) => a.bits - b.bits || a.net - b.net)) {
      const parent = kept.find((k) => covers(k.net, k.bits, item.net, item.bits));
      if (parent) item.from.forEach((f) => parent.from.add(f));
      else kept.push(item);
    }
    for (const item of kept) item.existing = existing.find((r) => covers(r.net, r.bits, item.net, item.bits)) || null;
    kept.sort((a, b) => a.net - b.net || a.bits - b.bits);
    return { items: kept, reserved };
  }

  // ---------- смена интерфейса у выделенных маршрутов ----------

  /** Адрес назначения маршрута из RCI так, как его показывает таблица: «сеть/биты» или адрес узла без /32. */
  function routeDestination(route) {
    if (route.host) return route.host;
    const bits = maskToBits(route.mask || '');
    return route.network && bits !== null ? `${route.network}/${bits}` : '';
  }

  /**
   * Выделенные строки таблицы ({ destination, gateway, iface } — как в ячейках) → маршруты из RCI.
   * label(id) — подписи интерфейса, которые может показать таблица (описание и имя).
   * Если подпись не совпала, но маршрут с таким назначением и шлюзом один, берём его.
   */
  function matchRows(rows, routes, label) {
    const pool = routes.map((route) => ({ route, dest: routeDestination(route), gateway: route.gateway || '', labels: label(route.interface || '') }));
    const found = [];
    const missing = [];
    for (const row of rows) {
      const same = pool.filter((p) => p.dest === row.destination && p.gateway === row.gateway);
      const pick = same.find((p) => p.labels.includes(row.iface)) || (same.length === 1 ? same[0] : null);
      if (!pick) {
        missing.push(row.destination);
        continue;
      }
      pool.splice(pool.indexOf(pick), 1);
      found.push(pick.route);
    }
    return { found, missing };
  }

  /**
   * Команды RCI переноса маршрута на интерфейс target — как в штатном редакторе маршрута: удалить
   * старый по index и добавить такой же, но через другой интерфейс. Шлюз старого интерфейса не переносим.
   * policy — имя политики доступа ('' — политика по умолчанию).
   */
  function moveCommands(route, target, policy) {
    const add = { ...route, interface: target };
    delete add.index;
    delete add.gateway;
    return [policyRoute({ index: route.index, no: true }, policy), policyRoute(add, policy)];
  }

  /** Маршрут политики доступа пишется в ip policy, как это делает штатный редактор маршрутов. */
  const policyRoute = (body, policy) => (policy ? { ip: { policy: { name: policy, route: body } } } : { ip: { route: body } });

  if (typeof window === 'undefined') {
    // node --test: чистые функции без DOM
    module.exports = {
      parseInput, parseHar, parseExisting, buildPlan, maskToBits, ipToInt, intToIp, isReserved,
      routeDestination, matchRows, moveCommands,
    };
    return;
  }

  // ---------- RCI ----------

  const { plural, rciFetch, rciPost, errorsOf, execHelper, openOverlay, cloneButton, watchPage } = window.hostsgenUi;

  async function resolveHosts(hosts, onProgress, cancel) {
    const out = new Map();
    for (let i = 0; i < hosts.length; i += HOSTS_PER_EXEC) {
      const chunk = hosts.slice(i, i + HOSTS_PER_EXEC);
      for (const line of await execHelper(['resolve', chunk.join(',')], cancel)) {
        const [host, ...rest] = String(line).trim().split(/\s+/);
        if (chunk.includes(host)) out.set(host, rest.filter(isIPv4));
      }
      onProgress(Math.min(i + HOSTS_PER_EXEC, hosts.length), hosts.length);
    }
    return out;
  }

  function routeBody(item, { iface, auto, comment }) {
    const body = { interface: iface, auto };
    if (item.bits === 32) body.host = intToIp(item.net);
    else {
      body.network = intToIp(item.net);
      body.mask = intToIp(maskOf(item.bits));
    }
    if (comment) body.comment = comment;
    return body;
  }

  const routeCommand = (item, options) => policyRoute(routeBody(item, options), options.policy);

  async function addRoutes(items, options) {
    let added = 0;
    const failed = [];
    for (let i = 0; i < items.length; i += ROUTES_PER_REQUEST) {
      const chunk = items.slice(i, i + ROUTES_PER_REQUEST);
      const replies = await rciPost('', chunk.map((item) => routeCommand(item, options)));
      chunk.forEach((item, k) => {
        const errors = errorsOf(replies[k]);
        if (errors.length) failed.push(`${cidr(item.net, item.bits)}: ${errors.join('; ')}`);
        else added++;
      });
      options.onProgress(Math.min(i + ROUTES_PER_REQUEST, items.length), items.length);
    }
    await rciPost('', [{ system: { configuration: { save: {} } } }]);
    return { added, failed };
  }

  /** Маршруты по политикам ('' — политика по умолчанию), политики доступа и интерфейсы для выбора. */
  async function loadContext() {
    const [routes, interfaces, policies] = await Promise.all([
      rciFetch('ip/route'),
      rciFetch('show/interface'),
      rciFetch('ip/policy').catch(() => ({})),
    ]);
    const routesByPolicy = new Map([['', Array.isArray(routes) ? routes : Object.values(routes || {})]]);
    for (const [id, policy] of Object.entries(policies || {})) {
      routesByPolicy.set(id, Array.isArray(policy && policy.route) ? policy.route : []);
    }
    const all = Object.values(interfaces || {}).filter((i) => i && i.id);
    return {
      routesByPolicy,
      policies: Object.entries(policies || {}).map(([id, policy]) => ({ id, label: (policy && policy.description) || id })),
      ifaces: all.filter((i) => i.global || VPN_TYPES.test(i.type || '')),
      names: new Map(all.map((i) => [i.id, i.description || i.id])), // подписи всех интерфейсов, как в таблицах
    };
  }

  // «Описание (Wireguard0)» и пометка, если у подключения нет связи
  const ifaceTitle = (i) => (i.description ? `${i.description} (${i.id})` : i.id) + (i.link && i.link !== 'up' ? ' — нет связи' : '');

  // ---------- настройки ----------

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

  // ---------- интерфейс ----------

  const TEMPLATE = `
<div class="hg-dialog" role="dialog" aria-modal="true" aria-labelledby="hg-title">
  <div class="hg-head">
    <h2 class="hg-title" id="hg-title">Добавить маршруты списком</h2>
    <button type="button" class="hg-x" data-role="close" aria-label="Закрыть">×</button>
  </div>
  <div class="hg-body">
    <p class="hg-hint">Домены, IP-адреса, подсети (1.2.3.0/24) или строки «route ADD …» — по одному в строке. Сюда же можно перетащить HAR-файл.</p>
    <textarea class="hg-text" data-role="text" spellcheck="false" placeholder="youtube.com&#10;googlevideo.com&#10;157.240.3.35"></textarea>
    <div class="hg-row">
      <button type="button" class="hg-btn" data-role="har">Загрузить HAR…</button>
      <input type="file" accept=".har,.json,application/json" data-role="file" hidden>
      <span data-role="chip"></span>
    </div>
    <div class="hg-row">
      <label class="hg-field"><span class="hg-label">Маска подсети</span><select class="hg-select" data-role="mask"></select></label>
      <label class="hg-field"><span class="hg-label">Интерфейс</span><select class="hg-select" data-role="iface"></select></label>
      <label class="hg-field" data-role="policy-field" hidden><span class="hg-label">Политика</span><select class="hg-select" data-role="policy"></select></label>
    </div>
    <div class="hg-row">
      <label class="hg-field"><span class="hg-label">Описание (необязательно)</span><input class="hg-input" data-role="comment" maxlength="64" placeholder="например, YouTube"></label>
      <label class="hg-check"><input type="checkbox" data-role="auto"> Добавлять автоматически</label>
    </div>
    <div class="hg-row"><button type="button" class="hg-btn" data-role="preview">Показать маршруты</button></div>
    <div class="hg-status" data-role="status" aria-live="polite"></div>
    <div data-role="result" hidden>
      <div class="hg-summary" data-role="summary"></div>
      <div class="hg-tablewrap">
        <table class="hg-table">
          <thead><tr><th>Сеть</th><th>Откуда</th><th>Статус</th></tr></thead>
          <tbody data-role="rows"></tbody>
        </table>
      </div>
      <ul class="hg-notes" data-role="notes"></ul>
    </div>
  </div>
  <div class="hg-foot">
    <button type="button" class="hg-btn" data-role="cancel">Отмена</button>
    <button type="button" class="hg-btn hg-btn--primary" data-role="add" disabled>Добавить</button>
  </div>
</div>`;

  function openDialog() {
    const state = {
      ctx: null,
      har: null, // { name, serverIps: Map(домен → Set(ip)), hosts }
      resolved: new Map(), // домен → [ip] — кэш на время диалога
      input: null, // разобранный ввод последнего «Показать маршруты»
      plan: null,
      busy: false,
      cancel: { cancelled: false },
    };
    const dialog = openOverlay(TEMPLATE, {
      canClose: () => !state.busy,
      onClose: () => {
        state.cancel.cancelled = true;
      },
    });
    if (!dialog) return;
    const { overlay, $, close } = dialog;

    const prefs = loadPrefs();
    for (const m of MASKS) $('mask').append(new Option(m.label, String(m.bits)));
    $('mask').value = String(MASKS.some((m) => m.bits === prefs.bits) ? prefs.bits : 16);
    $('auto').checked = prefs.auto !== false;

    const setStatus = (text, isError = false) => {
      $('status').textContent = text;
      $('status').classList.toggle('hg-status--error', isError);
    };

    $('close').addEventListener('click', close);
    $('cancel').addEventListener('click', close);

    // Пока идёт операция, кнопки и настройки заблокированы; поле ввода — нет, чтобы не терять набранное.
    const run = async (task) => {
      if (state.busy) return;
      state.busy = true;
      const controls = [...overlay.querySelectorAll('button, select, input')].filter(
        (el) => el.dataset.role !== 'cancel' && el.dataset.role !== 'close',
      );
      controls.forEach((el) => {
        el.disabled = true;
      });
      try {
        await task();
      } catch (err) {
        setStatus(`Ошибка: ${err.message}`, true);
      } finally {
        state.busy = false;
        controls.forEach((el) => {
          el.disabled = false;
        });
        $('add').disabled = !freshItems().length;
      }
    };

    const freshItems = () => (state.plan ? state.plan.items.filter((item) => !item.existing) : []);
    const policyRoutes = () => (state.ctx && state.ctx.routesByPolicy.get($('policy').value)) || [];
    const ifaceName = (id) => {
      const i = state.ctx && state.ctx.ifaces.find((x) => x.id === id);
      return i && i.description ? i.description : id;
    };

    const markStale = () => {
      if (!state.plan) return;
      state.input = null;
      state.plan = null;
      $('result').hidden = true;
      $('add').disabled = true;
      setStatus('Список изменился — нажмите «Показать маршруты»');
    };

    // интерфейсы, политики и существующие маршруты
    setStatus('Читаю маршруты и интерфейсы роутера…');
    run(async () => {
      state.ctx = await loadContext();
      // чаще всего используемый в маршрутах интерфейс — первым и по умолчанию
      const counts = new Map();
      for (const list of state.ctx.routesByPolicy.values()) {
        for (const r of list) if (r.interface) counts.set(r.interface, (counts.get(r.interface) || 0) + 1);
      }
      const sorted = [...state.ctx.ifaces].sort((a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0));
      for (const i of sorted) $('iface').append(new Option(ifaceTitle(i), i.id));
      if (sorted.some((i) => i.id === prefs.iface)) $('iface').value = prefs.iface;

      $('policy').append(new Option('Политика по умолчанию', ''));
      for (const p of state.ctx.policies) $('policy').append(new Option(p.label, p.id));
      $('policy-field').hidden = !state.ctx.policies.length;
      if (state.ctx.policies.some((p) => p.id === prefs.policy)) $('policy').value = prefs.policy;
      setStatus(`Сейчас пользовательских маршрутов: ${policyRoutes().length}`);
    });

    // HAR и текстовые файлы: кнопка или перетаскивание в поле
    const text = $('text');
    const renderChip = () => {
      const chip = $('chip');
      chip.textContent = '';
      if (!state.har) return;
      const box = document.createElement('span');
      box.className = 'hg-chip';
      box.append(`HAR: ${state.har.name} — ${state.har.hosts} ${plural(state.har.hosts, 'домен', 'домена', 'доменов')}`);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = 'Не учитывать адреса серверов из HAR';
      remove.addEventListener('click', () => {
        state.har = null;
        renderChip();
        markStale();
      });
      box.append(remove);
      chip.append(box);
    };
    const appendLines = (lines) => {
      const present = new Set(text.value.split(/\r?\n/).map((l) => l.trim().toLowerCase()));
      const fresh = lines.filter((l) => !present.has(l));
      if (!fresh.length) return 0;
      text.value += (text.value && !text.value.endsWith('\n') ? '\n' : '') + fresh.join('\n') + '\n';
      return fresh.length;
    };
    const loadFile = async (file) => {
      const content = await file.text();
      if (/\.har$/i.test(file.name) || /^\s*\{/.test(content)) {
        let har;
        try {
          har = parseHar(content);
        } catch (err) {
          setStatus(`${file.name}: ${err.message}`, true);
          return;
        }
        state.har = { name: file.name, serverIps: har.serverIps, hosts: har.hosts.size };
        const added = appendLines([...har.hosts].sort());
        renderChip();
        markStale();
        setStatus(
          `${file.name}: ${har.entries} ${plural(har.entries, 'запрос', 'запроса', 'запросов')}, ` +
            `${har.hosts.size} ${plural(har.hosts.size, 'домен', 'домена', 'доменов')} (новых в списке: ${added}). ` +
            'Лишние домены можно удалить из поля.',
        );
      } else {
        appendLines(content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
        markStale();
      }
    };
    $('har').addEventListener('click', () => $('file').click());
    $('file').addEventListener('change', () => {
      const file = $('file').files[0];
      $('file').value = '';
      if (file) run(() => loadFile(file));
    });
    text.addEventListener('dragover', (e) => {
      e.preventDefault();
      text.classList.add('hg-drop');
    });
    text.addEventListener('dragleave', () => text.classList.remove('hg-drop'));
    text.addEventListener('drop', (e) => {
      e.preventDefault();
      text.classList.remove('hg-drop');
      const file = e.dataTransfer && e.dataTransfer.files[0];
      if (file) run(() => loadFile(file));
    });
    text.addEventListener('input', markStale);

    // предпросмотр: распознать домены, построить подсети, сверить с существующими маршрутами
    const replan = () => {
      if (!state.input || !state.ctx) return;
      const { parsed } = state.input;
      const ips = [];
      for (const host of parsed.hosts) {
        for (const ip of state.resolved.get(host) || []) ips.push({ ip: ipToInt(ip), from: host });
        const fromHar = state.har && state.har.serverIps.get(host);
        if (fromHar) fromHar.forEach((ip) => ips.push({ ip: ipToInt(ip), from: host }));
      }
      parsed.ips.forEach((src, ip) => ips.push({ ip, from: src }));
      const nets = parsed.nets.map((n) => ({ net: n.net, bits: n.bits, from: n.src.length > 40 ? `${n.src.slice(0, 40)}…` : n.src }));
      state.plan = buildPlan({ ips, nets }, Number($('mask').value), parseExisting(policyRoutes()));
      render(parsed);
    };

    const render = (parsed) => {
      const { items, reserved } = state.plan;
      const fresh = freshItems();
      const rows = $('rows');
      rows.textContent = '';
      for (const item of items) {
        const tr = document.createElement('tr');
        const cell = (content, cls) => {
          const td = document.createElement('td');
          td.textContent = content;
          if (cls) td.className = cls;
          tr.append(td);
        };
        const from = [...item.from];
        cell(cidr(item.net, item.bits), 'hg-net');
        cell(from.slice(0, 3).join(', ') + (from.length > 3 ? ` и ещё ${from.length - 3}` : ''));
        if (item.existing) cell(`уже есть: ${cidr(item.existing.net, item.existing.bits)} → ${ifaceName(item.existing.iface)}`, 'hg-muted');
        else cell('новый');
        rows.append(tr);
      }

      const summary = [`Новых маршрутов: ${fresh.length}`];
      if (items.length > fresh.length) summary.push(`уже есть: ${items.length - fresh.length}`);
      $('summary').textContent = summary.join(' · ');

      const notes = [];
      const unresolved = [...parsed.hosts].filter((h) => !(state.resolved.get(h) || []).length && !(state.har && state.har.serverIps.has(h)));
      if (unresolved.length) notes.push(`Нет IPv4-адресов у ${unresolved.length}: ${unresolved.slice(0, 8).join(', ')}${unresolved.length > 8 ? '…' : ''}`);
      if (reserved) notes.push(`Пропущено локальных и служебных адресов: ${reserved}`);
      if (parsed.skipped.length) notes.push(`Не понял: ${parsed.skipped.slice(0, 5).join(', ')}${parsed.skipped.length > 5 ? '…' : ''}`);
      const total = policyRoutes().length + fresh.length;
      if (total > MANY_ROUTES) notes.push(`Всего маршрутов станет ${total} — на больших списках веб-интерфейс роутера тормозит.`);
      const list = $('notes');
      list.textContent = '';
      for (const note of notes) {
        const li = document.createElement('li');
        li.textContent = note;
        list.append(li);
      }

      $('result').hidden = false;
      $('add').disabled = !fresh.length;
      $('add').textContent = fresh.length ? `Добавить ${fresh.length} ${plural(fresh.length, 'маршрут', 'маршрута', 'маршрутов')}` : 'Добавить';
      setStatus(fresh.length ? '' : 'Добавлять нечего');
    };

    $('preview').addEventListener('click', () =>
      run(async () => {
        if (!state.ctx) throw new Error('не удалось прочитать маршруты роутера — обновите страницу');
        const snapshot = text.value;
        const parsed = parseInput(snapshot);
        if (!parsed.hosts.size && !parsed.ips.size && !parsed.nets.length) {
          setStatus('Добавьте домены, адреса или HAR-файл', true);
          return;
        }
        const pending = [...parsed.hosts].filter((h) => !state.resolved.has(h));
        if (pending.length) {
          const progress = (done, total) => setStatus(`Распознаю домены через DNS роутера: ${done} из ${total}…`);
          progress(0, pending.length);
          const found = await resolveHosts(pending, progress, state.cancel);
          for (const host of pending) state.resolved.set(host, found.get(host) || []);
        }
        if (text.value !== snapshot) {
          setStatus('Список изменился — нажмите «Показать маршруты»');
          return;
        }
        state.input = { parsed };
        replan();
      }),
    );
    $('mask').addEventListener('change', replan);
    $('policy').addEventListener('change', replan);

    $('add').addEventListener('click', () =>
      run(async () => {
        const items = freshItems();
        if (!items.length) return;
        const options = {
          iface: $('iface').value,
          policy: $('policy').value,
          auto: $('auto').checked,
          comment: $('comment').value.trim(),
          onProgress: (done, total) => setStatus(`Добавляю маршруты: ${done} из ${total}…`),
        };
        if (!options.iface) throw new Error('не выбран интерфейс');
        savePrefs({ bits: Number($('mask').value), iface: options.iface, policy: options.policy, auto: options.auto });
        options.onProgress(0, items.length);
        const { added, failed } = await addRoutes(items, options);
        if (failed.length) {
          setStatus(`Добавлено ${added}, с ошибкой ${failed.length}: ${failed.slice(0, 3).join('; ')}`, true);
          return;
        }
        setStatus(`Добавлено маршрутов: ${added}. Обновляю таблицу…`);
        state.plan = null;
        setTimeout(() => location.reload(), 900);
      }),
    );

    text.focus();
  }

  // ---------- окно «Сменить интерфейс» ----------

  const MOVE_TEMPLATE = `
<div class="hg-dialog" role="dialog" aria-modal="true" aria-labelledby="hm-title">
  <div class="hg-head">
    <h2 class="hg-title" id="hm-title">Сменить интерфейс у маршрутов</h2>
    <button type="button" class="hg-x" data-role="close" aria-label="Закрыть">×</button>
  </div>
  <div class="hg-body">
    <p class="hg-summary" data-role="summary">Читаю маршруты роутера…</p>
    <div class="hg-row">
      <label class="hg-field"><span class="hg-label">Новый интерфейс</span><select class="hg-select" data-role="iface"></select></label>
    </div>
    <ul class="hg-notes" data-role="notes">
      <li>Поменяется только интерфейс: адреса, описание и «Добавлять автоматически» останутся прежними.</li>
    </ul>
    <div class="hg-status" data-role="status" aria-live="polite"></div>
  </div>
  <div class="hg-foot">
    <button type="button" class="hg-btn" data-role="cancel">Отмена</button>
    <button type="button" class="hg-btn hg-btn--primary" data-role="apply" disabled>Перенести</button>
  </div>
</div>`;

  /** Выделенные строки таблицы пользовательских маршрутов: колонки «выбор, включено, назначение, шлюз, интерфейс, …». */
  function selectedRows() {
    const table = document.querySelector('.user-routes-table table.ndw-table');
    if (!table) return [];
    return [...table.querySelectorAll('tbody tr')]
      .filter((tr) => tr.querySelector('input.ndw-checkbox__checkbox__input:checked'))
      .map((tr) => {
        const cell = (i) => (tr.children[i] ? tr.children[i].textContent.trim() : '');
        return { destination: cell(2), gateway: cell(3), iface: cell(4) };
      });
  }

  /** Политика над таблицей маршрутов: '' — политика по умолчанию (в списке она permit). */
  function selectedPolicy() {
    const select = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'permit'));
    return select && select.value !== 'permit' ? select.value : '';
  }

  function openMoveDialog() {
    const rows = selectedRows(); // до открытия окна: потом таблица под ним может перерисоваться
    const policy = selectedPolicy();
    const state = { busy: false, routes: [], ctx: null };
    const dialog = openOverlay(MOVE_TEMPLATE, { canClose: () => !state.busy });
    if (!dialog) return;
    const { overlay, $, close } = dialog;
    $('close').addEventListener('click', close);
    $('cancel').addEventListener('click', close);

    const setStatus = (text, isError = false) => {
      $('status').textContent = text;
      $('status').classList.toggle('hg-status--error', isError);
    };
    const run = async (task) => {
      if (state.busy) return;
      state.busy = true;
      const controls = [...overlay.querySelectorAll('button, select')].filter((el) => !['cancel', 'close'].includes(el.dataset.role));
      controls.forEach((el) => {
        el.disabled = true;
      });
      try {
        await task();
      } catch (err) {
        setStatus(`Ошибка: ${err.message}`, true);
      } finally {
        state.busy = false;
        controls.forEach((el) => {
          el.disabled = false;
        });
        $('apply').disabled = !state.routes.length;
      }
    };
    const name = (id) => (state.ctx && state.ctx.names.get(id)) || id || 'без интерфейса';

    run(async () => {
      if (!rows.length) throw new Error('отметьте маршруты галочками в таблице');
      state.ctx = await loadContext();
      const labels = (id) => [state.ctx.names.get(id), id].filter(Boolean);
      const { found, missing } = matchRows(rows, state.ctx.routesByPolicy.get(policy) || [], labels);
      state.routes = found;

      const counts = new Map();
      for (const r of found) counts.set(r.interface || '', (counts.get(r.interface || '') || 0) + 1);
      const now = [...counts].sort((a, b) => b[1] - a[1]);
      const n = found.length;
      $('summary').textContent =
        `${plural(n, 'Выделен', 'Выделено', 'Выделено')} ${n} ${plural(n, 'маршрут', 'маршрута', 'маршрутов')}` +
        (now.length ? `, сейчас ${n === 1 ? 'он идёт' : 'они идут'} через ${now.map(([id, k]) => `${name(id)} (${k})`).join(', ')}.` : '.');
      if (missing.length) {
        const li = document.createElement('li');
        li.textContent = `Не нашёл в настройках роутера и не трону: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`;
        $('notes').append(li);
      }
      for (const i of state.ctx.ifaces) $('iface').append(new Option(ifaceTitle(i), i.id));
      // по умолчанию — другой VPN: маршруты переносят с одного туннеля на другой, а не на провайдера
      const free = state.ctx.ifaces.filter((i) => !counts.has(i.id));
      const other = free.find((i) => VPN_TYPES.test(i.type || '')) || free[0];
      if (other) $('iface').value = other.id;
      $('apply').textContent = `Перенести ${found.length} ${plural(found.length, 'маршрут', 'маршрута', 'маршрутов')}`;
    });

    $('apply').addEventListener('click', () =>
      run(async () => {
        const target = $('iface').value;
        const todo = state.routes.filter((r) => r.interface !== target);
        if (!todo.length) {
          setStatus(`Выделенные маршруты уже идут через ${name(target)}`);
          return;
        }
        let moved = 0;
        const failed = [];
        for (let i = 0; i < todo.length; i += ROUTES_PER_REQUEST) {
          const chunk = todo.slice(i, i + ROUTES_PER_REQUEST);
          const replies = await rciPost('', chunk.flatMap((route) => moveCommands(route, target, policy)));
          // старый маршрут удалён, а новый не добавился — возвращаем старый, чтобы адреса не ушли мимо VPN
          const restore = [];
          chunk.forEach((route, k) => {
            const removeErrors = errorsOf(replies[2 * k]);
            const addErrors = errorsOf(replies[2 * k + 1]);
            if (!removeErrors.length && !addErrors.length) {
              moved++;
              return;
            }
            failed.push(`${routeDestination(route)}: ${removeErrors.concat(addErrors).join('; ')}`);
            if (addErrors.length && !removeErrors.length) {
              const back = { ...route };
              delete back.index;
              restore.push(policyRoute(back, policy));
            }
          });
          if (restore.length) await rciPost('', restore);
          setStatus(`Переношу маршруты: ${Math.min(i + ROUTES_PER_REQUEST, todo.length)} из ${todo.length}…`);
        }
        await rciPost('', [{ system: { configuration: { save: {} } } }]);
        if (failed.length) {
          setStatus(`Перенесено ${moved}, не удалось ${failed.length}: ${failed.slice(0, 3).join('; ')}`, true);
          return;
        }
        setStatus(`Перенесено маршрутов на ${name(target)}: ${moved}. Обновляю таблицу…`);
        state.routes = [];
        setTimeout(() => location.reload(), 900);
      }),
    );
  }

  // ---------- кнопки на странице ----------

  // «Добавить списком» — копия штатной «Загрузить» рядом с «Добавить».
  function injectButton() {
    if (!/\/staticRoutes\/ipv4\/?$/.test(location.pathname)) return;
    const row = document.querySelector('.user-routes-table__buttons-row');
    if (!row || row.querySelector('[data-hostsgen-ui]')) return;
    const buttons = row.querySelectorAll('ndw-button');
    const template = buttons[1] || buttons[0];
    if (!template) return;
    const host = cloneButton(template, {
      marker: 'data-hostsgen-ui',
      label: 'Добавить списком',
      icon: 'list',
      title: 'Домены, IP-адреса или HAR-файл → маршруты',
      onClick: openDialog,
    });
    if (host) buttons[0].after(host);
  }

  // «Сменить интерфейс» — копия штатной «Удалить выделенные». Её прошивка показывает, только пока в таблице
  // что-то выделено (рядом всегда стоит «Удалить по интерфейсу»), — наша появляется и исчезает вместе с ней.
  function injectMoveButton() {
    const box = /\/staticRoutes\/ipv4\/?$/.test(location.pathname) && document.querySelector('.user-routes-table__buttons');
    const native = box ? box.querySelectorAll(':scope > ndw-button:not([data-hostsgen-move])') : [];
    const deleteSelected = native.length > 1 ? native[native.length - 1] : null;
    const mine = document.querySelector('[data-hostsgen-move]');
    if (!deleteSelected) {
      if (mine) mine.remove();
      return;
    }
    if (mine) return;
    const host = cloneButton(deleteSelected, {
      marker: 'data-hostsgen-move',
      label: 'Сменить интерфейс',
      icon: 'wan-connection',
      title: 'Перенести выделенные маршруты на другое подключение',
      onClick: openMoveDialog,
    });
    if (host) deleteSelected.after(host);
  }

  watchPage(() => {
    injectButton();
    injectMoveButton();
  });
})();
