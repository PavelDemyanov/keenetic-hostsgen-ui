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
