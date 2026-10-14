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
 * Місто | Відділення/поштомат НП | Спосіб оплати | Джерело | Ціна за од.
 *
 * "Ціна за од." - ціна з кошика (та, що була на сторінці товару в момент
 * додавання). Для варіанта «під замовлення» це нижча ціна, а сама умова
 * видна в колонці "Товар": «... (під замовлення, очікується до <дата>)».
 *
 * Місто, відділення НП і спосіб оплати заповнюються лише замовленнями з
 * кошика (checkout.html) — швидка заявка через order-form.js та заявки з
 * міні-аппи їх не збирають, там ці колонки лишаються порожні.
 *
 * Якщо аркуш уже існує зі старим (5-, 7- чи 10-колонковим) заголовком —
 * скрипт сам дописує відсутні колонки при першому ж запиті, без нового
 * розгортання. Але якщо ти оновлюєш цей .gs-код у вже розгорнутому проєкті —
 * потрібне нове розгортання (крок 9 вище), інакше зміни коду не застосуються.
 */

const SHEET_NAME = 'Заявки';
const HEADER = ['Дата/час', "Ім'я", 'Телефон', 'Товар', 'Коментар', 'Кількість', '№ замовлення', 'Місто', 'Відділення/поштомат НП', 'Спосіб оплати', 'Джерело', 'Ціна за од.'];

function ensureSheet(ss) {
  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADER);
    sheet.getRange(1, 1, 1, HEADER.length).setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    return sheet;
  }

  /* Аркуш міг бути створений старою версією скрипта (5- чи 10-колонковим
     заголовком, без "Кількість"/"№ замовлення"/"Джерело") — дописуємо
     відсутні заголовки, не чіпаючи вже наявні рядки. */
  const currentCols = sheet.getLastColumn();
  if (currentCols < HEADER.length) {
    sheet.getRange(1, currentCols + 1, 1, HEADER.length - currentCols)
      .setValues([HEADER.slice(currentCols)])
      .setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');
  }

  return sheet;
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

    if (items.length > 0) {
      /* Кошик: один рядок на товар, спільний orderId, щоб бачити,
         які позиції належать одному замовленню. */
      const orderId = Utilities.formatDate(new Date(), 'Europe/Kiev', 'yyyyMMdd-HHmmss');
      items.forEach(function (item) {
        const title = (item && (item.title || item.name)) || '';
        const sku   = (item && item.sku) || '';
        const qty   = (item && item.qty) || 1;
        const price = (item && item.price != null && item.price !== '')
          ? (item.price + ' ' + (item.currency || 'UAH'))
          : '';
        sheet.appendRow([
          timestamp,
          name,
          phone,
          sku ? (title + ' (Арт. ' + sku + ')') : title,
          comment,
          qty,
          orderId,
          city,
          npBranch,
          paymentMethod,
          source,
          price
        ]);
      });
    } else {
      /* Швидка заявка на 1 товар (сайт: order-form.js, або заявка без кошика
         з міні-аппи), без даних доставки. */
      sheet.appendRow([timestamp, name, phone, params.product || '', comment, '', '', '', '', '', source, '']);
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
