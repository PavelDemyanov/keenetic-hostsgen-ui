// Чистые функции web/vps.js и web/common.js, синтаксис server/vps-setup.sh: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vps = require('../web/vps.js');
const common = require('../web/common.js');

test('awgProfile: AmneziaWG 3.1 — с KeeneticOS 5.2 Alpha 11', () => {
  assert.equal(vps.awgProfile({ release: '5.02.B.0.0-0', title: '5.2 Beta 0' }), 3);
  assert.equal(vps.awgProfile({ release: '5.02.A.11.0-0' }), 3);
  assert.equal(vps.awgProfile({ release: '5.02.A.10.0-0' }), 1);
  assert.equal(vps.awgProfile({ release: '5.02.C.1.0-0' }), 3);
  assert.equal(vps.awgProfile({ release: '5.03.A.0.0-0' }), 3);
  assert.equal(vps.awgProfile({ release: '6.00.A.0.0-0' }), 3);
  assert.equal(vps.awgProfile({ release: '5.01.C.3.0-0' }), 1);
  assert.equal(vps.awgProfile({ release: '4.03.C.6.0-0' }), 1);
  assert.equal(vps.awgProfile({ title: '5.2 Alpha 3' }), 1);
  assert.equal(vps.awgProfile({ title: '5.2.1' }), 3);
  assert.equal(vps.awgProfile({}), 1);
  assert.equal(vps.awgProfile(null), 1);
});

test('pickSubnet: 10.64–10.127, не пересекаясь с сетями роутера', () => {
  const seq = (...values) => {
    let i = 0;
    return () => values[i++ % values.length];
  };
  // первый кандидат 10.64.0.0/24 занят интерфейсом 10.64.0.1/16, второй свободен
  const used = [
    { address: '192.168.0.1', mask: '255.255.255.0' },
    { address: '10.64.0.1', mask: '255.255.0.0' },
    { address: '', mask: '' },
    {},
  ];
  assert.equal(vps.pickSubnet(used, seq(0, 0, 0.5, 0.5)), '10.96.128');
  assert.equal(vps.pickSubnet([{ address: '10.0.0.1', mask: '255.0.0.0' }], () => 0.3), null);
  assert.match(vps.pickSubnet([]), /^10\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}$/);
});

test('maskPassword: XOR с маской, обратимо', () => {
  const pad = 'a5'.repeat(128);
  const secret = vps.maskPassword('пароль 1!', pad);
  const bytes = secret.match(/../g).map((h) => parseInt(h, 16) ^ 0xa5);
  assert.equal(Buffer.from(bytes).toString('utf8'), 'пароль 1!');
  assert.throws(() => vps.maskPassword('x'.repeat(129), pad), /длиннее 128/);
  assert.throws(() => vps.maskPassword('', pad), /пустой/);
});

test('readStatus: шаги, журнал, ошибка и настройки по частям', () => {
  const conf = '[Interface]\nPrivateKey = abc\n\n[Peer]\nEndpoint = 203.0.113.10:41234\n';
  const b64 = Buffer.from(conf).toString('base64');
  const job = vps.newJob();
  vps.readStatus(['@@state running 4 4', '@@step connect Подключаюсь к серверу 203.0.113.10', '@@step check Проверяю сервер', 'Reading package lists...', '@@conf-begin'], job);
  assert.equal(job.state, 'running');
  assert.equal(job.next, 4);
  assert.deepEqual(job.steps.map((s) => s.code), ['connect', 'check']);
  assert.deepEqual(job.log, ['Reading package lists...']);
  vps.readStatus(['@@state done 9 9', b64.slice(0, 20), b64.slice(20), '@@conf-end', '@@done', '', '', 'process terminated'], job);
  assert.deepEqual(job.log, ['Reading package lists...']);
  assert.equal(job.state, 'done');
  assert.equal(job.total, 9);
  assert.equal(job.conf, conf);
  assert.equal(job.done, true);
  assert.equal(vps.endpointHost(job.conf), '203.0.113.10');

  const failed = vps.readStatus(['@@state failed 2 2', '@@step connect Подключаюсь', '@@error сервер не принял логин или пароль'], vps.newJob());
  assert.equal(failed.error, 'сервер не принял логин или пароль');
});

test('HOST_RE: IP и домены без пробелов и подчёркиваний', () => {
  for (const ok of ['203.0.113.10', 'vps.example.com', 'a']) assert.ok(vps.HOST_RE.test(ok), ok);
  for (const bad of ['', '-x.com', 'x.com.', 'a b', 'a_b.com', 'x;rm', '[::1]']) assert.ok(!vps.HOST_RE.test(bad), bad);
});

test('common: plural и errorsOf', () => {
  assert.equal(common.plural(1, 'маршрут', 'маршрута', 'маршрутов'), 'маршрут');
  assert.equal(common.plural(3, 'маршрут', 'маршрута', 'маршрутов'), 'маршрута');
  assert.equal(common.plural(11, 'маршрут', 'маршрута', 'маршрутов'), 'маршрутов');
  const reply = { ip: { policy: { route: { status: [{ status: 'error', message: 'bad mask' }] } } }, status: [{ status: 'message', message: 'ok' }] };
  assert.deepEqual(common.errorsOf(reply), ['bad mask']);
});

test('server/vps-setup.sh: синтаксис POSIX sh', () => {
  const shell = spawnSync('dash', ['-c', 'true']).status === 0 ? 'dash' : 'sh';
  const r = spawnSync(shell, ['-n', path.join(__dirname, '../server/vps-setup.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
