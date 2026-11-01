/*
 * hostsgen-ui — QR-код для окна «Устройства на своём сервере»: настройки подключения для телефона.
 * Своя реализация (ISO/IEC 18004, байтовый режим), потому что страница роутера не грузит чужие скрипты.
 * Устроена как QR Code generator Project Nayuki (MIT): та же раскладка модулей, коррекция
 * Рида — Соломона и выбор маски по штрафам.
 */
(() => {
  'use strict';

  // Байт коррекции на блок и число блоков: [уровень L, M, Q, H][версия 1–40]
  const ECC_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  ];
  const ECC_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  ];
  const LEVELS = { L: 0, M: 1, Q: 2, H: 3 };
  const FORMAT_BITS = [1, 0, 3, 2]; // как уровни L, M, Q, H записаны в формате

  const bit = (x, i) => ((x >>> i) & 1) !== 0;

  /** Модулей под данные и коррекцию в версии ver: всё поле минус служебные узоры. */
  function rawModules(ver) {
    let n = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const align = Math.floor(ver / 7) + 2;
      n -= (25 * align - 10) * align - 55;
      if (ver >= 7) n -= 36;
    }
    return n;
  }

  const dataCodewords = (ver, ecl) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * ECC_BLOCKS[ecl][ver];

  // ---------- коррекция Рида — Соломона, поле GF(2^8) с многочленом 0x11D ----------

  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < degree; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => {
        result[i] ^= gfMul(coef, factor);
      });
    }
    return result;
  }

  /** Данные → блоки с коррекцией, перемешанные по столбцам, как требует стандарт. */
  function addEcc(data, ver, ecl) {
    const blocks = ECC_BLOCKS[ecl][ver];
    const eccLen = ECC_PER_BLOCK[ecl][ver];
    const raw = Math.floor(rawModules(ver) / 8);
    const short = blocks - (raw % blocks);
    const shortLen = Math.floor(raw / blocks);
    const divisor = rsDivisor(eccLen);
    const all = [];
    for (let i = 0, k = 0; i < blocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, divisor);
      if (i < short) dat.push(0); // место, которого у короткого блока нет
      all.push(dat.concat(ecc));
    }
    const result = [];
    for (let i = 0; i < all[0].length; i++) {
      all.forEach((block, j) => {
        if (i !== shortLen - eccLen || j >= short) result.push(block[i]);
      });
    }
    return result;
  }

  // ---------- поле модулей ----------

  function alignmentPositions(ver, size) {
    if (ver === 1) return [];
    const count = Math.floor(ver / 7) + 2;
    const step = Math.floor((ver * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function newGrid(ver) {
    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => {
      modules[y][x] = dark;
      fixed[y][x] = true;
    };
    return { ver, size, modules, fixed, set };
  }

  function drawFormat(grid, ecl, mask) {
    const { size, set } = grid;
    const data = (FORMAT_BITS[ecl] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(8, i, bit(bits, i));
    set(8, 7, bit(bits, 6));
    set(8, 8, bit(bits, 7));
    set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(bits, i));
    set(8, size - 8, true); // всегда тёмный модуль
  }

  function drawFunctionPatterns(grid, ecl) {
    const { ver, size, set } = grid;
    for (let i = 0; i < size; i++) {
      set(6, i, i % 2 === 0);
      set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, dist !== 2 && dist !== 4);
        }
      }
    }
    const align = alignmentPositions(ver, size);
    const last = align.length - 1;
    align.forEach((x, i) =>
      align.forEach((y, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }),
    );
    drawFormat(grid, ecl, 0); // настоящий формат — после выбора маски
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        set(a, b, bit(bits, i));
        set(b, a, bit(bits, i));
      }
    }
  }

  function drawCodewords(grid, codewords) {
    const { size, modules, fixed } = grid;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // столбец таймингового узора пропускается
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
          if (!fixed[y][x] && i < codewords.length * 8) {
            modules[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  function applyMask(grid, mask) {
    const { size, modules, fixed } = grid;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!fixed[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
      }
    }
  }

  /** Штраф по правилам стандарта: длинные полосы, квадраты 2×2, похожее на искатель, перекос тёмных. */
  function penalty({ size, modules }) {
    let result = 0;
    const scan = (get) => {
      for (let a = 0; a < size; a++) {
        let color = false;
        let run = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        const push = (length) => {
          history.pop();
          history.unshift(history[0] === 0 ? length + size : length); // светлая рамка перед первой полосой
        };
        const patterns = () => {
          const n = history[1];
          const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
          return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0);
        };
        for (let b = 0; b < size; b++) {
          if (get(a, b) === color) {
            run++;
            if (run === 5) result += 3;
            else if (run > 5) result++;
          } else {
            push(run);
            if (!color) result += patterns() * 40;
            color = get(a, b);
            run = 1;
          }
        }
        if (color) {
          push(run);
          run = 0;
        }
        push(run + size);
        result += patterns() * 40;
      }
    };
    scan((y, x) => modules[y][x]);
    scan((x, y) => modules[y][x]);
    let dark = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (modules[y][x]) dark++;
        if (x < size - 1 && y < size - 1) {
          const c = modules[y][x];
          if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
        }
      }
    }
    const total = size * size;
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return result;
  }

  /**
   * Текст → матрица QR-кода (массив строк из true — тёмный модуль). Байтовый режим, UTF-8, самая маленькая
   * версия, в которую текст помещается с уровнем коррекции level (L 7 %, M 15 %, Q 25 %, H 30 %).
   */
  function qrMatrix(text, level = 'M') {
    const ecl = LEVELS[level];
    if (ecl === undefined) throw new Error(`неизвестный уровень коррекции ${level}`);
    const bytes = [...new TextEncoder().encode(text)];
    let ver = 1;
    for (; ver <= 40; ver++) {
      const bits = 4 + (ver < 10 ? 8 : 16) + bytes.length * 8;
      if (bits <= dataCodewords(ver, ecl) * 8) break;
    }
    if (ver > 40) throw new Error('слишком много данных для QR-кода');

    // Поток битов: режим «байты», длина, данные, завершающие нули и байты-заполнители
    const stream = [];
    const put = (value, length) => {
      for (let i = length - 1; i >= 0; i--) stream.push((value >>> i) & 1);
    };
    put(0b0100, 4);
    put(bytes.length, ver < 10 ? 8 : 16);
    bytes.forEach((b) => put(b, 8));
    const capacity = dataCodewords(ver, ecl) * 8;
    put(0, Math.min(4, capacity - stream.length));
    put(0, (8 - (stream.length % 8)) % 8);
    for (let pad = 0xec; stream.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < stream.length; i += 8) data.push(parseInt(stream.slice(i, i + 8).join(''), 2));

    const grid = newGrid(ver);
    drawFunctionPatterns(grid, ecl);
    drawCodewords(grid, addEcc(data, ver, ecl));
    let best = -1;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      applyMask(grid, mask);
      drawFormat(grid, ecl, mask);
      const score = penalty(grid);
      if (score < bestScore) {
        best = mask;
        bestScore = score;
      }
      applyMask(grid, mask); // маска — XOR: второй раз снимает её
    }
    applyMask(grid, best);
    drawFormat(grid, ecl, best);
    return grid.modules;
  }

  /** Матрица → SVG: чёрные модули на белом с полями в 4 модуля, как требует стандарт; size — сторона в px. */
  function qrSvg(matrix, size = 280) {
    const n = matrix.length + 8;
    let path = '';
    matrix.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) path += `M${x + 4} ${y + 4}h1v1h-1z`;
      }),
    );
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img">` +
      `<rect width="${n}" height="${n}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  }

  if (typeof window === 'undefined') {
    // node --test: чистые функции без DOM
    module.exports = { qrMatrix, qrSvg, dataCodewords };
    return;
  }
  Object.assign(window.hostsgenUi, { qrMatrix, qrSvg });
})();
