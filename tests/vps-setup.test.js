// server/vps-setup.sh по частям: функции вызываются в dash с VPS_SETUP_TEST=1, awg — заглушка.
// node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { expertOptions } = require('../web/vps.js');

const SETUP = path.join(__dirname, '../server/vps-setup.sh');
const SHELL = spawnSync('dash', ['-c', 'true']).status === 0 ? 'dash' : 'sh';
const AWG_STUB = `awg() { case $1 in genkey | genpsk) echo "K$(rhex 8)=" ;; pubkey) read -r k; echo "P$k" ;; esac; }`;

/** Код после подключения сценария; env — переменные (PROFILE, OPTIONS…). */
function run(code, env = {}) {
  const r = spawnSync(SHELL, ['-c', `. "$SETUP"\n${AWG_STUB}\n${code}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, VPS_SETUP_TEST: '1', SETUP, ...env },
  });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

const params = (text) => Object.fromEntries(text.split('\n').filter((l) => l.includes(' = ')).map((l) => [l.slice(0, l.indexOf(' = ')), l.slice(l.indexOf(' = ') + 3)]));
const range = (value) => value.split('-').map(Number);

/** I1 «DNS-запрос»: <r 2> — ID, дальше заголовок, вопрос и, может быть, EDNS — всё по RFC 1035/6891. */
function decodeDnsMask(i1) {
  const m = i1.match(/^<r 2><b 0x([0-9a-f]+)>$/);
  assert.ok(m, i1);
  const b = Buffer.from(m[1], 'hex');
  assert.ok([0x0100, 0x0120].includes(b.readUInt16BE(0)), 'флаги: RD или RD+AD');
  assert.deepEqual([b.readUInt16BE(2), b.readUInt16BE(4), b.readUInt16BE(6)], [1, 0, 0]);
  const additional = b.readUInt16BE(8);
  let off = 10;
  const labels = [];
  while (b[off]) {
    labels.push(b.subarray(off + 1, off + 1 + b[off]).toString());
    off += 1 + b[off];
  }
  off += 1;
  const qtype = b.readUInt16BE(off);
  assert.ok([1, 28, 65].includes(qtype), `тип вопроса ${qtype}`);
  assert.equal(b.readUInt16BE(off + 2), 1, 'класс IN');
  off += 4;
  let cookie = false;
  if (additional) {
    assert.equal(additional, 1);
    assert.equal(b[off], 0, 'OPT: корень');
    assert.equal(b.readUInt16BE(off + 1), 41, 'OPT: тип 41');
    assert.ok([1232, 1200, 4096].includes(b.readUInt16BE(off + 3)));
    const rdlen = b.readUInt16BE(off + 9);
    off += 11;
    if (rdlen) {
      assert.equal(rdlen, 12);
      assert.deepEqual([b.readUInt16BE(off), b.readUInt16BE(off + 2)], [10, 8], 'COOKIE, 8 байт');
      cookie = true;
    }
    off += rdlen;
  }
  assert.equal(off, b.length, 'после записей ничего лишнего');
  return { name: labels.join('.'), qtype, edns: Boolean(additional), cookie };
}

test('client_params (3.1): у каждого роутера свои Jc/Jmin/Jmax, I1 и таймеры', () => {
  const r = run('for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do client_params 2>/dev/null; echo ---; done', { PROFILE: '3' });
  assert.equal(r.status, 0, r.err);
  const sets = r.out.split('---\n').filter(Boolean).map(params);
  assert.equal(sets.length, 30);
  const names = new Set();
  for (const p of sets) {
    assert.ok(Number(p.Jc) >= 4 && Number(p.Jc) <= 7);
    assert.ok(Number(p.Jmin) >= 12 && Number(p.Jmax) - Number(p.Jmin) >= 64 && Number(p.Jmax) <= 248);
    const dns = decodeDnsMask(p.I1);
    names.add(dns.name);
    // ключи меняются не реже чем через 120 с, а сервер отвергает их через 150 и позже
    assert.ok(range(p.RekeyAfterTime)[1] <= 120 && range(p.RejectAfterTime)[0] >= 150);
    assert.ok(range(p.RejectAfterTime)[0] - range(p.KeepaliveTimeout)[0] - range(p.RekeyTimeout)[0] > range(p.RekeyAfterTime)[1]);
    for (const key of ['RekeyAfterTime', 'RekeyTimeout', 'RejectAfterTime', 'KeepaliveTimeout', 'MaxHandshakeAttempts']) {
      const [lo, hi] = range(p[key]);
      assert.ok(lo < hi, `${key} = ${p[key]}`);
    }
    assert.equal(p.DisableCookies, 'on');
    assert.equal(p.S1, undefined, 'общих параметров здесь нет');
  }
  assert.ok(new Set(sets.map((p) => p.I1)).size >= 25, 'I1 у роутеров разные');
  assert.ok(new Set(sets.map((p) => `${p.Jc} ${p.Jmin} ${p.Jmax}`)).size >= 25, 'мусорные пакеты у роутеров разные');
  assert.ok(names.size >= 8, 'домены в I1 разные');
});

test('client_params (1.0): только мусорные пакеты', () => {
  const p = params(run('client_params', { PROFILE: '1' }).out);
  assert.deepEqual(Object.keys(p), ['Jc', 'Jmin', 'Jmax']);
});

test('pick_shared: S1–S4 с разными длинами пакетов, заголовки', () => {
  const r = run('i=0; while [ $i -lt 80 ]; do pick_shared; echo "$s1 $s2 $s3 $s4 $h1 $h2 $h3 $h4"; i=$((i + 1)); done', { PROFILE: '3' });
  assert.equal(r.status, 0, r.err);
  for (const line of r.out.trim().split('\n')) {
    const [s1, s2, s3, s4, ...h] = line.split(' ').map(Number);
    assert.ok(s1 >= 12 && s1 <= 96 && s2 >= 12 && s2 <= 96 && s3 >= 12 && s3 <= 64 && s4 >= 12 && s4 <= 20, line);
    assert.equal(new Set([148 + s1, 92 + s2, 64 + s3, 32 + s4]).size, 4, line);
    assert.deepEqual(h, [1, 2, 3, 4]);
  }
  const v1 = run('pick_shared; echo "$s1 $s2 [$s3] [$s4] $h1 $h2 $h3 $h4"', { PROFILE: '1' }).out.trim().split(' ');
  assert.ok(Number(v1[0]) >= 15 && Number(v1[1]) <= 150 && 148 + Number(v1[0]) !== 92 + Number(v1[1]));
  assert.deepEqual(v1.slice(2, 4), ['[]', '[]']);
  assert.equal(new Set(v1.slice(4)).size, 4);
  assert.ok(v1.slice(4).every((h) => Number(h) >= 5));
});

test('read_options: настройки «Для опытных» доходят до параметров, мусор — нет', () => {
  const { text } = expertOptions({ mask: 'noise', port: '443', custom: 'S1 = 40\nS2 = 50\nH1 = 100-200\nJc = 9\nI2 = <t>\nPersistentKeepalive = 21' }, 3);
  const options = Buffer.from(text).toString('base64');
  const r = run('read_options; pick_port() { opt ListenPort; }; pick_shared; echo "$s1 $s2 $h1 $h2"; pick_port; client_params', { PROFILE: '3', OPTIONS: options });
  assert.equal(r.status, 0, r.out + r.err);
  const [first, port, ...rest] = r.out.trim().split('\n');
  assert.equal(first, '40 50 100-200 2');
  assert.equal(port, '443');
  const p = params(rest.join('\n'));
  assert.equal(p.Jc, '9');
  assert.match(p.I1, /^<r (4[89]|[5-8]\d|9[0-6])>$/);
  assert.equal(p.I2, '<t>');

  const bad = (line) => run('read_options', { PROFILE: '3', OPTIONS: Buffer.from(`${line}\n`).toString('base64') });
  for (const line of ['Jc = 1; reboot', 'PrivateKey = x', 'I1 = <c>', 'H1 = 5-2', 'Mask = quic', 'Jc=5', 'S1 = $(id)']) {
    const r2 = bad(line);
    assert.notEqual(r2.status, 0, line);
    assert.match(r2.out, /^@@error неверная строка/m, line);
  }
  assert.match(run('read_options', { PROFILE: '3', OPTIONS: '!!!' }).out, /@@error не разобрал/);
  // все S заданы и совпадают по длине — подобрать нечего
  const clash = Buffer.from('S1 = 12\nS2 = 68\n').toString('base64');
  assert.match(run('read_options; pick_shared', { PROFILE: '3', OPTIONS: clash }).out, /@@error у пакетов разных типов совпадают длины/);
});

test('add_peer: с сервера — только общие параметры, свои — новые', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-setup-'));
  const conf = path.join(dir, 'awg0.conf');
  // сервер, настроенный версией 1.1.x: все параметры как у Amnezia
  fs.writeFileSync(
    conf,
    [
      '[Interface]', 'PrivateKey = SERVER=', 'Address = 10.75.144.1/24', 'ListenPort = 41234', 'MTU = 1408',
      'Jc = 5', 'Jmin = 10', 'Jmax = 50', 'S1 = 12', 'S2 = 12', 'S3 = 12', 'S4 = 12', 'H1 = 1', 'H2 = 2', 'H3 = 3', 'H4 = 4',
      'HeaderProtectionKey = HPK+/x=', 'RekeyAfterTime = 100-120', 'RekeyTimeout = 3-7', 'RejectAfterTime = 150-180',
      'KeepaliveTimeout = 5-15', 'MaxHandshakeAttempts = 15-20', 'RandomTrailers = on', 'DisableCookies = on', '',
      '[Peer]', 'PublicKey = PEER1=', 'PresharedKey = PSK1=', 'AllowedIPs = 10.75.144.2/32', '',
    ].join('\n'),
  );
  try {
    const r = run('CONF=$TEST_CONF; add_peer 2>/dev/null; printf "%s\\n" "$CLIENT_CONF"', { PROFILE: '3', ENDPOINT: '203.0.113.10', TEST_CONF: conf });
    assert.equal(r.status, 0, r.out + r.err);
    const [iface, peer] = r.out.split('[Peer]');
    const p = params(iface);
    // общие — ровно как у сервера
    for (const [key, value] of Object.entries({ S1: '12', S2: '12', S3: '12', S4: '12', H1: '1', H2: '2', H3: '3', H4: '4', HeaderProtectionKey: 'HPK+/x=', RandomTrailers: 'on' })) {
      assert.equal(p[key], value, key);
    }
    // своё у роутера: ключ и адрес, мусорные пакеты, I1, таймеры; серверного здесь нет
    assert.equal(p.Address, '10.75.144.3/32');
    assert.notEqual(p.PrivateKey, 'SERVER=');
    assert.equal(p.ListenPort, undefined);
    assert.equal(p.MTU, undefined);
    assert.ok(Number(p.Jmax) - Number(p.Jmin) >= 64, 'не серверные Jmin 10 / Jmax 50');
    decodeDnsMask(p.I1);
    assert.ok(range(p.RekeyAfterTime)[1] <= 120);
    const pp = params(peer);
    assert.equal(pp.PublicKey, 'PSERVER=');
    assert.equal(pp.Endpoint, '203.0.113.10:41234');
    assert.ok(Number(pp.PersistentKeepalive) >= 20 && Number(pp.PersistentKeepalive) <= 30);
    // на сервере — новый пир, остальное не тронуто
    const server = fs.readFileSync(conf, 'utf8');
    assert.match(server, /^AllowedIPs = 10\.75\.144\.3\/32$/m);
    assert.match(server, /^Jmin = 10$/m);
    assert.equal((server.match(/^\[Peer\]$/gm) || []).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pick_shared и client_params (2.0): S3/S4 без защиты заголовков, случайные H, I1 без таймеров', () => {
  const r = run('i=0; while [ $i -lt 60 ]; do pick_shared; echo "$s1 $s2 $s3 $s4 $h1 $h2 $h3 $h4"; i=$((i + 1)); done', { PROFILE: '2' });
  assert.equal(r.status, 0, r.err);
  for (const line of r.out.trim().split('\n')) {
    const [s1, s2, s3, s4, ...h] = line.split(' ').map(Number);
    assert.ok(s1 >= 15 && s1 <= 150 && s2 >= 15 && s2 <= 150 && s3 >= 8 && s3 <= 64 && s4 >= 4 && s4 <= 20, line);
    assert.equal(new Set([148 + s1, 92 + s2, 64 + s3, 32 + s4]).size, 4, line);
    assert.equal(new Set(h).size, 4, line);
    assert.ok(h.every((v) => v >= 5), line);
  }
  const p = params(run('client_params 2>/dev/null', { PROFILE: '2' }).out);
  assert.deepEqual(Object.keys(p), ['Jc', 'Jmin', 'Jmax', 'I1']);
  decodeDnsMask(p.I1);
});

/** Сервер с версией AmneziaWG have (0 — сервера ещё нет) и роутер с версией router: что скажет choose_profile. */
function choose(have, router, options = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-choose-'));
  const conf = path.join(dir, 'awg0.conf');
  const shared = { 1: 'S1 = 40\nS2 = 50\nH1 = 11\nH2 = 22\nH3 = 33\nH4 = 44\n', 2: 'S1 = 40\nS2 = 50\nS3 = 20\nS4 = 10\nH1 = 11\nH2 = 22\nH3 = 33\nH4 = 44\n', 3: 'S1 = 12\nS2 = 12\nS3 = 12\nS4 = 12\nH1 = 1\nH2 = 2\nH3 = 3\nH4 = 4\nHeaderProtectionKey = K=\n' };
  if (have) fs.writeFileSync(conf, `[Interface]\nPrivateKey = P=\nAddress = 10.1.2.1/24\nListenPort = 1234\n${shared[have]}`);
  try {
    const opts = options ? Buffer.from(options).toString('base64') : '';
    const r = run('CONF=$TEST_CONF; read_options; choose_profile; echo "PROFILE=$PROFILE"', { PROFILE: String(router), TEST_CONF: conf, OPTIONS: opts });
    return { status: r.status, profile: (r.out.match(/PROFILE=(\d)/) || [])[1], warn: r.out.match(/^@@warn .*/gm) || [], error: (r.out.match(/^@@error (.*)/m) || [])[1] };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('choose_profile: совместимость версий роутера и сервера', () => {
  // сервер своей версии или старше — подключаемся на версии сервера
  for (const [have, router] of [[1, 1], [2, 2], [3, 3]]) {
    assert.deepEqual(choose(have, router), { status: 0, profile: String(have), warn: [], error: undefined }, `${have}/${router}`);
  }
  for (const [have, router] of [[1, 2], [1, 3], [2, 3]]) {
    const r = choose(have, router);
    assert.equal(r.profile, String(have), `${have}/${router}`);
    assert.equal(r.warn.length, 1);
    assert.match(r.warn[0], /подключение будет на ней же.*маскировка слабее/);
  }
  // сервер новее роутера — нельзя, с понятной причиной и советом
  assert.match(choose(3, 2).error, /сервер уже работает на AmneziaWG 3\.1, а прошивка этого роутера понимает только AmneziaWG 2\.0 — обновите KeeneticOS до 5\.2/);
  assert.match(choose(3, 1).error, /понимает только AmneziaWG 1\.0 — обновите KeeneticOS до 5\.2/);
  assert.match(choose(2, 1).error, /сервер уже работает на AmneziaWG 2\.0.*обновите KeeneticOS до 5\.1/);
  assert.notEqual(choose(2, 1).status, 0);
  // настройки «Для опытных», которых нет в версии сервера, — с предупреждением
  const skipped = choose(1, 3, 'Mask = noise\nI2 = <t>\nRekeyTimeout = 5\nJc = 9\n');
  assert.match(skipped.warn[1], /не применены \(AmneziaWG 1\.0 их не знает\): Mask I2 RekeyTimeout$/);
  assert.match(choose(2, 3, 'RekeyTimeout = 5\nI2 = <t>\n').warn[1], /: RekeyTimeout$/);
  // новый сервер — на версии роутера или выбранной постарше, но не новее
  assert.equal(choose(0, 3).profile, '3');
  assert.equal(choose(0, 3, 'Version = 2\n').profile, '2');
  assert.equal(choose(0, 2, 'Version = 1\n').profile, '1');
  assert.match(choose(0, 2, 'Version = 3\n').error, /понимает только AmneziaWG 2\.0, а для сервера выбрана AmneziaWG 3\.1/);
});

test('add_peer: сервер на 2.0 — роутеру S1–S4 и H с сервера, свои Jc/Jmin/Jmax и I1', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-setup-'));
  const conf = path.join(dir, 'awg0.conf');
  fs.writeFileSync(conf, '[Interface]\nPrivateKey = SERVER=\nAddress = 10.9.8.1/24\nListenPort = 5555\nJc = 5\nJmin = 20\nJmax = 100\nS1 = 40\nS2 = 50\nS3 = 20\nS4 = 10\nH1 = 11\nH2 = 22\nH3 = 33\nH4 = 44\n');
  try {
    const r = run('CONF=$TEST_CONF; PROFILE=$(server_profile); echo "PROFILE=$PROFILE"; add_peer 2>/dev/null; printf "%s\\n" "$CLIENT_CONF"', { PROFILE: '3', ENDPOINT: '203.0.113.10', TEST_CONF: conf });
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /^PROFILE=2$/m);
    const p = params(r.out.split('[Peer]')[0]);
    for (const [key, value] of Object.entries({ S1: '40', S2: '50', S3: '20', S4: '10', H1: '11', H2: '22', H3: '33', H4: '44' })) assert.equal(p[key], value, key);
    assert.equal(p.HeaderProtectionKey, undefined);
    assert.equal(p.RekeyAfterTime, undefined);
    assert.equal(p.DisableCookies, undefined);
    decodeDnsMask(p.I1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- устройства: MODE=list|device|remove на уже настроенном сервере ----------

const ROUTER_KEY = `${'R'.repeat(42)}a=`;
const OTHER_KEY = `${'O'.repeat(42)}b=`;
// docker: контейнер есть, перезапуск проходит, awg show … dump — из $DUMP; id — будто root
const MANAGE_STUBS = `id() { echo 0; }
docker() {
	case $1 in
		inspect | restart) return 0 ;;
		exec) [ "\${6:-}" = dump ] && printf '%s\\n' "$DUMP"; return 0 ;;
	esac
}`;

/** Сервер 3.1 с роутером и подключением, добавленным вручную (без комментария); code — что выполнить. */
function manage(env, check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-manage-'));
  const conf = path.join(dir, 'awg0.conf');
  fs.writeFileSync(
    conf,
    [
      '[Interface]', 'PrivateKey = SERVER=', 'Address = 10.75.144.1/24', 'ListenPort = 41234', 'Jc = 5', 'Jmin = 10', 'Jmax = 50',
      'S1 = 30', 'S2 = 40', 'S3 = 20', 'S4 = 14', 'H1 = 1', 'H2 = 2', 'H3 = 3', 'H4 = 4', 'HeaderProtectionKey = HPK+/x=',
      'RandomTrailers = on', 'DisableCookies = on', '',
      '[Peer]', '# роутер Keenetic, 2026-10-13 21:04', `PublicKey = ${ROUTER_KEY}`, 'PresharedKey = PSK1=', 'AllowedIPs = 10.75.144.2/32', '',
      '[Peer]', `PublicKey = ${OTHER_KEY}`, 'AllowedIPs = 10.75.144.7/32, 192.168.5.0/24', '',
    ].join('\n'),
  );
  const dump = [`SERVER=\tPSERVER=\t41234\toff`, `${ROUTER_KEY}\tPSK1=\t198.51.100.7:4500\t10.75.144.2/32\t1792000000\t123456\t654321\t25`].join('\n');
  try {
    const r = run(`CONF=$TEST_CONF; ${MANAGE_STUBS}\nmain`, { TEST_CONF: conf, DUMP: dump, ...env });
    return check({ ...r, server: fs.readFileSync(conf, 'utf8'), lines: r.out.split('\n') });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const peersOf = (lines) =>
  lines
    .filter((l) => l.startsWith('@@peer '))
    .map((l) => {
      const [, key, addr, handshake, rx, tx, label] = l.split(' ');
      return { key, addr, handshake, rx, tx, comment: label === '-' ? '' : Buffer.from(label, 'base64').toString() };
    });

test('MODE=list: подключения сервера с рукопожатием и трафиком, без перезапуска', () => {
  manage({ MODE: 'list' }, (r) => {
    assert.equal(r.status, 0, r.out + r.err);
    assert.ok(r.lines.includes('@@server 3 41234'));
    assert.ok(r.lines.some((l) => /^@@now \d+$/.test(l)));
    assert.deepEqual(peersOf(r.lines), [
      { key: ROUTER_KEY, addr: '10.75.144.2', handshake: '1792000000', rx: '123456', tx: '654321', comment: 'роутер Keenetic, 2026-10-13 21:04' },
      { key: OTHER_KEY, addr: '10.75.144.7', handshake: '0', rx: '0', tx: '0', comment: '' },
    ]);
    assert.doesNotMatch(r.out, /@@step start|@@conf-begin/);
    assert.equal(r.lines.filter((l) => l === '@@done').length, 1);
  });
});

test('MODE=device: устройству — общие параметры сервера, DNS, MTU 1280 и весь трафик', () => {
  const name = 'Телефон Паши';
  manage({ MODE: 'device', NAME: Buffer.from(name).toString('base64'), ENDPOINT: 'vpn.example.com' }, (r) => {
    assert.equal(r.status, 0, r.out + r.err);
    assert.ok(r.lines.includes('@@step config Добавляю устройство «Телефон Паши» (AmneziaWG 3.1)'));
    assert.ok(r.lines.includes('@@step start Перезапускаю сервер AmneziaWG (UDP-порт 41234)'));
    const b64 = r.out.match(/@@conf-begin\n([\s\S]*?)\n@@conf-end/)[1].replace(/\n/g, '');
    const [iface, peer] = Buffer.from(b64, 'base64').toString().split('[Peer]');
    const p = params(iface);
    for (const [key, value] of Object.entries({ S1: '30', S2: '40', S3: '20', S4: '14', H1: '1', H4: '4', HeaderProtectionKey: 'HPK+/x=', RandomTrailers: 'on' })) {
      assert.equal(p[key], value, key);
    }
    assert.equal(p.Address, '10.75.144.8/32', 'следующий после самого большого адреса');
    assert.equal(p.DNS, '1.1.1.1, 1.0.0.1');
    assert.equal(p.MTU, '1280');
    decodeDnsMask(p.I1);
    assert.ok(range(p.RekeyAfterTime)[1] <= 120);
    const pp = params(peer);
    assert.equal(pp.AllowedIPs, '0.0.0.0/0, ::/0');
    assert.equal(pp.Endpoint, 'vpn.example.com:41234');
    assert.match(r.server, /^# устройство: Телефон Паши, \d{4}-\d\d-\d\d \d\d:\d\d$/m);
    const peers = peersOf(r.lines);
    assert.equal(peers.length, 3);
    assert.match(peers[2].comment, /^устройство: Телефон Паши, /);
    assert.equal(peers[2].addr, '10.75.144.8');
    // конфигурация — после списка, @@done — последней
    assert.ok(r.out.indexOf('@@peer ') < r.out.indexOf('@@conf-begin'));
    assert.equal(r.lines.filter(Boolean).pop(), '@@done');
  });
});

test('MODE=device: имя с управляющими символами не подделает строки @@', () => {
  const name = 'x\n@@done\n@@error ой\\n';
  manage({ MODE: 'device', NAME: Buffer.from(name).toString('base64'), ENDPOINT: '203.0.113.10' }, (r) => {
    assert.equal(r.status, 0, r.out + r.err);
    assert.equal(r.lines.filter((l) => l === '@@done').length, 1);
    assert.ok(!r.lines.some((l) => l.startsWith('@@error')));
    assert.match(r.server, /^# устройство: x@@done@@error ой\\n, /m);
  });
  manage({ MODE: 'device', NAME: '', ENDPOINT: '203.0.113.10' }, (r) => assert.match(r.out, /@@error неверное имя устройства/));
  manage({ MODE: 'device', NAME: Buffer.from('я'.repeat(61)).toString('base64'), ENDPOINT: '203.0.113.10' }, (r) =>
    assert.match(r.out, /@@error неверное имя устройства/),
  );
  manage({ MODE: 'device', NAME: 'eA==', ENDPOINT: 'a;b' }, (r) => assert.match(r.out, /@@error неверный адрес сервера/));
});

test('MODE=remove: удаляется только этот блок [Peer], сервер перезапускается', () => {
  manage({ MODE: 'remove', PEER: ROUTER_KEY }, (r) => {
    assert.equal(r.status, 0, r.out + r.err);
    assert.doesNotMatch(r.server, /роутер Keenetic|PSK1=|10\.75\.144\.2\//);
    assert.match(r.server, /^\[Interface\]\nPrivateKey = SERVER=\n/);
    assert.match(r.server, /DisableCookies = on\n\n\[Peer\]\nPublicKey = O+b=\n/);
    assert.ok(r.lines.includes('@@step done Подключений на сервере: 1'));
    assert.deepEqual(peersOf(r.lines).map((p) => p.key), [OTHER_KEY]);
  });
  manage({ MODE: 'remove', PEER: `${'Z'.repeat(43)}=` }, (r) => {
    assert.match(r.out, /@@error этого подключения на сервере уже нет/);
    assert.match(r.server, /роутер Keenetic/);
  });
  for (const bad of ['', 'abc', `${'R'.repeat(42)}a=;`, `${'R'.repeat(43)}`]) {
    manage({ MODE: 'remove', PEER: bad }, (r) => assert.match(r.out, /@@error неверный ключ подключения/, bad));
  }
});

test('MODE на сервере без нашего VPN — понятная ошибка', () => {
  const r = run(`CONF=/nonexistent/awg0.conf; ${MANAGE_STUBS}\nmain`, { MODE: 'list' });
  assert.notEqual(r.status, 0);
  assert.match(r.out, /@@error на этом сервере нет VPN, настроенного роутером Keenetic/);
  assert.match(run(`CONF=$SETUP; ${MANAGE_STUBS}\nmain`, { MODE: 'reboot' }).out, /@@error неизвестное действие/);
});
