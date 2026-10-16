/*
 * hostsgen-ui — общая часть модулей веб-интерфейса KeeneticOS: запросы к RCI, вызов помощника
 * на роутере, окно поверх страницы и его стили. Модули addon.js («Добавить списком») и vps.js
 * («VPN на своём сервере») берут её из window.hostsgenUi.
 *
 * build.sh склеивает common.js, addon.js и vps.js в один файл, а помощник встраивает его inline
 * в index.html, поэтому здесь, как и в модулях, нельзя писать закрывающий тег script и открытие
 * HTML-комментария — tests это проверяют.
 */
(() => {
  'use strict';

  const HELPER = '/opt/share/hostsgen-ui/hostsgen-ui'; // helper/hostsgen-ui.c, кладёт себя сюда при start

  const plural = (n, one, few, many) => {
    const d = n % 10;
    const dd = n % 100;
    if (d === 1 && dd !== 11) return one;
    if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return few;
    return many;
  };

  /** Ошибки из ответа RCI на любой глубине: у маршрутов политик статус лежит внутри ip.policy. */
  function errorsOf(node) {
    if (!node || typeof node !== 'object') return [];
    const own = Array.isArray(node.status) ? node.status.filter((s) => s && s.status === 'error').map((s) => s.message) : [];
    return own.concat(...Object.entries(node).map(([key, value]) => (key === 'status' ? [] : errorsOf(value))));
  }

  if (typeof window === 'undefined') {
    // node --test: чистые функции без DOM
    module.exports = { plural, errorsOf };
    return;
  }

  // ---------- RCI ----------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function rciFetch(path, init) {
    const res = await fetch(`/rci/${path}`, { credentials: 'same-origin', ...init });
    if (res.status === 401) throw new Error('сессия истекла — обновите страницу и войдите заново');
    if (!res.ok) throw new Error(`роутер ответил ${res.status} на /rci/${path}`);
    return res.json();
  }

  const rciPost = (path, body) =>
    rciFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  /**
   * Помощник на роутере через RCI exec: строки его вывода. exec отвечает частями: POST запускает
   * процесс, GET забирает очередной кусок, пока в ответе есть continued.
   */
  async function execHelper(args, cancel = { cancelled: false }) {
    const body = { path: HELPER };
    args.forEach((arg, i) => {
      body[`arg${i + 1}`] = String(arg);
    });
    let reply = await rciPost('exec', body);
    const lines = [];
    for (;;) {
      const errors = errorsOf(reply);
      if (errors.length) throw new Error(`hostsgen-ui на роутере: ${errors.join('; ')} — переустановите модуль`);
      if (Array.isArray(reply.message)) lines.push(...reply.message);
      else if (typeof reply.message === 'string') lines.push(reply.message);
      if (!reply.continued) return lines.map(String);
      if (cancel.cancelled) {
        fetch('/rci/exec', { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
        throw new Error('отменено');
      }
      await sleep(250);
      reply = await rciFetch('exec');
    }
  }

  // ---------- окно ----------

  const STYLE = `
.hg-overlay{position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px}
.hg-dialog{background:var(--background,#1b2434);color:var(--primary-text,#c2c2c2);border:1px solid var(--table-border,#4d545f);border-radius:4px;width:min(760px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;font:14px/22px Roboto,sans-serif;box-shadow:0 8px 32px rgba(0,0,0,.4)}
.hg-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 24px 4px}
.hg-title{margin:0;font-size:22px;line-height:28px;font-weight:700}
.hg-x{background:none;border:0;color:var(--text-gray,#949b9f);font-size:26px;line-height:1;cursor:pointer;padding:4px}
.hg-x:hover{color:var(--primary-color,#0097dc)}
.hg-body{padding:8px 24px 4px;overflow:auto}
.hg-hint{margin:0 0 8px;color:var(--text-gray,#949b9f)}
.hg-text{display:block;width:100%;min-height:150px;resize:vertical;box-sizing:border-box;background:transparent;color:inherit;border:1px solid var(--table-border,#4d545f);border-radius:4px;padding:8px 10px;font:13px/20px ui-monospace,Menlo,Consolas,monospace}
.hg-text:focus,.hg-input:focus,.hg-select:focus{outline:none;border-color:var(--primary-color,#0097dc)}
.hg-text.hg-drop{border-style:dashed;border-color:var(--primary-color,#0097dc)}
.hg-row{display:flex;flex-wrap:wrap;gap:12px 16px;align-items:flex-end;margin-top:12px}
.hg-field{display:flex;flex-direction:column;gap:4px;flex:1;min-width:200px}
.hg-field--narrow{flex:0 0 96px;min-width:96px}
.hg-label{color:var(--text-gray,#949b9f);font-size:12px;line-height:16px}
.hg-input,.hg-select{height:32px;box-sizing:border-box;background:var(--background,#1b2434);color:inherit;border:1px solid var(--table-border,#4d545f);border-radius:4px;padding:0 8px;font:inherit}
.hg-check{display:flex;align-items:center;gap:8px;height:32px;cursor:pointer;white-space:nowrap}
.hg-btn{height:32px;padding:0 16px;border-radius:4px;font:inherit;cursor:pointer;border:1px solid var(--primary-color,#0097dc);background:transparent;color:var(--primary-color,#0097dc)}
.hg-btn--primary{background:var(--primary-color,#0097dc);color:#fff}
.hg-btn:disabled{opacity:.45;cursor:default}
.hg-chip{display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:0 4px 0 10px;border:1px solid var(--table-border,#4d545f);border-radius:14px;font-size:13px}
.hg-chip button{background:none;border:0;color:inherit;cursor:pointer;font-size:16px;padding:0 6px}
.hg-status{min-height:22px;margin-top:10px;color:var(--text-gray,#949b9f)}
.hg-status--error{color:var(--error,#de3d3d)}
.hg-status--ok{color:var(--success,#3bb273)}
.hg-summary{margin:4px 0 8px}
.hg-notes{margin:8px 0 0;padding-left:18px;color:var(--text-gray,#949b9f);font-size:13px}
.hg-tablewrap{max-height:260px;overflow:auto;border:1px solid var(--table-border,#4d545f);border-radius:4px}
.hg-table{width:100%;border-collapse:collapse;font-size:13px;line-height:20px}
.hg-table th,.hg-table td{text-align:left;padding:4px 10px;border-bottom:1px solid var(--table-border,#4d545f);vertical-align:top}
.hg-table th{position:sticky;top:0;background:var(--background,#1b2434);color:var(--text-gray,#949b9f);font-weight:400}
.hg-table tr:last-child td{border-bottom:0}
.hg-net{white-space:nowrap;font-family:ui-monospace,Menlo,Consolas,monospace}
.hg-muted{color:var(--text-gray,#949b9f)}
.hg-steps{list-style:none;margin:4px 0 0;padding:0}
.hg-steps li{display:flex;gap:10px;padding:3px 0}
.hg-steps li::before{content:"•";width:16px;flex:none;text-align:center;color:var(--text-gray,#949b9f)}
.hg-steps li.hg-done::before{content:"✓";color:var(--success,#3bb273)}
.hg-steps li.hg-fail::before{content:"✕";color:var(--error,#de3d3d)}
.hg-steps li.hg-now::before{content:"…";color:var(--primary-color,#0097dc)}
.hg-overlay [hidden]{display:none!important}
.hg-text--short{min-height:84px}
.hg-expert{margin-top:14px}
.hg-expert>summary{width:max-content;cursor:pointer;color:var(--text-gray,#949b9f);font-size:12px;line-height:18px;opacity:.7}
.hg-expert[open]>summary{opacity:1;margin-bottom:8px}
.hg-hint--small{font-size:12px;line-height:18px;margin-top:8px}
.hg-log{margin-top:10px}
.hg-log summary{cursor:pointer;color:var(--text-gray,#949b9f)}
.hg-log pre{max-height:220px;overflow:auto;margin:6px 0 0;padding:8px 10px;border:1px solid var(--table-border,#4d545f);border-radius:4px;font:12px/18px ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
.hg-foot{display:flex;justify-content:flex-end;gap:12px;padding:12px 24px 20px}
@media (max-width:600px){.hg-head,.hg-body,.hg-foot{padding-left:16px;padding-right:16px}.hg-title{font-size:18px}}
`;

  function injectStyle() {
    if (document.getElementById('hostsgen-ui-style')) return;
    const style = document.createElement('style');
    style.id = 'hostsgen-ui-style';
    style.textContent = STYLE;
    document.head.append(style);
  }

  /**
   * Окно поверх страницы с разметкой html. Элементы — по data-role: $('text').
   * canClose — можно ли закрыть по Esc сейчас, onClose — что сделать при закрытии.
   */
  function openOverlay(html, { canClose = () => true, onClose = () => {} } = {}) {
    if (document.querySelector('.hg-overlay')) return null;
    injectStyle();
    const overlay = document.createElement('div');
    overlay.className = 'hg-overlay';
    overlay.innerHTML = html;
    document.body.append(overlay);
    const $ = (role) => overlay.querySelector(`[data-role="${role}"]`);

    // Сервис горячих клавиш KeeneticOS слушает keydown на document в фазе перехвата и, пока считает
    // открытым свой выпадающий список, отменяет любые нажатия — вместе с набором и Cmd+V в наших полях.
    // Поэтому клавиши и буфер обмена из окна останавливаем раньше, на window: до KeeneticOS они
    // не доходят, а ввод и вставка (действие по умолчанию) работают как обычно.
    const ISOLATED = ['keydown', 'keypress', 'keyup', 'paste', 'cut', 'copy'];
    const isolate = (e) => {
      if (e.type === 'keydown' && e.key === 'Escape' && canClose()) {
        e.stopPropagation();
        close();
      } else if (overlay.contains(e.target)) {
        e.stopPropagation();
      }
    };
    const close = () => {
      ISOLATED.forEach((type) => window.removeEventListener(type, isolate, true));
      overlay.remove();
      onClose();
    };
    ISOLATED.forEach((type) => window.addEventListener(type, isolate, true));
    return { overlay, $, close };
  }

  // ---------- кнопки на страницах ----------

  /**
   * Кнопка — копия штатной ndw-button: так она получает стили Angular-компонента без своих CSS.
   * marker — атрибут, по которому повторно не вставляем; icon — имя из спрайта интерфейса.
   */
  function cloneButton(template, { marker, label, icon, title, onClick }) {
    const host = template.cloneNode(true);
    host.setAttribute(marker, '');
    const button = host.querySelector('button');
    if (!button) return null;
    button.disabled = false;
    button.classList.remove('ndw-button--disabled');
    button.title = title;
    const text = host.querySelector('.ndw-button__label');
    if (text) text.textContent = ` ${label}`;
    const use = host.querySelector('use');
    if (use) use.setAttribute('href', `./assets/sprite/sprite.svg#${icon}`);
    button.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return host;
  }

  /** Angular перерисовывает страницы целиком — после каждой перерисовки снова вставляем свои кнопки. */
  function watchPage(inject) {
    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        inject();
      }, 150);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  window.hostsgenUi = { HELPER, plural, errorsOf, sleep, rciFetch, rciPost, execHelper, openOverlay, cloneButton, watchPage };
})();
