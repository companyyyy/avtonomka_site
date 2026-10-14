/**
 * Пропозиції «під замовлення» (scripts/backorder_offers.json) - спільна
 * логіка для generate_static_pages.js і generate_merchant_feed.js, щоб ціна,
 * статус і дата надходження на сторінці, в JSON-LD і у фіді рахувались
 * однаково і не розходились.
 */

const fs   = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'backorder_offers.json');
const TIME_ZONE   = 'Europe/Kyiv';

/* Суфікс файлу сторінки й id у кошику / фіді для варіанта «під замовлення». */
const PAGE_SUFFIX = '-pid-zamovlennya';
const ID_SUFFIX   = '-order';

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return { default_lead_days: 14, by_id: {} };
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.warn(`backorder: не вдалося прочитати ${path.basename(CONFIG_FILE)}: ${e.message}`);
    return { default_lead_days: 14, by_id: {} };
  }
}

/* YYYY-MM-DD у київському часі для дати "сьогодні + days". */
function kyivDate(days, now = new Date()) {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(now);
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* Зсув Києва на конкретну дату (+03:00 влітку, +02:00 взимку). */
function kyivOffset(ymd) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${ymd}T12:00:00Z`))
    .find(part => part.type === 'timeZoneName').value; // "GMT+03:00"
  return name.replace('GMT', '') || '+00:00';
}

const MONTHS_GEN = ['січня', 'лютого', 'березня', 'квітня', 'травня', 'червня',
  'липня', 'серпня', 'вересня', 'жовтня', 'листопада', 'грудня'];

function dateLabelUk(ymd) {
  const [, m, d] = ymd.split('-').map(Number);
  return `${d} ${MONTHS_GEN[m - 1]}`;
}

const config = loadConfig();
const warned = new Set();

function warnOnce(id, msg) {
  if (warned.has(id)) return;
  warned.add(id);
  console.warn(`backorder: товар ${id} - ${msg}, варіант «під замовлення» пропущено`);
}

/**
 * Повертає пропозицію «під замовлення» для товару або null (товар поводиться
 * як раніше). Приклад:
 *   { id: '151777-order', price: 1500, currency: 'UAH', status: 'backorder',
 *     leadDays: 14, date: '2026-10-16', isoDate: '2026-10-16T00:00:00+03:00',
 *     dateLabel: '16 жовтня' }
 */
function getBackorderOffer(p) {
  if (!p || p.virtual) return null;
  const entry = (config.by_id || {})[p.id];
  if (!entry) return null;

  const stockPrice = parseFloat(p.price);
  if (isNaN(stockPrice)) { warnOnce(p.id, 'немає ціни в наявності'); return null; }
  const currency = String(p.price).replace(/[\d.,\s]+/, '').trim() || 'UAH';

  let price;
  if (entry.price != null) price = Number(entry.price);
  else if (entry.discount != null) price = stockPrice - Number(entry.discount);
  if (!(price > 0)) { warnOnce(p.id, 'не задано price/discount'); return null; }
  if (price >= stockPrice) {
    warnOnce(p.id, `ціна під замовлення ${price} не нижча за ціну в наявності ${stockPrice}`);
    return null;
  }

  const status = entry.status === 'preorder' ? 'preorder' : 'backorder';
  const leadDays = Number(entry.lead_days ?? config.default_lead_days ?? 14);
  const date = kyivDate(leadDays);

  return {
    id: `${p.id}${ID_SUFFIX}`,
    price: Math.round(price * 100) / 100,
    currency,
    status,
    leadDays,
    date,
    isoDate: `${date}T00:00:00${kyivOffset(date)}`,
    dateLabel: dateLabelUk(date),
  };
}

module.exports = { getBackorderOffer, PAGE_SUFFIX, ID_SUFFIX };
