// Чистые функции web/addon.js: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const hg = require('../web/addon.js');

const ip = hg.ipToInt;
const show = (plan) => plan.items.map((i) => `${hg.intToIp(i.net)}/${i.bits}${i.existing ? ' есть' : ''}`);

test('maskToBits: только непрерывные маски', () => {
  assert.equal(hg.maskToBits('255.255.0.0'), 16);
  assert.equal(hg.maskToBits('255.255.255.255'), 32);
  assert.equal(hg.maskToBits('0.0.0.0'), 0);
  assert.equal(hg.maskToBits('255.0.255.0'), null);
  assert.equal(hg.maskToBits('300.0.0.0'), null);
});

test('parseInput: домены, URL, IP, CIDR и строки route ADD', () => {
  const r = hg.parseInput(
    [
      'YouTube.com',
      'https://rr1.googlevideo.com:443/videoplayback?x=1',
      '*.example.org',
      'кинопоиск.рф',
      '157.240.3.35, 8.8.8.8',
      '10.0.0.0/8',
      'route ADD 216.239.0.0 MASK 255.255.0.0 0.0.0.0',
      '# комментарий',
      'не-домен!',
      'route ADD 1.2.3.4 MASK 255.0.255.0 0.0.0.0',
    ].join('\n'),
  );
  assert.deepEqual([...r.hosts].sort(), ['example.org', 'rr1.googlevideo.com', 'xn--h1aaecngahu.xn--p1ai', 'youtube.com']);
  assert.deepEqual([...r.ips.values()].sort(), ['157.240.3.35', '8.8.8.8']);
  assert.deepEqual(
    r.nets.map((n) => [hg.intToIp(n.net), n.bits]),
    [
      ['10.0.0.0', 8],
      ['216.239.0.0', 16],
    ],
  );
  assert.equal(r.skipped.length, 2);
});

test('parseHar: домены запросов и адреса серверов', () => {
  const har = JSON.stringify({
    log: {
      entries: [
        { request: { url: 'https://www.youtube.com/watch?v=1' }, serverIPAddress: '142.250.74.46' },
        { request: { url: 'https://i.ytimg.com/vi/1.jpg' }, serverIPAddress: '[2a00:1450::1]' },
        { request: { url: 'data:image/png;base64,AAA' } },
        { request: { url: 'wss://live.example.com/socket' }, serverIPAddress: '93.184.216.34' },
      ],
    },
  });
  const r = hg.parseHar(har);
  assert.equal(r.entries, 4);
  assert.deepEqual([...r.hosts].sort(), ['i.ytimg.com', 'live.example.com', 'www.youtube.com']);
  assert.deepEqual([...r.serverIps.get('www.youtube.com')], ['142.250.74.46']);
  assert.equal(r.serverIps.has('i.ytimg.com'), false);
  assert.throws(() => hg.parseHar('{"log":{}}'), /не HAR/);
  assert.throws(() => hg.parseHar('not json'), /не JSON/);
});

test('buildPlan: маска, склейка вложенных, существующие маршруты, локальные адреса', () => {
  const existing = hg.parseExisting([
    { network: '216.239.0.0', mask: '255.255.0.0', interface: 'Wireguard0' },
    { host: '9.9.9.9', interface: 'Wireguard0' },
    { network: '1.0.0.0', mask: '255.0.0.0', interface: 'Wireguard0', disable: true },
    { default: true, interface: 'Wireguard0' },
  ]);
  assert.equal(existing.length, 2);
  const plan = hg.buildPlan(
    {
      ips: [
        { ip: ip('216.239.38.120'), from: 'a.com' },
        { ip: ip('142.250.74.46'), from: 'b.com' },
        { ip: ip('142.250.80.1'), from: 'c.com' },
        { ip: ip('192.168.1.10'), from: 'local' },
        { ip: ip('1.1.1.1'), from: 'd.com' },
        { ip: ip('9.9.9.9'), from: 'e.com' },
      ],
      nets: [{ net: ip('142.0.0.0'), bits: 8, from: '142.0.0.0/8' }],
    },
    16,
    existing,
  );
  assert.deepEqual(show(plan), ['1.1.0.0/16', '9.9.0.0/16', '142.0.0.0/8', '216.239.0.0/16 есть']);
  assert.deepEqual([...plan.items[2].from].sort(), ['142.0.0.0/8', 'b.com', 'c.com']);
  assert.equal(plan.reserved, 1);

  // /32: каждый адрес отдельно; 9.9.9.9 уже есть как маршрут до узла
  assert.deepEqual(show(hg.buildPlan({ ips: [{ ip: ip('9.9.9.9'), from: 'e.com' }], nets: [] }, 32, existing)), ['9.9.9.9/32 есть']);
});

test('смена интерфейса: назначение, сопоставление строк таблицы и команды RCI', () => {
  const routes = [
    { network: '216.239.0.0', mask: '255.255.0.0', interface: 'Wireguard0', auto: true, index: 'a1', comment: '' },
    { host: '107.189.14.230', interface: 'Wireguard0', auto: true, index: 'b2', comment: 'entware' },
    { network: '10.0.0.0', mask: '255.0.0.0', gateway: '192.168.0.2', interface: 'Bridge0', auto: false, index: 'c3' },
    { network: '216.239.0.0', mask: '255.255.0.0', interface: 'Wireguard1', auto: true, index: 'd4' },
  ];
  assert.equal(hg.routeDestination(routes[0]), '216.239.0.0/16');
  assert.equal(hg.routeDestination(routes[1]), '107.189.14.230');

  const names = { Wireguard0: 'vpn-nl', Wireguard1: 'test' };
  const labels = (id) => [names[id], id].filter(Boolean);
  const { found, missing } = hg.matchRows(
    [
      { destination: '216.239.0.0/16', gateway: '', iface: 'test' }, // та же сеть, другой интерфейс — по подписи
      { destination: '107.189.14.230', gateway: '', iface: 'vpn-nl' },
      { destination: '10.0.0.0/8', gateway: '192.168.0.2', iface: 'Домашняя сеть' }, // подпись не та, но маршрут один
      { destination: '1.2.3.0/24', gateway: '', iface: 'vpn-nl' },
    ],
    routes,
    labels,
  );
  assert.deepEqual(found.map((r) => r.index), ['d4', 'b2', 'c3']);
  assert.deepEqual(missing, ['1.2.3.0/24']);

  assert.deepEqual(hg.moveCommands(routes[1], 'Wireguard1', ''), [
    { ip: { route: { index: 'b2', no: true } } },
    { ip: { route: { host: '107.189.14.230', interface: 'Wireguard1', auto: true, comment: 'entware' } } },
  ]);
  assert.deepEqual(hg.moveCommands(routes[2], 'Wireguard1', 'Policy1'), [
    { ip: { policy: { name: 'Policy1', route: { index: 'c3', no: true } } } },
    { ip: { policy: { name: 'Policy1', route: { network: '10.0.0.0', mask: '255.0.0.0', interface: 'Wireguard1', auto: false } } } },
  ]);
});
