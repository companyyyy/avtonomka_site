/**
 * Google Apps Script — прийом заявок з сайту Автономка ТА з міні-аппи в
 * один і той самий аркуш "Заявки" (без прийому оплати онлайн, лише збір
 * заявки: ім'я, телефон, товар, коментар).
 *
 * Приймає два різні формати запиту, бо сайт і міні-апп надсилають дані
 * по-різному:
 * - Сайт (order-form.js, checkout.js) — POST з тілом application/x-www-form-urlencoded,
 *   Apps Script сам розкладає його в e.parameter.
 * - Міні-апп (miniapp/index.html) — POST з сирим JSON у тілі (text/plain,
 *   щоб уникнути CORS-preflight), парситься вручну з e.postData.contents.
 * Обидва боки передають поле "source" ("Сайт" / "Мініапп"), яке просто
 * пишеться в окрему колонку "Джерело".
 *
 * ІНСТРУКЦІЯ (виконати вручну, один раз):
 * 1. Створи нову Google Таблицю (sheets.google.com → Порожній файл).
 * 2. У таблиці: Розширення → Apps Script.
 * 3. Видали весь код-заготовку в редакторі та встав замість нього весь цей файл.
 * 4. Збережи проєкт (Ctrl+S / іконка дискети), дай назву, напр. "Avtonomka Order Form".
 * 5. Натисни синю кнопку "Розгорнути" (Deploy) → "Нове розгортання" (New deployment).
 *    - Тип: "Веб-застосунок" (Web app).
 *    - Опис: будь-який, напр. "order form".
 *    - "Виконати від імені" (Execute as): Я (свій акаунт).
 *    - "Хто має доступ" (Who has access): Усі (Anyone) — обов'язково, інакше
 *      сайт не зможе надсилати дані без авторизації Google.
 * 6. Натисни "Розгорнути" (Deploy). Google попросить надати дозволи —
 *    підтверди (Google може показати попередження "Незнайомий застосунок",
 *    це нормально для власного скрипта: "Додатково" → "Перейти до проєкту (небезпечно)" → "Дозволити").
 * 7. Скопіюй URL веб-застосунку — виглядає як:
 *    https://script.google.com/macros/s/XXXXXXXXXXXXXXXXX/exec
 * 8. Встав цей URL у файл assets/js/order-form.js та assets/js/checkout.js
 *    (константа ORDER_FORM_ENDPOINT) і в miniapp/index.html (CONFIG.ORDERS_URL) —
 *    усі три мають вказувати на ОДИН і той самий URL.
 * 9. Якщо пізніше зміниш код цього скрипта — потрібно створити НОВЕ
 *    розгортання (Manage deployments → Edit (олівець) → New version → Deploy),
 *    інакше зміни не застосуються до вже виданого URL.
 *
 * Результат: кожна заявка (з сайту чи з міні-аппи) додається рядком (для
 * кошика — по рядку на товар зі спільним "№ замовлення") на аркуш "Заявки"
 * цієї ж таблиці:
 * Дата/час | Ім'я | Телефон | Товар | Коментар | Кількість | № замовлення |
 * Місто | Відділення/поштомат НП | Спосіб оплати | Джерело | Ціна за од. | Сума
 *
 * Значення пишуться в колонки ЗА НАЗВОЮ заголовка, тож чужі колонки
 * (status, assigned_to, assigned_at від бота) не зсуваються й не
 * перезаписуються. "Ціна за од." і "Сума" (ціна × кількість, грн) -
 * числа, їх можна сумувати у таблиці. "Ціна за од." - ціна з кошика (та, що була на сторінці товару в момент
 * додавання). Для варіанта «під замовлення» це нижча ціна, а сама умова
 * видна в колонці "Товар": «... (під замовлення, очікується до <дата>)».
 *
 * Місто, відділення НП і спосіб оплати заповнюються лише замовленнями з
 * кошика (checkout.html) — швидка заявка через order-form.js та заявки з
 * міні-аппи їх не збирають, там ці колонки лишаються порожні.
 *
 * Якщо в аркуші бракує якихось заголовків — скрипт сам дописує їх
 * у кінець при першому ж запиті, без нового
 * розгортання. Але якщо ти оновлюєш цей .gs-код у вже розгорнутому проєкті —
 * потрібне нове розгортання (крок 9 вище), інакше зміни коду не застосуються.
 */

const SHEET_NAME = 'Заявки';
const HEADER = ['Дата/час', "Ім'я", 'Телефон', 'Товар', 'Коментар', 'Кількість', '№ замовлення', 'Місто', 'Відділення/поштомат НП', 'Спосіб оплати', 'Джерело', 'Ціна за од.', 'Сума'];

function styleHeader(range) {
  range.setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');
}

function ensureSheet(ss) {
  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADER);
    styleHeader(sheet.getRange(1, 1, 1, HEADER.length));
    sheet.setFrozenRows(1);
    return sheet;
  }

  /* Аркуш міг бути створений старою версією скрипта, а праворуч інші
     інструменти (бот менеджерів) дописують свої колонки (status,
     assigned_to, ...). Тому відсутні заголовки дописуємо В КІНЕЦЬ, не
     чіпаючи наявні колонки й рядки. */
  const lastCol = sheet.getLastColumn();
  const existing = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  const missing = HEADER.filter(function (h) { return existing.indexOf(h) === -1; });
  if (missing.length) {
    styleHeader(sheet.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]));
  }

  return sheet;
}

/* Дописує рядок, розкладаючи значення по колонках за назвою заголовка
   (а не за порядком) - чужі колонки лишаються порожні. */
function appendByHeader(sheet, values) {
  const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(String);
  sheet.appendRow(header.map(function (h) {
    return Object.prototype.hasOwnProperty.call(values, h) ? values[h] : '';
  }));
}

function toNumber(value) {
  const n = Number(String(value == null ? '' : value).replace(/[^\d.,-]/g, '').replace(',', '.'));
  return isFinite(n) ? n : 0;
}

/* Тіло запиту буває двох форматів:
   - form-urlencoded (сайт) — Apps Script сам заповнює e.parameter, підходить одразу.
   - сирий JSON-текст (міні-апп, Content-Type: text/plain) — e.parameter порожній,
     треба вручну JSON.parse(e.postData.contents). */
function parseRequestData(e) {
  const params = (e && e.parameter) || {};
  if (Object.keys(params).length > 0) return params;

  const raw = e && e.postData && e.postData.contents;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (parseErr) {
    return {};
  }
}

function doPost(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ensureSheet(ss);

    const params = parseRequestData(e);
    const timestamp = Utilities.formatDate(new Date(), 'Europe/Kiev', 'dd.MM.yyyy HH:mm:ss');
    const name          = params.name          || '';
    const phone         = params.phone         || '';
    const comment       = params.comment       || '';
    const city          = params.city          || '';
    const npBranch      = params.npBranch      || '';
    const paymentMethod = params.paymentMethod || '';
    const source        = params.source        || 'Сайт';

    /* Сайт передає items як JSON-рядок (усередині form-urlencoded тіла),
       міні-апп — як уже готовий масив (усередині JSON-тіла). Приймаємо обидва. */
    let items = params.items;
    if (typeof items === 'string') {
      try { items = JSON.parse(items); } catch (parseErr) { items = []; }
    }
    if (!Array.isArray(items)) items = [];

    const base = {
      'Дата/час': timestamp,
      "Ім'я": name,
      'Телефон': phone,
      'Коментар': comment,
      'Місто': city,
      'Відділення/поштомат НП': npBranch,
      'Спосіб оплати': paymentMethod,
      'Джерело': source
    };

    if (items.length > 0) {
      /* Кошик: один рядок на товар, спільний orderId, щоб бачити,
         які позиції належать одному замовленню. */
      const orderId = Utilities.formatDate(new Date(), 'Europe/Kiev', 'yyyyMMdd-HHmmss');
      items.forEach(function (item) {
        const title = (item && (item.title || item.name)) || '';
        const sku   = (item && item.sku) || '';
        const qty   = toNumber(item && item.qty) || 1;
        const price = (item && item.price != null && item.price !== '') ? toNumber(item.price) : '';
        appendByHeader(sheet, Object.assign({}, base, {
          'Товар': sku ? (title + ' (Арт. ' + sku + ')') : title,
          'Кількість': qty,
          '№ замовлення': orderId,
          'Ціна за од.': price,
          'Сума': price === '' ? '' : price * qty
        }));
      });
    } else {
      /* Швидка заявка на 1 товар (сайт: order-form.js, або заявка без кошика
         з міні-аппи), без даних доставки. */
      appendByHeader(sheet, Object.assign({}, base, { 'Товар': params.product || '' }));
    }

    return ContentService
      .createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
