/**
 * Прибирає з назви товару габарити (700х430х253) і вагу (71 кг).
 * Ті самі правила, що й scripts/clean_title.py (products.json з фіду
 * постачальника); тут - для віртуальних товарів з Supabase, яких
 * fetch_feed.py не торкається. ⚠ Копія є в assets/js/product.js
 * (браузер) - міняти всі три разом.
 */

const NUM = String.raw`\d+(?:\.\d+)?`;
const TOKEN = new RegExp(
  String.raw`\s*,?\s*(?<![\p{L}\d.])(?:${NUM}\s*[xхX×]\s*${NUM}\s*[xхX×]\s*${NUM}(?:\s*мм)?|${NUM}\s*(?:кг|kg)(?![\p{L}\d_]))`,
  'giu'
);

function cleanTitle(title) {
  return String(title || '')
    .replace(TOKEN, '')
    .replace(/\s*,\s*(?=,|$)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s,]+|[\s,]+$/g, '');
}

module.exports = { cleanTitle };
