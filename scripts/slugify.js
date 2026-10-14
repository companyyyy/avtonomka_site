/**
 * Shared slug generator for product URLs: /product/{slug}/{id}.html
 *
 * Slugs are meant to be computed ONCE per product id and then persisted in
 * products.json ("slug" field) — see fetch_feed.py's sticky carry-forward
 * for description/link/specs, which slug generation follows the same
 * pattern for. Nothing here should be called at request time; it's a
 * build-time helper only.
 *
 * Core-name extraction mirrors miniapp_v/index.html's stripTypePrefix() /
 * kitShortName() / kitPartShort() — same idea, same regexes, ported here so
 * slugs read as "brand + model (+ 2nd component for kits)" instead of the
 * full sentence-like product title (which repeats voltage/capacity/weight
 * that don't belong in a URL).
 */

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh',
  з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', "'": '',
  ё: 'e', э: 'e', ы: 'y', ъ: '',
};

const TYPE_PREFIXES = [
  /^Комплект силових кабелів\s*/i,
  /^Сонячний кабель\s*/i,
  /^Гібридний інвертор\s*/i,
  /^Акумуляторна батарея\s*/i,
  /^Акумулятор\s*/i,
  /^Зарядна станція\s*/i,
  /^Безперебійник(?:\s+для\s+\S+)?\s*/i,
];

// Same as miniapp_v/index.html's KIT_UNIT_CUT_RE / WIFI_RE.
const UNIT_CUT_RE = /\d+(?:[.,]\d+)?\s*(?:кВт|kW|kw|Вт|фаза|V|В|Ah|Аh|ah)(?![A-Za-zА-Яа-яІіЇїЄєҐґ])/i;
const WIFI_RE = /\bWi-?Fi\b/i;

function stripTypePrefix(name) {
  for (const re of TYPE_PREFIXES) {
    const stripped = name.replace(re, '');
    if (stripped !== name) return stripped.trim();
  }
  return name;
}

function partShort(segment) {
  // A cut at position 0 would leave nothing (e.g. "Wi-Fi-модуль для ...") -
  // only cut a tail that follows a real name.
  const cuts = [];
  const m1 = segment.match(UNIT_CUT_RE);
  if (m1 && m1.index > 0) cuts.push(m1.index);
  const m2 = segment.match(WIFI_RE);
  if (m2 && m2.index > 0) cuts.push(m2.index);
  const s = cuts.length ? segment.slice(0, Math.min(...cuts)) : segment;
  return s.trim().replace(/[,+]+$/, '').trim();
}

/* "Комплект автономного енергоживлення: X + Y" -> "X Y" (short codes only). */
function kitCoreName(title) {
  const body = title.replace(/^Комплект автономного енергоживлення:\s*/i, '');
  const parts = body.split(/\s*\+\s*/);
  if (parts.length !== 2) return partShort(body);
  return partShort(parts[0]) + ' ' + partShort(parts[1]);
}

function coreName(title) {
  if (/^Комплект автономного енергоживлення/i.test(title)) return kitCoreName(title);
  return partShort(stripTypePrefix(title));
}

function transliterate(str) {
  let out = '';
  for (const ch of str) {
    const lower = ch.toLowerCase();
    out += Object.prototype.hasOwnProperty.call(TRANSLIT, lower) ? TRANSLIT[lower] : ch;
  }
  return out;
}

/* Truncate on a '-' boundary so we never cut a word in half. */
function truncateSlug(slug, maxLen) {
  if (slug.length <= maxLen) return slug;
  let cut = slug.slice(0, maxLen);
  if (cut.includes('-')) cut = cut.slice(0, cut.lastIndexOf('-'));
  return cut;
}

function slugify(title, maxLen = 65) {
  const name = coreName(title || '');
  const translit = transliterate(name).toLowerCase();
  let slug = translit.replace(/[^a-z0-9]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return truncateSlug(slug, maxLen);
}

module.exports = { slugify };
