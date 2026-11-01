// web/qr.js: QR-код для окна «Добавить устройство». Что коды читаются, проверено распознаванием macOS Vision
// (все 40 версий на четырёх уровнях коррекции); здесь — служебные узоры и формат, чтобы правки их не сломали.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { qrMatrix, qrSvg, dataCodewords } = require('../web/qr.js');

/** Биты формата из первой копии (у искателя слева сверху) и второй (у двух других). */
function formatBits(m) {
  const size = m.length;
  const first = [];
  for (let i = 0; i <= 5; i++) first.push(m[i][8]);
  first.push(m[7][8], m[8][8], m[8][7]);
  for (let i = 9; i < 15; i++) first.push(m[8][14 - i]);
  const second = [];
  for (let i = 0; i < 8; i++) second.push(m[8][size - 1 - i]);
  for (let i = 8; i < 15; i++) second.push(m[size - 15 + i][8]);
  const toInt = (bits) => bits.reduce((n, b, i) => n | (Number(b) << i), 0);
  return [toInt(first), toInt(second)];
}

test('qrMatrix: версия по длине, искатели, тайминги и формат', () => {
  for (const [length, level, version] of [[1, 'M', 1], [14, 'M', 1], [15, 'M', 2], [770, 'M', 22], [770, 'L', 19], [2331, 'M', 40]]) {
    const m = qrMatrix('x'.repeat(length), level);
    assert.equal(m.length, version * 4 + 17, `${length} байт, ${level}`);
    const size = m.length;
    // искатель: квадрат 7×7 с центром 3×3
    for (const [x0, y0] of [[0, 0], [size - 7, 0], [0, size - 7]]) {
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
          assert.equal(m[y0 + y][x0 + x], ring !== 2, `искатель ${x0},${y0}`);
        }
      }
    }
    for (let i = 8; i < size - 8; i++) {
      assert.equal(m[6][i], i % 2 === 0);
      assert.equal(m[i][6], i % 2 === 0);
    }
    assert.equal(m[size - 8][8], true, 'всегда тёмный модуль');
    const [a, b] = formatBits(m);
    assert.equal(a, b, 'две копии формата совпадают');
    const data = (a ^ 0x5412) >>> 10;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    assert.equal(((data << 10) | rem) ^ 0x5412, a, 'код BCH формата');
    assert.equal(data >>> 3, { L: 1, M: 0, Q: 3, H: 2 }[level], 'уровень коррекции');
  }
  assert.throws(() => qrMatrix('x'.repeat(2332), 'M'), /слишком много данных/);
  assert.equal(dataCodewords(40, 0), 2956);
});

test('qrMatrix: тот же результат, что проверенный распознаванием (снимок)', () => {
  // UTF-8 с кириллицей и настройки длиной как у настоящих; при правке qr.js снимок обновлять, только
  // заново проверив коды распознаванием
  const text = `[Interface]\nPrivateKey = ${'A'.repeat(43)}=\n# Телефон Паши\n${'I1 = <r 2><b 0x0120>\n'.repeat(30)}`;
  const m = qrMatrix(text, 'L');
  const hash = crypto.createHash('sha256').update(m.map((row) => row.map(Number).join('')).join('\n')).digest('hex');
  assert.equal(m.length, 93);
  assert.equal(hash.slice(0, 16), '750ffbdc0c9588aa');
});

test('qrSvg: белые поля в 4 модуля, тёмные модули — путь', () => {
  const svg = qrSvg(qrMatrix('hi', 'M'), 200);
  assert.match(svg, /^<svg [^>]*viewBox="0 0 29 29" width="200" height="200"/);
  assert.match(svg, /<rect width="29" height="29" fill="#fff"\/>/);
  assert.match(svg, /<path d="M4 4h1v1h-1z/);
});
