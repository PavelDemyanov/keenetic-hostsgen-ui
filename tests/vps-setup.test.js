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
    const r = run('KIND=old; CONF=$TEST_CONF; add_peer 2>/dev/null; printf "%s\\n" "$CLIENT_CONF"', { PROFILE: '3', ENDPOINT: '203.0.113.10', TEST_CONF: conf });
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
    const r = run(`KIND=${have ? 'old' : 'new'}; CONF=$TEST_CONF; read_options; choose_profile; echo "PROFILE=$PROFILE"`, { PROFILE: String(router), TEST_CONF: conf, OPTIONS: opts });
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
    const r = run('KIND=old; CONF=$TEST_CONF; PROFILE=$(server_profile); echo "PROFILE=$PROFILE"; add_peer 2>/dev/null; printf "%s\\n" "$CLIENT_CONF"', { PROFILE: '3', ENDPOINT: '203.0.113.10', TEST_CONF: conf });
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
const APP_KEY = `${'A'.repeat(42)}c=`;
const LAPTOP_KEY = `${'L'.repeat(42)}d=`;
const DUMP = [
  `SERVER=\tPSERVER=\t41234\toff`,
  `${ROUTER_KEY}\tPSK1=\t198.51.100.7:4500\t10.75.144.2/32\t1792000000\t123456\t654321\t25`,
  `${APP_KEY}\tSHARED=\t198.51.100.9:5300\t10.8.1.1/32\t1792000100\t1000\t2000\t0`,
].join('\n');

// Фальшивый сервер в папке $DIR: docker пишет вызовы в docker.log, контейнеры — из CONTAINERS (BUILD_FAIL и
// RUN_FAIL ломают сборку и запуск), файлы внутри контейнеров — в root/, awg show … dump — из $DUMP, id — будто root
const STUBS = `id() { echo 0; }
uname() { echo x86_64; }
systemctl() { :; }
cread() { cat "$DIR/root$1"; }
cwrite() { mkdir -p "$(dirname "$DIR/root$1")" && cat >"$DIR/root$1"; }
docker() {
	echo "$*" >>"$DIR/docker.log"
	case $1 in
		inspect)
			[ "$2" = -f ] && { echo true; return 0; }
			case " $CONTAINERS " in *" \${4:-$2} "*) return 0 ;; esac
			return 1 ;;
		build) [ -z "\${BUILD_FAIL:-}" ] ;;
		run) [ -z "\${RUN_FAIL:-}" ] ;;
		exec) case "$*" in *" show awg0 dump" | *" show wg0 dump") printf '%s\\n' "$DUMP" ;; esac ;;
	esac
}
OLD_DIR=$DIR/keenetic-vpn AMNEZIA_BUILD=$DIR/build OS_RELEASE=$DIR/os-release TUN=/dev/null`;

/**
 * main на фальшивом сервере: old — awg0.conf прежнего формата, amnezia — awg0.conf в контейнере (legacy —
 * wg0.conf контейнера amnezia-awg), table — его clientsTable. check получает вывод, журнал docker и файлы.
 */
function vps({ old, amnezia, legacy, table, containers = '', env = {}, code = '' }, check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-'));
  const awgDir = path.join(dir, 'root/opt/amnezia/awg');
  if (old) {
    fs.mkdirSync(path.join(dir, 'keenetic-vpn'));
    fs.writeFileSync(path.join(dir, 'keenetic-vpn/awg0.conf'), old);
  }
  if (amnezia) {
    fs.mkdirSync(awgDir, { recursive: true });
    fs.writeFileSync(path.join(awgDir, legacy ? 'wg0.conf' : 'awg0.conf'), amnezia);
  }
  if (table) fs.writeFileSync(path.join(awgDir, 'clientsTable'), JSON.stringify(table, null, 4));
  fs.writeFileSync(path.join(dir, 'os-release'), 'ID=ubuntu\nPRETTY_NAME="Ubuntu 22.04.5 LTS"\n');
  try {
    const r = run(`${STUBS}\n${code}\nmain`, { DIR: dir, CONTAINERS: containers, DUMP, ...env });
    const read = (file) => (fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), 'utf8') : null);
    const tableText = read('root/opt/amnezia/awg/clientsTable');
    const b64 = (r.out.match(/@@conf-begin\n([\s\S]*?)\n@@conf-end/) || [])[1];
    return check({
      ...r,
      dir,
      read,
      lines: r.out.split('\n'),
      docker: read('docker.log') || '',
      conf: read(`root/opt/amnezia/awg/${legacy ? 'wg0' : 'awg0'}.conf`),
      table: tableText && JSON.parse(tableText),
      client: b64 && Buffer.from(b64.replace(/\n/g, ''), 'base64').toString(),
    });
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
const names = (table) => table.map((c) => c.userData.clientName);
const QT_DATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2} \d\d:\d\d:\d\d \d{4}$/;

// Сервер, настроенный приложением Amnezia (AmneziaWG 3.1): её клиент .1 и наш роутер .2
const APP_CONF = [
  '[Interface]', 'PrivateKey = SERVER=', 'Address = 10.8.1.0/24', 'ListenPort = 55424', 'Jc = 4', 'Jmin = 10', 'Jmax = 50',
  'S1 = 30', 'S2 = 40', 'S3 = 20', 'S4 = 14', 'H1 = 1', 'H2 = 2', 'H3 = 3', 'H4 = 4', 'HeaderProtectionKey = HPK+/x=',
  'RekeyAfterTime = 100-120', 'RekeyTimeout = 3-7', 'RejectAfterTime = 150-180', 'KeepaliveTimeout = 5-15',
  'MaxHandshakeAttempts = 15-20', 'RandomTrailers = on', 'DisableCookies = on', '# I1 = <r 2><b 0x0100>',
  '[Peer]', `PublicKey = ${APP_KEY}`, 'PresharedKey = SHARED=', 'AllowedIPs = 10.8.1.1/32', '',
  '[Peer]', `PublicKey = ${ROUTER_KEY}`, 'PresharedKey = PSK1=', 'AllowedIPs = 10.8.1.2/32', '', '',
].join('\n');
const APP_TABLE = [
  { clientId: APP_KEY, userData: { clientName: 'Pavel iPhone', creationDate: 'Tue Nov 3 10:00:00 2026' } },
  { clientId: ROUTER_KEY, userData: { clientName: 'Роутер Keenetic', creationDate: 'Sat Nov 15 09:30:00 2026' } },
];
const amneziaServer = (env, check, more = {}) => vps({ amnezia: APP_CONF, table: APP_TABLE, containers: 'amnezia-awg2', env, ...more }, check);

// Сервер прежнего формата (keenetic-awg): роутер, ноутбук и подключение, добавленное вручную (без подписи)
const OLD_CONF = [
  '[Interface]', 'PrivateKey = SERVER=', 'Address = 10.75.144.1/24', 'ListenPort = 41234', 'Jc = 5', 'Jmin = 10', 'Jmax = 50',
  'S1 = 30', 'S2 = 40', 'S3 = 20', 'S4 = 14', 'H1 = 1', 'H2 = 2', 'H3 = 3', 'H4 = 4', 'HeaderProtectionKey = HPK+/x=',
  'RandomTrailers = on', 'DisableCookies = on', '',
  '[Peer]', '# роутер Keenetic, 2026-10-13 21:04', `PublicKey = ${ROUTER_KEY}`, 'PresharedKey = PSK1=', 'AllowedIPs = 10.75.144.2/32', '',
  '[Peer]', '# устройство: Ноутбук, 2026-10-23 20:15', `PublicKey = ${LAPTOP_KEY}`, 'PresharedKey = PSK2=', 'AllowedIPs = 10.75.144.5/32', '',
  '[Peer]', `PublicKey = ${OTHER_KEY}`, 'AllowedIPs = 10.75.144.7/32, 192.168.5.0/24', '',
].join('\n');
const oldServer = (env, check, more = {}) => vps({ old: OLD_CONF, containers: 'keenetic-awg', env, ...more }, check);
const device = (name, endpoint = 'vpn.example.com') => ({ MODE: 'device', NAME: Buffer.from(name).toString('base64'), ENDPOINT: endpoint });

test('server_profile: версия сервера — по параметрам, которые нужны приёмнику', () => {
  const profile = (text) => run('CONF=$C; server_profile', { C: path.join(writeTemp(text), 'awg0.conf') }).out.trim();
  assert.equal(profile('[Interface]\nS1 = 10\nH1 = 1\nHeaderProtectionKey = K=\n'), '3');
  assert.equal(profile('[Interface]\nS1 = 10\nRandomTrailers = on\n'), '3');
  assert.equal(profile('[Interface]\nS1 = 10\nS3 = 10\nRandomTrailers = off\n'), '2');
  assert.equal(profile('[Interface]\nS1 = 10\nH1 = 100-200\nH2 = 300\n'), '2');
  // таймеры и I1 — у каждой стороны свои: роутеру на 1.0 они не мешают
  assert.equal(profile('[Interface]\nS1 = 10\nH1 = 5\nRekeyAfterTime = 100-120\n# I1 = <r 2>\n'), '1');
});

function writeTemp(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vps-conf-'));
  fs.writeFileSync(path.join(dir, 'awg0.conf'), text);
  return dir;
}

test('add_peer на сервере Amnezia: адрес после последнего, подпись — в clientsTable, не в конфигурации', () => {
  const empty = writeTemp('[Interface]\nPrivateKey = SERVER=\nAddress = 10.8.1.0/24\nListenPort = 55424\nS1 = 30\nS2 = 40\nH1 = 11\nH2 = 22\nH3 = 33\nH4 = 44\n');
  const r = run('KIND=amnezia; CONF=$D/awg0.conf; TABLE=$D/clientsTable; add_peer 2>/dev/null; DEVICE=Ноутбук; add_peer 2>/dev/null; cat "$CONF"; cat "$TABLE"', { D: empty, PROFILE: '1', ENDPOINT: '203.0.113.10' });
  assert.equal(r.status, 0, r.out + r.err);
  // у сервера Amnezia адрес — .0, первое подключение — .1, как у приложения
  assert.deepEqual([...r.out.matchAll(/^AllowedIPs = (\S+)$/gm)].map((m) => m[1]), ['10.8.1.1/32', '10.8.1.2/32']);
  assert.doesNotMatch(r.out, /^#/m);
  assert.doesNotMatch(r.out, /\n\n\n/);
  const table = JSON.parse(r.out.slice(r.out.indexOf('[\n')));
  assert.deepEqual(names(table), ['Роутер Keenetic', 'Ноутбук']);
  assert.match(table[0].userData.creationDate, QT_DATE);
  fs.rmSync(empty, { recursive: true, force: true });
});

test('Amnezia, list: подключения и имена из clientsTable приложения, сервер не трогаем', () => {
  amneziaServer({ MODE: 'list' }, (r) => {
    assert.equal(r.status, 0, r.out + r.err);
    assert.ok(r.lines.includes('@@server 3 55424') && r.lines.includes('@@format amnezia'));
    assert.deepEqual(peersOf(r.lines), [
      { key: APP_KEY, addr: '10.8.1.1', handshake: '1792000100', rx: '1000', tx: '2000', comment: 'устройство: Pavel iPhone, 2026-11-03 10:00' },
      { key: ROUTER_KEY, addr: '10.8.1.2', handshake: '1792000000', rx: '123456', tx: '654321', comment: 'роутер Keenetic, 2026-11-15 09:30' },
    ]);
    assert.doesNotMatch(r.docker, /restart|syncconf|build|pull/);
    assert.equal(r.conf, APP_CONF);
    assert.equal(r.lines.filter((l) => l === '@@done').length, 1);
  });
});

test('Amnezia, device: подключение в конец awg0.conf, имя в clientsTable, syncconf без перезапуска', () => {
  amneziaServer(device('Телефон Паши'), (r) => {
    assert.equal(r.status, 0, r.out + r.err);
    assert.ok(r.lines.includes('@@step config Добавляю устройство «Телефон Паши» (AmneziaWG 3.1)'));
    assert.ok(r.lines.includes('@@step start Применяю настройки сервера (UDP-порт 55424) — без перезапуска, у остальных подключений связь не прерывается'));
    assert.match(r.docker, /^exec amnezia-awg2 sh -c awg-quick strip \/opt\/amnezia\/awg\/awg0\.conf >\/tmp\/keenetic\.conf && awg syncconf awg0 \/tmp\/keenetic\.conf;/m);
    assert.doesNotMatch(r.docker, /restart|build|pull|^run /m);
    // прежнее — как было, новое — в конце, без комментариев
    assert.ok(r.conf.startsWith(APP_CONF.trimEnd()));
    assert.match(r.conf, /\n\n\[Peer\]\nPublicKey = PK[0-9a-f]{16}=\nPresharedKey = K[0-9a-f]{16}=\nAllowedIPs = 10\.8\.1\.3\/32\n$/);
    assert.deepEqual(names(r.table), ['Pavel iPhone', 'Роутер Keenetic', 'Телефон Паши']);
    assert.equal(r.table[0].userData.creationDate, 'Tue Nov 3 10:00:00 2026');
    assert.match(r.table[2].userData.creationDate, QT_DATE);
    const [iface, peer] = r.client.split('[Peer]');
    const p = params(iface);
    for (const [key, value] of Object.entries({ S1: '30', S2: '40', S3: '20', S4: '14', H1: '1', H4: '4', HeaderProtectionKey: 'HPK+/x=', RandomTrailers: 'on' })) {
      assert.equal(p[key], value, key);
    }
    assert.equal(p.Address, '10.8.1.3/32');
    assert.equal(p.DNS, '1.1.1.1, 1.0.0.1');
    assert.equal(p.MTU, '1280');
    assert.ok(Number(p.Jmax) - Number(p.Jmin) >= 64, 'свои Jmin/Jmax, не серверные 10/50');
    decodeDnsMask(p.I1);
    assert.equal(params(peer).PublicKey, 'PSERVER=');
    assert.equal(params(peer).Endpoint, 'vpn.example.com:55424');
    const peers = peersOf(r.lines);
    assert.equal(peers.length, 3);
    assert.match(peers[2].comment, /^устройство: Телефон Паши, \d{4}-\d\d-\d\d \d\d:\d\d$/);
    assert.ok(r.out.indexOf('@@peer ') < r.out.indexOf('@@conf-begin'));
    assert.equal(r.lines.filter(Boolean).pop(), '@@done');
  });
});

test('Amnezia, remove: блок [Peer] и запись clientsTable, syncconf без перезапуска', () => {
  amneziaServer({ MODE: 'remove', PEER: APP_KEY }, (r) => {
    assert.equal(r.status, 0, r.out + r.err);
    assert.doesNotMatch(r.conf, /SHARED=|10\.8\.1\.1\//);
    assert.match(r.conf, /^# I1 = <r 2><b 0x0100>\n\[Peer\]\nPublicKey = R+a=\n/m);
    assert.deepEqual(names(r.table), ['Роутер Keenetic']);
    assert.match(r.docker, /syncconf awg0/);
    assert.doesNotMatch(r.docker, /restart/);
    assert.ok(r.lines.includes('@@step done Подключений на сервере: 1'));
  });
});

test('Amnezia: роутер подключается к серверу приложения новым пользователем', () => {
  amneziaServer({ PROFILE: '3', SUBNET: '10.77.12', ENDPOINT: '203.0.113.10' }, (r) => {
    assert.equal(r.status, 0, r.out + r.err);
    assert.ok(r.lines.includes('@@step amnezia На сервере уже есть VPN приложения Amnezia (AmneziaWG 3.1) — добавляю в него роутер новым пользователем: подключение будет видно и в приложении'));
    assert.doesNotMatch(r.docker, /pull|build|restart/);
    assert.match(r.docker, /syncconf awg0/);
    assert.deepEqual(names(r.table), ['Pavel iPhone', 'Роутер Keenetic', 'Роутер Keenetic']);
    assert.match(r.conf, /AllowedIPs = 10\.8\.1\.3\/32\n$/);
    const p = params(r.client.split('[Peer]')[0]);
    assert.equal(p.Address, '10.8.1.3/32');
    assert.equal(p.DNS, undefined);
    assert.equal(params(r.client.split('[Peer]')[1]).AllowedIPs, '0.0.0.0/0');
  });
  // прошивка не понимает версию сервера — ничего не меняем
  amneziaServer({ PROFILE: '2', SUBNET: '10.77.12', ENDPOINT: '203.0.113.10' }, (r) => {
    assert.match(r.out, /@@error сервер уже работает на AmneziaWG 3\.1, а прошивка этого роутера понимает только AmneziaWG 2\.0/);
    assert.equal(r.conf, APP_CONF);
    assert.doesNotMatch(r.docker, /syncconf/);
  });
});

test('Amnezia 1.x (контейнер amnezia-awg): wg0.conf, утилита wg и интерфейс wg0', () => {
  const conf = '[Interface]\nPrivateKey = SERVER=\nAddress = 10.8.1.0/24\nListenPort = 51820\nJc = 4\nJmin = 10\nJmax = 50\nS1 = 30\nS2 = 40\nH1 = 11\nH2 = 22\nH3 = 33\nH4 = 44\n\n' +
    `[Peer]\nPublicKey = ${APP_KEY}\nPresharedKey = SHARED=\nAllowedIPs = 10.8.1.1/32\n\n`;
  vps({ amnezia: conf, legacy: true, containers: 'amnezia-awg', env: device('Ноутбук') }, (r) => {
    assert.equal(r.status, 0, r.out + r.err);
    assert.ok(r.lines.includes('@@server 1 51820') && r.lines.includes('@@format amnezia'));
    assert.match(r.docker, /^exec amnezia-awg sh -c wg-quick strip \/opt\/amnezia\/awg\/wg0\.conf >\/tmp\/keenetic\.conf && wg syncconf wg0 /m);
    assert.match(r.conf, /AllowedIPs = 10\.8\.1\.2\/32\n$/);
    // clientsTable не было: сначала — подключения сервера, как их назвало бы само приложение, потом новое.
    // Иначе приложение, увидев непустой список, не показало бы своих
    assert.deepEqual(r.table.map((c) => [c.clientId, c.userData.clientName]), [[APP_KEY, 'Client 0'], [r.table[1].clientId, 'Ноутбук']]);
    assert.ok(peersOf(r.lines).some((p) => p.comment === 'устройство: Client 0'));
    assert.deepEqual(Object.keys(params(r.client.split('[Peer]')[0])).filter((k) => /^[SH]\d$/.test(k)), ['S1', 'S2', 'H1', 'H2', 'H3', 'H4']);
  });
});

test('Прежний формат, list: подписи из комментариев, сервер не трогаем', () => {
  oldServer({ MODE: 'list' }, (r) => {
    assert.equal(r.status, 0, r.out + r.err);
    assert.ok(r.lines.includes('@@server 3 41234') && r.lines.includes('@@format old'));
    assert.deepEqual(peersOf(r.lines).map((p) => [p.key, p.addr, p.comment]), [
      [ROUTER_KEY, '10.75.144.2', 'роутер Keenetic, 2026-10-13 21:04'],
      [LAPTOP_KEY, '10.75.144.5', 'устройство: Ноутбук, 2026-10-23 20:15'],
      [OTHER_KEY, '10.75.144.7', ''],
    ]);
    assert.equal(peersOf(r.lines)[0].handshake, '1792000000');
    assert.doesNotMatch(r.docker, /build|stop|restart/);
    assert.equal(r.read('keenetic-vpn/awg0.conf'), OLD_CONF);
  });
});

test('Прежний формат → формат Amnezia при первом изменении: те же ключи, порт и подключения', () => {
  oldServer(device('Телефон Паши'), (r) => {
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /^@@step amnezia Перевожу сервер в формат приложения Amnezia/m);
    // сначала сборка, потом остановка старого, запуск нового, удаление старого, затем устройство — без перезапуска
    const calls = r.docker.split('\n');
    const at = (re) => calls.findIndex((c) => re.test(c));
    const order = [/^build -q -t amnezia-awg2 .*\/build$/, /^stop keenetic-awg$/,
      /^run -d --name amnezia-awg2 --restart always --log-opt max-size=1m --cap-add NET_ADMIN --device \/dev\/net\/tun --sysctl net\.ipv4\.ip_forward=1 -p 41234:41234\/udp amnezia-awg2$/,
      /^network connect amnezia-dns-net amnezia-awg2$/, /^restart amnezia-awg2$/, /^rm keenetic-awg$/, /^exec amnezia-awg2 sh -c awg-quick strip/].map(at);
    assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), `${order}\n${r.docker}`);
    assert.doesNotMatch(r.docker, /restart keenetic-awg/);
    // настройки — без комментариев, ключ и порт прежние, все подключения на месте плюс новое
    assert.doesNotMatch(r.conf, /^#/m);
    assert.match(r.conf, /^PrivateKey = SERVER=\nAddress = 10\.75\.144\.1\/24\nListenPort = 41234\n/m);
    assert.deepEqual([...r.conf.matchAll(/^AllowedIPs = (.*)$/gm)].map((m) => m[1]), ['10.75.144.2/32', '10.75.144.5/32', '10.75.144.7/32, 192.168.5.0/24', '10.75.144.8/32']);
    assert.equal(r.read('root/opt/amnezia/awg/wireguard_server_private_key.key'), 'SERVER=\n');
    assert.equal(r.read('root/opt/amnezia/awg/wireguard_server_public_key.key'), 'PSERVER=\n');
    assert.match(r.read('root/opt/amnezia/awg/wireguard_psk.key'), /^K[0-9a-f]{16}=\n$/);
    assert.deepEqual(r.table.map((c) => [c.clientId, c.userData.clientName]), [
      [ROUTER_KEY, 'Роутер Keenetic'], [LAPTOP_KEY, 'Ноутбук'], [OTHER_KEY, 'Подключение 10.75.144.7'], [r.table[3].clientId, 'Телефон Паши'],
    ]);
    assert.equal(r.table[0].userData.creationDate, 'Tue Oct 13 21:04:00 2026');
    assert.equal(r.table[1].userData.creationDate, 'Fri Oct 23 20:15:00 2026');
    // дата неизвестна — её нет, а не дата перевода
    assert.equal(r.table[2].userData.creationDate, undefined);
    assert.match(r.table[3].userData.creationDate, QT_DATE);
    const start = r.read('root/opt/amnezia/start.sh');
    assert.match(start, /^#!\/bin\/bash\n/);
    assert.match(start, /awg-quick up \/opt\/amnezia\/awg\/awg0\.conf/);
    assert.match(start, /iptables -t nat -A POSTROUTING -s 10\.75\.144\.0\/24 -o \$dev -j MASQUERADE/);
    const dockerfile = r.read('build/Dockerfile');
    assert.match(dockerfile, /^FROM amneziavpn\/amneziawg-go:latest$/m);
    assert.match(dockerfile, /printf '#!\/bin\/bash\\ntail -f \/dev\/null\\n' >\/opt\/amnezia\/start\.sh/);
    assert.match(dockerfile, /^ENTRYPOINT \["\/bin\/sh", "-c", "trap 'exit 0' TERM INT; \/opt\/amnezia\/start\.sh & wait \$!"\]$/m);
    // прежняя папка — копией рядом
    assert.equal(r.read('keenetic-vpn/awg0.conf'), null);
    assert.equal(r.read('keenetic-vpn.old/awg0.conf'), OLD_CONF);
    assert.ok(r.lines.includes('@@server 3 41234') && r.lines.includes('@@format amnezia'));
    assert.deepEqual(peersOf(r.lines).map((p) => p.comment.replace(/, \d{4}-.*/, '')), ['роутер Keenetic', 'устройство: Ноутбук', 'устройство: Подключение 10.75.144.7', 'устройство: Телефон Паши']);
  });
});

test('Прежний формат: не вышло перевести — работает как раньше, с перезапуском', () => {
  const stillOld = (r) => {
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /^@@warn Не удалось (собрать контейнер|перевести сервер) в формате? приложения Amnezia/m);
    assert.ok(r.lines.includes('@@step start Перезапускаю сервер AmneziaWG (UDP-порт 41234)'));
    assert.match(r.read('keenetic-vpn/awg0.conf'), /\n\[Peer\]\n# устройство: Телефон Паши, \d{4}-\d\d-\d\d \d\d:\d\d\nPublicKey = /);
    assert.match(r.docker, /^restart keenetic-awg$/m);
    assert.equal(r.read('keenetic-vpn.old/awg0.conf'), null);
  };
  oldServer(device('Телефон Паши'), (r) => {
    stillOld(r);
    assert.doesNotMatch(r.docker, /stop keenetic-awg|^run /m);
  }, { env: { ...device('Телефон Паши'), BUILD_FAIL: '1' } });
  oldServer(device('Телефон Паши'), (r) => {
    stillOld(r);
    // новый контейнер не запустился — удалён, старый запущен снова
    assert.match(r.docker, /^stop keenetic-awg\n(.*\n)*rm -f amnezia-awg2\nstart keenetic-awg$/m);
  }, { env: { ...device('Телефон Паши'), RUN_FAIL: '1' } });
  // рядом уже есть контейнер приложения Amnezia — имя занято, сервер роутера остаётся прежним
  vps({ old: OLD_CONF, containers: 'keenetic-awg amnezia-awg2', env: device('Телефон Паши') }, (r) => {
    assert.equal(r.status, 0, r.out + r.err);
    assert.doesNotMatch(r.docker, /build|stop/);
    assert.match(r.docker, /^restart keenetic-awg$/m);
    assert.ok(r.lines.includes('@@server 3 41234') && r.lines.includes('@@format old'));
  });
});

test('Новый сервер — сразу в формате приложения Amnezia', () => {
  vps({ env: { PROFILE: '3', SUBNET: '10.77.12', ENDPOINT: '203.0.113.10' } }, (r) => {
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.docker, /^pull -q amneziavpn\/amneziawg-go:latest$/m);
    const port = r.conf.match(/^ListenPort = (\d+)$/m)[1];
    assert.match(r.docker, new RegExp(`^run -d --name amnezia-awg2 --restart always .* -p ${port}:${port}/udp amnezia-awg2$`, 'm'));
    assert.match(r.docker, /^restart amnezia-awg2$/m);
    assert.doesNotMatch(r.docker, /syncconf/);
    // настройки — в контейнере, как у приложения: ключи, общий PSK, clientsTable, start.sh
    assert.match(r.conf, /^\[Interface\]\nPrivateKey = (K[0-9a-f]{16}=)\nAddress = 10\.77\.12\.1\/24\n/);
    const key = r.conf.match(/^PrivateKey = (.*)$/m)[1];
    assert.equal(r.read('root/opt/amnezia/awg/wireguard_server_private_key.key'), `${key}\n`);
    assert.equal(r.read('root/opt/amnezia/awg/wireguard_server_public_key.key'), `P${key}\n`);
    assert.match(r.read('root/opt/amnezia/awg/wireguard_psk.key'), /^K[0-9a-f]{16}=\n$/);
    assert.match(r.read('root/opt/amnezia/start.sh'), /-s 10\.77\.12\.0\/24 -j ACCEPT/);
    // I1 для подключений, которые создаст само приложение, — комментарием, как у него
    decodeDnsMask(r.conf.match(/^# I1 = (.*)$/m)[1]);
    assert.match(r.conf, /\n\[Peer\]\nPublicKey = PK[0-9a-f]{16}=\nPresharedKey = K[0-9a-f]{16}=\nAllowedIPs = 10\.77\.12\.2\/32\n$/);
    assert.deepEqual(names(r.table), ['Роутер Keenetic']);
    assert.ok(r.lines.some((l) => l.startsWith('@@step app Сервер — в формате приложения Amnezia')));
    assert.ok(r.lines.includes('@@step done Сервер готов, подключений на нём: 1'));
    const pp = params(r.client.split('[Peer]')[1]);
    assert.equal(pp.PublicKey, `P${key}`);
    assert.equal(pp.Endpoint, `203.0.113.10:${port}`);
  });
  vps({ env: { PROFILE: '3', SUBNET: '10.77.12', ENDPOINT: '203.0.113.10' }, code: 'uname() { echo aarch64; }' }, (r) =>
    assert.match(r.out, /@@error процессор сервера aarch64 не подходит/));
  vps({ env: { PROFILE: '3', SUBNET: '10.77.12', ENDPOINT: '203.0.113.10' }, code: 'OS_RELEASE=/nonexistent' }, (r) =>
    assert.match(r.out, /@@error нужна Ubuntu/));
  // не запустился — контейнер удалён, повторная попытка начнёт заново
  vps({ env: { PROFILE: '3', SUBNET: '10.77.12', ENDPOINT: '203.0.113.10', RUN_FAIL: '1' } }, (r) => {
    assert.match(r.out, /@@error AmneziaWG не запустился/);
    assert.match(r.docker, /^rm -f amnezia-awg2$/m);
  });
});

test('Устройства: имя с управляющими символами не подделает строки @@, неверные данные — понятные ошибки', () => {
  amneziaServer(device('x\n@@done\n@@error ой\\n', '203.0.113.10'), (r) => {
    assert.equal(r.status, 0, r.out + r.err);
    assert.equal(r.lines.filter((l) => l === '@@done').length, 1);
    assert.ok(!r.lines.some((l) => l.startsWith('@@error')));
    assert.equal(names(r.table)[2], 'x@@done@@error ой\\n');
  });
  amneziaServer({ ...device('x'), NAME: '' }, (r) => assert.match(r.out, /@@error неверное имя устройства/));
  amneziaServer(device('я'.repeat(61)), (r) => assert.match(r.out, /@@error неверное имя устройства/));
  amneziaServer(device('x', 'a;b'), (r) => assert.match(r.out, /@@error неверный адрес сервера/));
  amneziaServer({ MODE: 'remove', PEER: `${'Z'.repeat(43)}=` }, (r) => {
    assert.match(r.out, /@@error этого подключения на сервере уже нет/);
    assert.equal(r.conf, APP_CONF);
  });
  for (const bad of ['', 'abc', `${'R'.repeat(42)}a=;`, `${'R'.repeat(43)}`]) {
    // ключ проверяется до перевода прежнего формата: с неверным сервер не меняется
    oldServer({ MODE: 'remove', PEER: bad }, (r) => {
      assert.match(r.out, /@@error неверный ключ подключения/, bad);
      assert.doesNotMatch(r.docker, /build|stop/);
    });
  }
});

test('MODE на сервере без VPN — понятная ошибка', () => {
  vps({ env: { MODE: 'list' } }, (r) => {
    assert.notEqual(r.status, 0);
    assert.match(r.out, /@@error на этом сервере нет VPN AmneziaWG — сначала подключите к нему роутер/);
  });
  oldServer({ MODE: 'reboot' }, (r) => assert.match(r.out, /@@error неизвестное действие/));
});
