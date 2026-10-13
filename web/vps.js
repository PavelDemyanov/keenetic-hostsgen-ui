/*
 * hostsgen-ui — кнопка «Создать на своём сервере» в блоке WireGuard на странице «Интернет → Другие
 * подключения» KeeneticOS. Адрес VPS, логин и пароль root → роутер сам заходит на сервер по SSH,
 * ставит там AmneziaWG (server/vps-setup.sh через helper/hostsgen-ui.c vps-*) и создаёт подключение
 * тем же импортом конфигурации, что и штатная кнопка «Загрузить из файла».
 *
 * Встраивается inline вместе с common.js — без закрывающего тега script и открытия HTML-комментария.
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

  if (typeof window === 'undefined') {
    // node --test: чистые функции без DOM
    module.exports = { awgProfile, pickSubnet, maskPassword, newJob, readStatus, endpointHost, HOST_RE };
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
      <p class="hg-hint">Роутер сам зайдёт на сервер по SSH, установит Docker и AmneziaWG и создаст здесь подключение. Подойдёт VPS на Ubuntu или Debian с доступом root по паролю. Займёт 3–5 минут.</p>
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
        <li>Если сервер уже настраивали этой кнопкой, на нём ничего не переустановится — добавится ещё одно подключение.</li>
      </ul>
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
      const subnet = pickSubnet(state.router.interfaces.map((i) => ({ address: i.address, mask: i.mask })));
      if (!subnet) throw new Error('не нашёл свободную сеть для VPN среди 10.64.0.0–10.127.255.0');
      savePrefs({ port, user, name: $('name').value.trim() });

      const pad = (await execHelper(['vps-pad'])).map((l) => l.trim()).find((l) => /^[0-9a-f]{64,}$/.test(l));
      if (!pad) throw new Error('модуль на роутере устарел — переустановите его');
      const secret = maskPassword(password, pad);
      $('password').value = '';
      const out = await execHelper(['vps-start', host, port, user, secret, state.router.profile, subnet]);
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
