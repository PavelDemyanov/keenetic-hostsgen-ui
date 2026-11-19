// Чистые функции web/vps.js и web/common.js, синтаксис server/vps-setup.sh: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vps = require('../web/vps.js');
const common = require('../web/common.js');

test('awgProfile: 1.0 до 5.1 Alpha 3, 2.0 до 5.2 Alpha 10, дальше 3.1', () => {
  const p = (release, title) => vps.awgProfile({ release, title });
  // 3.1 — с 5.2 Alpha 11
  assert.equal(p('5.02.B.0.0-0', '5.2 Beta 0'), 3);
  assert.equal(p('5.02.A.11.0-0'), 3);
  assert.equal(p('5.02.C.1.0-0'), 3);
  assert.equal(p('5.03.A.0.0-0'), 3);
  assert.equal(p('6.00.A.0.0-0'), 3);
  assert.equal(p(undefined, '5.2.1'), 3);
  // 2.0 — с 5.1 Alpha 3 до 5.2 Alpha 10, в том числе вся стабильная 5.1
  assert.equal(p('5.02.A.10.0-0'), 2);
  assert.equal(p('5.02.A.0.0-0'), 2);
  assert.equal(p('5.01.C.7.0-4'), 2);
  assert.equal(p('5.01.C.3.0-0'), 2);
  assert.equal(p('5.01.B.0.0-1'), 2);
  assert.equal(p('5.01.A.3.0-0'), 2);
  assert.equal(p(undefined, '5.2 Alpha 3'), 2);
  assert.equal(p(undefined, '5.1.7'), 2);
  assert.equal(p(undefined, '5.1 Alpha 3'), 2);
  // 1.0 — всё, что старше
  assert.equal(p('5.01.A.2.0-0'), 1);
  assert.equal(p(undefined, '5.1 Alpha 2'), 1);
  assert.equal(p('5.00.C.4.0-0'), 1);
  assert.equal(p('4.03.C.6.0-0'), 1);
  assert.equal(vps.awgProfile({}), 1);
  assert.equal(vps.awgProfile(null), 1);
});

test('profileNote: окно предупреждает, к каким роутерам подойдёт новый сервер', () => {
  assert.match(vps.profileNote(3, '5.2 Beta 0'), /только роутеры с KeeneticOS 5\.2 и новее.*версию 2\.0 или 1\.0/);
  assert.match(vps.profileNote(2, '5.1.7'), /AmneziaWG 2\.0: ваша прошивка \(5\.1\.7\).*KeeneticOS 5\.1 и новее.*версию 1\.0/);
  assert.match(vps.profileNote(1, '4.3.6'), /\(4\.3\.6\) понимает только AmneziaWG 1\.0/);
  assert.match(vps.profileNote(1, ''), /версия неизвестна/);
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
  assert.equal(vps.endpointPort(job.conf), '41234');
  assert.equal(vps.endpointPort(''), '');

  const failed = vps.readStatus(['@@state failed 2 2', '@@step connect Подключаюсь', '@@error сервер не принял логин или пароль'], vps.newJob());
  assert.equal(failed.error, 'сервер не принял логин или пароль');

  const warned = vps.readStatus(['@@step check Проверяю сервер', '@@warn Сервер уже работает на AmneziaWG 1.0', '@@step docker Устанавливаю Docker'], vps.newJob());
  assert.deepEqual(warned.steps.map((s) => [s.text, Boolean(s.warn)]), [
    ['Проверяю сервер', false],
    ['Сервер уже работает на AmneziaWG 1.0', true],
    ['Устанавливаю Docker', false],
  ]);
});

test('HOST_RE: IP и домены без пробелов и подчёркиваний', () => {
  for (const ok of ['203.0.113.10', 'vps.example.com', 'a']) assert.ok(vps.HOST_RE.test(ok), ok);
  for (const bad of ['', '-x.com', 'x.com.', 'a b', 'a_b.com', 'x;rm', '[::1]']) assert.ok(!vps.HOST_RE.test(bad), bad);
});

test('expertOptions: строки для vps-setup.sh, чужая конфигурация без ключей и адресов', () => {
  assert.deepEqual(vps.expertOptions({}, 3), { text: '', errors: [] });
  assert.deepEqual(vps.expertOptions({ mask: 'dns', port: ' ', custom: '\n' }, 3), { text: '', errors: [] });
  assert.equal(vps.expertOptions({ mask: 'noise' }, 3).text, 'Mask = noise\n');
  assert.equal(vps.expertOptions({ mask: 'off' }, 1).text, ''); // в AmneziaWG 1.0 пакета I1 нет

  const pasted = [
    '[Interface]',
    'PrivateKey = aGVsbG8=',
    'Address = 10.8.1.2/32',
    'DNS = 1.1.1.1',
    'MTU = 1280',
    'jc = 5  # регистр ключей не важен',
    'Jmin = 40',
    'Jmax = 120',
    'S1 = 30',
    'S3 = 40',
    'H1 = 100000-150000',
    'I1 = <r 2><b 0x0100000100000000000002766b03636f6d0000010001>',
    'I2 = <t><rc 10>',
    'HeaderProtectionKey = aGVsbG8=',
    'RekeyAfterTime = 90-110',
    'ListenPort = 51820',
    '',
    '[Peer]',
    'PublicKey = aGVsbG8=',
    'Endpoint = 203.0.113.10:51820',
    'PersistentKeepalive = 21',
  ].join('\n');
  const options = vps.expertOptions({ mask: 'noise', port: '443', custom: pasted }, 3);
  assert.deepEqual(options.errors, []);
  assert.equal(
    options.text,
    [
      'MTU = 1280', 'Jc = 5', 'Jmin = 40', 'Jmax = 120', 'S1 = 30', 'S3 = 40', 'H1 = 100000-150000',
      'I1 = <r 2><b 0x0100000100000000000002766b03636f6d0000010001>', 'I2 = <t><rc 10>',
      'RekeyAfterTime = 90-110', 'ListenPort = 443', 'PersistentKeepalive = 21', 'Mask = noise', '',
    ].join('\n'),
  );
});

test('expertOptions: ошибки — до того, как роутер пойдёт на сервер', () => {
  const errors = (custom, profile = 3, extra = {}) => vps.expertOptions({ custom, ...extra }, profile).errors;
  assert.match(errors('Foo = 1')[0], /неизвестный параметр «Foo»/);
  assert.match(errors('просто текст')[0], /непонятная строка/);
  assert.match(errors('Jc = 200')[0], /от 0 до 128/);
  assert.match(errors('S1 = 5')[0], /от 12 до 1132/); // защита заголовков 3.1 — S от 12
  assert.deepEqual(errors('S1 = 5', 1), []);
  assert.match(errors('S4 = 40')[0], /от 12 до 32/);
  assert.match(errors('S3 = 10', 1)[0], /«S3» есть только в AmneziaWG 2\.0 и новее, а прошивка роутера понимает только AmneziaWG 1\.0/);
  assert.match(errors('RekeyAfterTime = 100', 2)[0], /только в AmneziaWG 3\.1, а прошивка роутера понимает только AmneziaWG 2\.0/);
  assert.match(errors('I4 = <c><b 0xdeadbeef>')[0], /<c> прошивка Keenetic не принимает/);
  assert.match(errors('I1 = <r 2><x 5>')[0], /нужна цепочка тегов/);
  assert.match(errors('I1 = <r 1001>')[0], /не больше 1000/);
  assert.match(errors('I1 = <r 1000><r 300>')[0], /больше 1280 байт/);
  assert.match(errors('H1 = 5-10', 1)[0], /для AmneziaWG 1\.0 — только одно число/);
  assert.match(errors('H1 = 5-10', 2)[0], /для AmneziaWG 2\.0 — только одно число/);
  assert.match(errors('H1 = 10-5')[0], /диапазон/);
  assert.match(errors('H1 = 2')[0], /H1 и H2 пересекаются/); // H2 у 3.1 по умолчанию — 2
  assert.match(errors('H3 = 100-200\nH4 = 150')[0], /H3 и H4 пересекаются/);
  assert.match(errors('S1 = 12\nS2 = 68')[0], /S1 и S2/); // 148+12 = 92+68
  assert.match(errors('Jmin = 300\nJmax = 100')[0], /Jmin больше Jmax/);
  assert.match(errors('RekeyAfterTime = 100-200')[0], /30–140/);
  assert.match(errors('RejectAfterTime = 120')[0], /150–600/);
  assert.match(errors('', 3, { port: '70000' })[0], /ListenPort = 70000/);
});

test('expertOptions: AmneziaWG 2.0 и выбор версии нового сервера', () => {
  const opts = (custom, profile, extra = {}) => vps.expertOptions({ custom, ...extra }, profile);
  // 2.0: S3, S4 и I1–I5 есть, S меньше 12 можно (нет защиты заголовков), теги — только <b>, <r>, <t>
  assert.deepEqual(opts('S3 = 5\nS4 = 3\nI2 = <t><r 10>', 2).errors, []);
  assert.match(opts('I1 = <rd 5>', 2).errors[0], /только теги <b 0x…>, <r N> и <t>/);
  assert.match(opts('I1 = <rc 5>', 2).errors[0], /только теги/);
  assert.deepEqual(opts('I1 = <rd 5>', 3).errors, []);
  assert.equal(opts('', 2, { mask: 'noise' }).text, 'Mask = noise\n');
  // версия нового сервера постарше: для роутеров со старыми прошивками
  assert.equal(opts('', 3, { version: '2' }).text, 'Version = 2\n');
  assert.equal(opts('', 3, { version: '3' }).text, '');
  assert.equal(opts('', 3, { version: '1', mask: 'noise' }).text, 'Version = 1\n'); // в 1.0 пакета I1 нет
  assert.match(opts('RejectAfterTime = 200', 3, { version: '2' }).errors[0], /для сервера выбрана AmneziaWG 2\.0/);
  assert.match(opts('S1 = 5', 3, { version: '2' }).text, /^S1 = 5\nVersion = 2\n$/); // без защиты заголовков S от 0
  assert.match(opts('', 2, { version: '3' }).errors[0], /понимает только AmneziaWG 2\.0, а для сервера выбрана AmneziaWG 3\.1/);
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

// ---------- «Добавить устройство» ----------

const b64 = (text) => Buffer.from(text).toString('base64');

test('readStatus: работа окна «Устройства» — чья она, сервер, подключения и настройки устройства', () => {
  const key1 = `${'A'.repeat(42)}a=`;
  const key2 = `${'B'.repeat(42)}b=`;
  const conf = '[Interface]\nPrivateKey = K=\nDNS = 1.1.1.1, 1.0.0.1\n\n[Peer]\nEndpoint = 203.0.113.10:41234\n';
  const confLines = b64(conf).match(/.{1,40}/g);
  const job = vps.readStatus(
    ['@@state running 9 9', '@@job device', '@@step check Проверяю сервер', '@@step config Добавляю устройство «Телефон» (AmneziaWG 3.1)',
      '@@server 3 41234', '@@format amnezia', '@@now 1792000300',
      `@@peer ${key1} 10.75.144.2 1792000000 123 456 ${b64('роутер Keenetic, 2026-10-13 21:04')}`,
      `@@peer ${key2} 10.75.144.3 0 0 0 ${b64('устройство: Телефон, мой, 2026-10-23 20:15')}`,
      '@@conf-begin', confLines[0], 'process terminated'],
    vps.newJob(),
  );
  // журнал пришёл двумя порциями: ndm дописал «process terminated» посреди настроек
  vps.readStatus(['@@state done 14 14', ...confLines.slice(1), '@@conf-end', '@@done', ''], job);
  assert.equal(job.kind, 'device');
  assert.deepEqual(job.server, { profile: 3, port: '41234', format: 'amnezia' });
  // сценарий модуля до 1.5 формат не писал
  assert.deepEqual(vps.readStatus(['@@server 1 5555'], vps.newJob()).server, { profile: 1, port: '5555', format: '' });
  assert.deepEqual(vps.readStatus(['@@server 1 5555', '@@format old'], vps.newJob()).server, { profile: 1, port: '5555', format: 'old' });
  assert.match(vps.formatNote('amnezia'), /видны в приложении AmneziaVPN, и наоборот/);
  assert.match(vps.formatNote('old'), /перейдёт в формат приложения Amnezia/);
  assert.equal(vps.formatNote(''), '');
  assert.equal(job.now, 1792000300);
  assert.deepEqual(job.peers, [
    { key: key1, address: '10.75.144.2', handshake: 1792000000, rx: 123, tx: 456, kind: 'router', name: '', added: '2026-10-13 21:04' },
    { key: key2, address: '10.75.144.3', handshake: 0, rx: 0, tx: 0, kind: 'device', name: 'Телефон, мой', added: '2026-10-23 20:15' },
  ]);
  assert.equal(job.conf, conf);
  assert.equal(job.done, true);
  assert.deepEqual(job.log, []);
  // журнал «Создать на своём сервере» от помощника 1.4 и старого, без @@job
  assert.equal(vps.readStatus(['@@job router'], vps.newJob()).kind, 'router');
  assert.equal(vps.readStatus(['@@step check Проверяю сервер'], vps.newJob()).kind, null);
});

test('parsePeerLabel и peerTitle: роутеры, устройства, подключения без подписи', () => {
  assert.deepEqual(vps.parsePeerLabel('роутер Keenetic, 2026-10-13 21:04'), { kind: 'router', name: '', added: '2026-10-13 21:04' });
  assert.deepEqual(vps.parsePeerLabel('роутер Keenetic'), { kind: 'router', name: '', added: '' });
  assert.deepEqual(vps.parsePeerLabel('устройство: Ноутбук, 2026-10-23 20:15'), { kind: 'device', name: 'Ноутбук', added: '2026-10-23 20:15' });
  // подключение из приложения Amnezia без даты
  assert.deepEqual(vps.parsePeerLabel('устройство: Client 1'), { kind: 'device', name: 'Client 1', added: '' });
  assert.deepEqual(vps.parsePeerLabel('устройство: Дача, 5'), { kind: 'device', name: 'Дача, 5', added: '' });
  assert.deepEqual(vps.parsePeerLabel('ноутбук Васи'), { kind: 'other', name: 'ноутбук Васи', added: '' });
  assert.deepEqual(vps.parsePeerLabel(''), { kind: 'other', name: '', added: '' });
  assert.equal(vps.peerTitle({ kind: 'router' }, 'VPN Нидерланды'), 'Этот роутер — VPN Нидерланды');
  assert.equal(vps.peerTitle({ kind: 'router' }), 'Роутер Keenetic');
  assert.equal(vps.peerTitle({ kind: 'device', name: 'Ноутбук' }), 'Ноутбук');
  assert.equal(vps.peerTitle({ kind: 'other', name: '' }), 'Без подписи');
});

test('linkText и formatBytes: связь и трафик по-человечески', () => {
  const now = 1792000000;
  assert.equal(vps.linkText({ handshake: 0 }, now), 'ещё не подключалось');
  assert.equal(vps.linkText({ handshake: now - 100 }, now), 'на связи');
  assert.equal(vps.linkText({ handshake: now + 30 }, now), 'на связи', 'часы сервера и роутера могут расходиться');
  assert.equal(vps.linkText({ handshake: now - 300 }, now), 'был на связи 5 минут назад');
  assert.equal(vps.linkText({ handshake: now - 2 * 3600 }, now), 'был на связи 2 часа назад');
  assert.equal(vps.linkText({ handshake: now - 21 * 86400 }, now), 'был на связи 21 день назад');
  assert.equal(vps.formatBytes(512), '512 Б');
  assert.equal(vps.formatBytes(1536), '1,5 КБ');
  assert.equal(vps.formatBytes(250 * 1024 * 1024), '250 МБ');
  assert.equal(vps.formatBytes(3.25 * 1024 ** 3), '3,3 ГБ');
});

test('deviceNameError, deviceFileName и toBase64: имя устройства', () => {
  assert.equal(vps.deviceNameError('Телефон Паши'), '');
  assert.match(vps.deviceNameError(''), /введите имя/);
  assert.match(vps.deviceNameError('я'.repeat(33)), /не длиннее 32/);
  assert.equal(vps.deviceNameError('я'.repeat(32)), '');
  assert.match(vps.deviceNameError('a\nb'), /недопустимые/);
  assert.equal(vps.deviceFileName('Телефон Паши'), 'Telefon_Pashi.conf');
  assert.equal(vps.deviceFileName('Ноутбук Юли (рабочий)'), 'Noutbuk_Yuli_ra.conf');
  assert.equal(vps.deviceFileName('iPhone 15'), 'iPhone_15.conf');
  assert.equal(vps.deviceFileName('😀'), 'amneziawg.conf');
  assert.equal(vps.fromBase64(vps.toBase64('Телефон Паши')), 'Телефон Паши');
  assert.equal(vps.toBase64('Телефон'), b64('Телефон'));
});

test('deviceAppNote: какие приложения подойдут к серверу', () => {
  assert.match(vps.deviceAppNote(3), /AmneziaVPN 5 и новее.*на iPhone — только оно.*WireGuard не подойдёт/);
  assert.match(vps.deviceAppNote(2), /AmneziaWG 2\.0 и новее/);
  assert.match(vps.deviceAppNote(1), /любое приложение/);
});
