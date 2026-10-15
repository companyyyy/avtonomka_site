"""
Generates the Prom.ua import feeds (Price.ua format, RU + UA) for reseller
clients: the main prom_file.xml (Ultradomik) plus the extra feeds listed in
data/ultradomik/feeds.json, edited in /prom-admin/. Served at https://avtonomka.com.ua/<file> - each
client's Prom cabinet pulls its own file by link. An extra feed's price is
either +/- percent from the main feed price (invertorshop.xml - ІнверторШоп,
+35%) or, when it has add_min/add_max, the table price (+/- percent) plus a
fresh random add_min..add_max UAH per item (feed/enerhiia24.xml - Енергія24,
+1..200 UAH).
An extra feed with "base": "wholesale" is counted from the wholesale price
instead (no 1-10 UAH bump; items without a wholesale price are left out).
feed/opt.xml is the wholesale feed: the wholesale price is set by hand in
/prom-admin/ in US dollars (prices.json -> wholesale_usd, never touched by the
site sync) and turned into UAH at the rate set there (feeds.json -> usd_rate,
45 by default); an item whose wholesale price is 0 or empty is left out of it.

Prices (UAH) and stock come from data/ultradomik/prices.json, keyed by item
id. "off": true there (the «В наявності» checkbox in /prom-admin/, never touched
by the site sync) marks the item as not available in every feed, whatever the
site says; otherwise a site item is available when the site has it in stock and
a feed-only item (no site card) is available. The scheduled site update fills it with site prices
(scripts/sync_ultradomik_prices.py); a manual edit in the price table at
https://avtonomka.com.ua/prom-admin/ wins until the next scheduled update.
Texts (UA + RU), specs and search queries come from
data/ultradomik/products.json; photos are the supplier's
white-background copies from products.json -> prom_images (plus a photo taken
from the sheet in assets/images/ultradomik/<id>.jpg, if any), re-checked here.
An entry with "feed_only": true has no product card on the site - its id is
our own and its photo comes only from assets/images/ultradomik/.
Every other product on the site (products.json) goes into the feeds too, with
texts built from the site card (auto_entries): name, description paragraphs and
the specs table, category by product_type, photos = white-background copies of
any of its pictures. The site has these texts in Ukrainian only, so such items
carry no Russian description/keywords (RU keywords only if the site has them);
<name> holds the Ukrainian title, since Prom needs the tag. A kit
("Комплект ...: <inverter> + <battery>") with no white-background photo gets one
composed from its parts' white-background photos (assets/images/feed-auto/).
An item with no price or no white-background photo is left out and listed in
the report. The list of items for the price table (name, category, photo,
whether it made it into the feed) is written to data/ultradomik/feed_items.json.

Run: python scripts/generate_ultradomik_feed.py
"""

import json
import random
import re
import sys
from html import unescape
from pathlib import Path
from xml.etree import ElementTree

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SITE_URL = 'https://avtonomka.com.ua'
# One build, several files: the same items, texts, photos and categories,
# only the price differs. Every build adds a fresh random 1-10 UAH to each
# item's price (prom_file.xml price); the extra percent feeds take their percent
# from that already-bumped price, a random-range feed adds its own range instead.
RANDOM_ADD_UAH = (1, 10)
MAIN_FEED = 'prom_file.xml'                        # Ultradomik
OPT_FEED = 'feed/opt.xml'                          # гурт, ціни вручну
FEEDS_CONFIG = ROOT / 'data/ultradomik/feeds.json'  # extra feeds, from /prom-admin/
# Files this script wrote last time - a feed removed in the admin gets its
# file deleted, and nothing else (feed/bezpeka.xml etc.) is ever touched.
FEEDS_BUILT = ROOT / 'data/ultradomik/feeds_built.json'
FEED_FILE_RE = re.compile(r'^(?:feed/)?[a-z0-9][a-z0-9-]{0,60}\.xml$')
RESERVED_FILES = {MAIN_FEED, OPT_FEED, 'prom.xml', 'feed.xml', 'sitemap.xml', 'feed/bezpeka.xml'}


ADD_LIMIT = 100000  # UAH, bound for add_min/add_max
USD_RATE_DEFAULT = 45  # UAH per $1 for wholesale prices, until set in /prom-admin/


def usd_rate():
    try:
        rate = json.loads(FEEDS_CONFIG.read_text('utf-8')).get('usd_rate')
    except FileNotFoundError:
        rate = None
    return rate if isinstance(rate, (int, float)) and 1 <= rate <= 1000 else USD_RATE_DEFAULT


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def load_feeds():
    """[dict(file, name, mult, add)] - the main feed first, then valid extras.
    add = (min, max) UAH for a random-range feed, None for a plain percent one."""
    try:
        config = json.loads(FEEDS_CONFIG.read_text('utf-8'))
    except FileNotFoundError:
        config = {}
    feeds = [dict(file=MAIN_FEED, name='Роздрібні ціни', mult=1.0, add=None),
             dict(file=OPT_FEED, name='Гурт', mult=1.0, add=None, wholesale=True)]
    seen = {MAIN_FEED, OPT_FEED}
    for f in config.get('feeds', []):
        fname, pct = str(f.get('file', '')), f.get('percent', 0)
        lo, hi = f.get('add_min'), f.get('add_max')
        ranged = lo is not None or hi is not None
        if (not FEED_FILE_RE.match(fname) or fname in seen or fname in RESERVED_FILES
                or not is_num(pct) or not -90 <= pct <= 500
                or (ranged and not (is_num(lo) and is_num(hi) and -ADD_LIMIT <= lo <= hi <= ADD_LIMIT))):
            print(f'feeds.json: skipped invalid feed {f!r}')
            continue
        seen.add(fname)
        feeds.append(dict(file=fname, name=str(f.get('name') or fname), mult=1 + pct / 100,
                          add=(int(lo), int(hi)) if ranged else None,
                          from_wholesale=f.get('base') == 'wholesale'))
    return feeds

# Group ids are fixed so a group keeps its identity in the client's Prom
# cabinet across imports - never renumber, only append. portal = Prom
# marketplace category. Prom locked its old categories (everything listed in
# «Категорії без можливості редагування.xlsx» - inverters, batteries, UPS,
# cables...): an item sent there is flagged «Автоматично вказана категорія».
# Only ids from Prom.ua_categories_30_09_2026.xls that are NOT in that file are
# used - for this range that is the new «Автономна енергетика» section and
# «Зарядні станції».
AUTONOMOUS_ENERGY = 501001  # Техніка та електроніка > Автономна енергетика > Автономна енергетика, загальне
CATEGORIES = {
    1: ('Гібридні інвертори', AUTONOMOUS_ENERGY),
    2: ('Акумулятори', AUTONOMOUS_ENERGY),
    3: ('Системи зберігання електроенергії 2 в 1', AUTONOMOUS_ENERGY),
    4: ('Кабельна продукція', AUTONOMOUS_ENERGY),
    5: ('Зарядні станції', 500901),
    6: ('Безперебійники для роутерів', AUTONOMOUS_ENERGY),
    7: ('Автоматичне введення резерву (АВР)', AUTONOMOUS_ENERGY),
    8: ('Реле напруги', 14190901),
    9: ('Таймери', 620),
    10: ('Лічильники електроенергії', 15370308),
    11: ('Комплекти автономного енергоживлення', AUTONOMOUS_ENERGY),
    12: ('Wi-Fi модулі для інверторів', AUTONOMOUS_ENERGY),
    13: ('Інше обладнання для автономного живлення', AUTONOMOUS_ENERGY),
}

# Site product_type -> feed category, for items built from the site card.
SITE_CATEGORY = [
    ('Комплекти', 11),
    ('Wi-Fi', 12),
    ('2 в 1', 3),
    ('Акумулятори', 2),
    ('інвертори', 1),
    ('кабелі', 4),
    ('безперебійного', 6),
    ('АВР', 7),
    ('Реле напруги', 8),
    ('Таймери', 9),
    ('Лічильники', 10),
    ('Зарядні станції', 5),
]

USAGE = {
    1: (['резервне живлення будинку, квартири або офісу', 'сонячні електростанції',
         'системи накопичення електроенергії', 'автономні та гібридні системи живлення'],
        ['резервное питание дома, квартиры или офиса', 'солнечные электростанции',
         'системы накопления электроэнергии', 'автономные и гибридные системы питания']),
    2: (['резервне живлення будинку або квартири', 'автономне електроживлення',
         'робота з гібридним інвертором', 'накопичення енергії від сонячних панелей'],
        ['резервное питание дома или квартиры', 'автономное электропитание',
         'работа с гибридным инвертором', 'накопление энергии от солнечных панелей']),
    3: (['резервне живлення будинку або квартири', 'живлення офісу чи магазину під час відключень',
         'робота разом із сонячними панелями'],
        ['резервное питание дома или квартиры', 'питание офиса или магазина во время отключений',
         'работа вместе с солнечными панелями']),
    4: (['монтаж сонячних електростанцій', 'системи автономного та резервного живлення',
         'з\'єднання обладнання енергосистеми'],
        ['монтаж солнечных электростанций', 'системы автономного и резервного питания',
         'соединение оборудования энергосистемы']),
    5: (['резервне живлення техніки під час відключень', 'дача, подорожі, робота на виїзді',
         'живлення роутера, ноутбука, холодильника'],
        ['резервное питание техники во время отключений', 'дача, путешествия, работа на выезде',
         'питание роутера, ноутбука, холодильника']),
    6: (['живлення роутера та ONU під час відключень', 'живлення камер відеоспостереження',
         'резервне живлення мережевого обладнання'],
        ['питание роутера и ONU во время отключений', 'питание камер видеонаблюдения',
         'резервное питание сетевого оборудования']),
    7: (['автоматичне перемикання між мережею та генератором', 'резервне живлення будинку, котеджу чи офісу',
         'електрощити з резервним джерелом живлення'],
        ['автоматическое переключение между сетью и генератором', 'резервное питание дома, коттеджа или офиса',
         'электрощиты с резервным источником питания']),
    8: (['захист побутової техніки від стрибків напруги', 'захист котла, холодильника, телевізора',
         'живлення техніки від мережі з нестабільною напругою'],
        ['защита бытовой техники от скачков напряжения', 'защита котла, холодильника, телевизора',
         'питание техники от сети с нестабильным напряжением']),
    9: (['увімкнення та вимкнення техніки за розкладом', 'освітлення, обігрівачі, бойлер, полив',
         'економія електроенергії'],
        ['включение и выключение техники по расписанию', 'освещение, обогреватели, бойлер, полив',
         'экономия электроэнергии']),
    11: (['резервне живлення будинку, квартири, дачі чи офісу', 'автономна система живлення під ключ',
          'робота разом із сонячними панелями'],
         ['резервное питание дома, квартиры, дачи или офиса', 'автономная система питания под ключ',
          'работа вместе с солнечными панелями']),
    12: (['віддалений контроль роботи інвертора зі смартфона', 'моніторинг сонячної електростанції'],
         ['удаленный контроль работы инвертора со смартфона', 'мониторинг солнечной электростанции']),
    13: (['системи резервного та автономного живлення'],
         ['системы резервного и автономного питания']),
    10: (['контроль споживання електроенергії побутовою технікою', 'підбір інвертора чи зарядної станції під навантаження',
          'економія електроенергії'],
         ['контроль потребления электроэнергии бытовой техникой', 'подбор инвертора или зарядной станции под нагрузку',
          'экономия электроэнергии']),
}

# Prom only keeps a vendor that exists in its manufacturer base; an unknown
# one is flagged as an import error, so those are simply not sent.
PROM_VENDORS = {'MUST', 'Felicity', 'Deye', 'Dyness', 'EcoFlow', 'KBE'}

FORBIDDEN = re.compile(r'dfi|дфі|дфи', re.I)


def cable_kit(entry, pid, lug):
    """Texts for one lug-size variant of a 25 mm² power cable kit."""
    lu, lr = entry['len_ua'], entry['len_ru']
    return {
        'name_ua': f'Комплект силових кабелів 25 мм² {lu}, 2 шт., мідь, мідні наконечники {lug}',
        'name_ru': f'Комплект силовых кабелей 25 мм² {lr}, 2 шт., медь, медные наконечники {lug}',
        'p_ua': [
            'Комплект силових кабелів 25 мм² для підключення акумуляторних батарей до інвертора '
            'та іншого силового обладнання в системах автономного й резервного живлення.',
            f'У комплекті 2 мідні кабелі довжиною по {lu}. На кінцях встановлені мідні наконечники {lug}, '
            'тому кабелі готові до підключення до відповідних клем без додаткового обтискання.',
        ],
        'p_ru': [
            'Комплект силовых кабелей 25 мм² для подключения аккумуляторных батарей к инвертору '
            'и другому силовому оборудованию в системах автономного и резервного питания.',
            f'В комплекте 2 медных кабеля длиной по {lr}. На концах установлены медные наконечники {lug}, '
            'поэтому кабели готовы к подключению к соответствующим клеммам без дополнительной опрессовки.',
        ],
        'specs': [['Переріз', 'Сечение', '25 мм²'], ['Довжина', 'Длина', lu, lr],
                  ['Кількість', 'Количество', '2 шт.'], ['Матеріал', 'Материал', 'Мідь', 'Медь'],
                  ['Наконечники', 'Наконечники', f'Мідні {lug}', f'Медные {lug}']],
        'kw_ua': f'комплект силових кабелів 25 мм, силовий кабель {lu}, кабель для акумулятора, '
                 f'кабель для інвертора, мідний кабель 25 мм2, кабель з наконечниками {lug}, перемички для АКБ',
        'kw_ru': f'комплект силовых кабелей 25 мм, силовой кабель {lr}, кабель для аккумулятора, '
                 f'кабель для инвертора, медный кабель 25 мм2, кабель с наконечниками {lug}, перемычки для АКБ',
        'vendor': '', 'code': '',
    }


def scrub(s):
    """Text from the site card without the forbidden substring (see FORBIDDEN)."""
    s = FORBIDDEN.sub('', str(s or ''))
    s = re.sub(r'\(\s*\)', '', s)
    return re.sub(r'\s{2,}', ' ', re.sub(r'\s+([,.;:])', r'\1', s)).strip(' ,;-–')


def site_specs(html):
    """[[name, name, value]] rows of the site specs table (section headers skipped)."""
    rows = []
    for row in re.findall(r'<tr>(.*?)</tr>', html or '', re.S):
        cells = [re.sub(r'<[^>]+>', ' ', c) for c in re.findall(r'<td[^>]*>(.*?)</td>', row, re.S)]
        cells = [scrub(re.sub(r'\s+', ' ', unescape(c))) for c in cells]
        if len(cells) == 2 and cells[0] and cells[1]:
            rows.append([cells[0], cells[0], cells[1]])
    return rows


def auto_entries(products, known):
    """Feed entries for site products missing from data/ultradomik/products.json."""
    out = []
    for pid, p in products.items():
        if pid in known or not p.get('title'):
            continue
        ptype = p.get('product_type') or ''
        cat = next((c for key, c in SITE_CATEGORY if key.lower() in ptype.lower()), 13)
        title = scrub(p['title'])
        paras = [scrub(x) for x in (p.get('description') or '').split('\n')]
        paras = [x for x in paras if x] or [title]
        specs = site_specs(p.get('specs'))
        maker = next((v for n, _, v in specs if n.lower() == 'виробник'), '')
        vendor = next((v for v in PROM_VENDORS
                       if v.lower() in (maker.lower(), (title.split() or [''])[0].lower())), '')
        kw_ua = scrub(p.get('merchant_keywords_uk')) or title
        out.append({
            'sheet': title, 'ids': [pid], 'cat': cat, 'auto': True,
            'name_ua': title, 'name_ru': '', 'p_ua': paras, 'p_ru': [],
            'specs': specs, 'kw_ua': kw_ua, 'kw_ru': scrub(p.get('merchant_keywords_ru')),
            'vendor': vendor, 'code': re.sub(r'[^0-9A-Za-zА-Яа-яІіЇїЄєҐґ\-_./ ]', '', scrub(p.get('mpn'))),
        })
    return out


KIT_PHOTOS = ROOT / 'assets/images/feed-auto'
_white = {}


def is_white(img):
    if img not in _white:
        path = ROOT / img
        _white[img] = bool(img) and not FORBIDDEN.search(img) and path.is_file() and white_ratio(path) >= 0.95
    return _white[img]


def model_tokens(text):
    """Model codes in a kit part ("MUST PV19-6048EXP 48V 6 kW" -> ["PV19-6048EXP"]), not capacities."""
    return [t for t in re.findall(r'[A-Za-z0-9][A-Za-z0-9-]{3,}', text)
            if re.search(r'\d', t) and re.search(r'[A-Za-z]', t)
            and not re.fullmatch(r'\d+(?:[.,]\d+)?(?:ah|kwh|kw|wh|w|v)', t, re.I) and t.lower() != 'lifepo4']


def kit_photo(pid, p, products):
    """White-background photo of a kit composed from its parts' photos, or None."""
    out = KIT_PHOTOS / f'{pid}.jpg'
    rel = f'assets/images/feed-auto/{pid}.jpg'
    if out.exists():
        return rel
    norm = lambda s: re.sub(r'[^0-9a-z]', '', (s or '').lower())
    parts = [x for x in p['title'].split(':', 1)[-1].split('+') if x.strip()]
    others = [o for o in products.values() if 'Комплект' not in (o.get('product_type') or '')]
    photos = []
    for part in parts:
        found = None
        for tok in sorted(model_tokens(part), key=len, reverse=True):
            match = [o for o in others if norm(tok) == norm(o.get('mpn')) or norm(tok) in norm(o['title'])]
            for o in match:
                sheet = [f'assets/images/ultradomik/{f.name}'
                         for f in sorted((ROOT / 'assets/images/ultradomik').glob(f'{o["id"]}.*'))]
                found = next((i for i in [*sheet, *(o.get('prom_images') or []), o.get('image_link') or '',
                                          *(o.get('additional_images') or [])] if is_white(i)), None)
                if found:
                    break
            if found:
                break
        if not found:
            return None
        photos.append(found)
    if len(photos) < 2:
        return None
    size, pad = 1200, 60
    canvas = Image.new('RGB', (size, size), 'white')
    box = ((size - pad * (len(photos) + 1)) // len(photos), size - 2 * pad)
    for i, img in enumerate(photos):
        im = Image.open(ROOT / img).convert('RGB')
        # Crop the white margin so the devices fill the frame.
        bbox = Image.eval(im.convert('L'), lambda v: 255 if v < 240 else 0).getbbox()
        if bbox:
            im = im.crop(bbox)
        im.thumbnail(box)
        x = pad + i * (box[0] + pad) + (box[0] - im.width) // 2
        canvas.paste(im, (x, (size - im.height) // 2))
    KIT_PHOTOS.mkdir(parents=True, exist_ok=True)
    canvas.save(out, quality=88)
    return rel


def white_ratio(path):
    """Share of near-white (R,G,B >= 240) pixels in a ~2.5% border strip."""
    im = Image.open(path).convert('RGB')
    w, h = im.size
    bx, by = max(1, int(w * 0.025)), max(1, int(h * 0.025))
    px = im.load()
    total = ok = 0
    for y in range(h):
        xs = range(w) if (y < by or y >= h - by) else [*range(bx), *range(w - bx, w)]
        for x in xs:
            r, g, b = px[x, y]
            total += 1
            ok += r >= 240 and g >= 240 and b >= 240
    return ok / total if total else 0


def esc(s):
    return (str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
            .replace('"', '&quot;').replace("'", '&apos;'))


def clean(s):
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', str(s))


def cdata(s):
    return '<![CDATA[' + str(s).replace(']]>', ']]]]><![CDATA[>') + ']]>'


def description(paras, usage, specs, lang):
    head_use, head_specs = (('Де використовується', 'Основні характеристики') if lang == 'ua'
                            else ('Где используется', 'Основные характеристики'))
    # Site texts have "• ..." lines - those become a list.
    html, bullets = '', []
    for p in paras + ['']:
        if p.startswith('•'):
            bullets.append(p.lstrip('• ').strip())
            continue
        if bullets:
            html += '<ul>' + ''.join(f'<li>{esc(b)}</li>' for b in bullets) + '</ul>'
            bullets = []
        if p:
            html += f'<p>{esc(p)}</p>'
    if usage:
        html += f'<p><strong>{head_use}:</strong></p><ul>' + ''.join(f'<li>{esc(u)}</li>' for u in usage) + '</ul>'
    if specs:
        html += f'<p><strong>{head_specs}:</strong></p><ul>'
        html += ''.join(f'<li>{esc(n)}: {esc(v)}</li>' for n, v in specs) + '</ul>'
    return html


def spec_pairs(specs, lang):
    out = []
    for s in specs:
        name = s[0] if lang == 'ua' else s[1]
        value = s[2] if (lang == 'ua' or len(s) < 4) else s[3]
        out.append((name, value))
    return out


def cap_keywords(s):
    out, length = [], 0
    for k in (x.strip() for x in s.split(',')):
        if not k:
            continue
        add = len(k) + (2 if out else 0)
        if length + add > 1024:
            break
        out.append(k)
        length += add
    return ', '.join(out)


def main():
    products = {p['id']: p for p in json.loads((ROOT / 'products.json').read_text('utf-8'))}
    entries = json.loads((ROOT / 'data/ultradomik/products.json').read_text('utf-8'))
    prices = json.loads((ROOT / 'data/ultradomik/prices.json').read_text('utf-8'))

    report = {'no_data': [], 'no_price': [], 'no_photo': [], 'rejected_photos': []}
    items, used_cats, admin_items = [], set(), []
    rate = usd_rate()
    known = {pid for e in entries for pid in e['ids']}
    auto = auto_entries(products, known)
    if auto:
        print(f'{len(auto)} site products not in data/ultradomik/products.json - built from the site card')

    for entry in entries + auto:
        for pid in entry['ids']:
            # feed_only: sold through the feed only, no product card on the site
            p = products.get(pid) or ({'id': pid, 'title': ''} if entry.get('feed_only') else None)
            if not p:
                report['no_data'].append(f'{entry["sheet"]} (товару {pid} немає в products.json)')
                admin_items.append({'id': pid, 'name': entry['sheet'], 'cat': entry['cat'],
                                    'photo': '', 'problem': 'немає товару на сайті'})
                continue
            if entry.get('cable_kit'):
                lug = 'М10' if re.search(r'М10|M10', p['title']) else 'М8'
                e = {**entry, **cable_kit(entry, pid, lug)}
            else:
                e = entry
            variant = entry.get('variants', {}).get(pid, {})

            def t(s, lang):
                return s.replace('{color}', variant.get(lang, '')) if variant else s

            # Photo taken from the price sheet itself (flattened on white) goes
            # first; then the supplier's white-background copies.
            sheet_photos = [f'assets/images/ultradomik/{f.name}'
                            for f in sorted((ROOT / 'assets/images/ultradomik').glob(f'{pid}.*'))]
            images, rejected = [], 0
            candidates = sheet_photos + list(p.get('prom_images') or [])
            if entry.get('auto'):
                # Any site picture of the item may pass the white-background check.
                candidates += [p.get('image_link') or ''] + list(p.get('additional_images') or [])
            for img in dict.fromkeys(c for c in candidates if c):
                path = ROOT / img
                if FORBIDDEN.search(img) or not path.exists() or white_ratio(path) < 0.95:
                    rejected += 1
                    continue
                images.append(f'{SITE_URL}/{img}')
            if not images and entry.get('auto') and entry['cat'] == 11:
                composed = kit_photo(pid, p, products)
                if composed and is_white(composed):
                    images.append(f'{SITE_URL}/{composed}')
            if rejected:
                report['rejected_photos'].append(f'{pid} {t(e["name_ua"], "ua")}: {rejected}')
            admin_item = {'id': pid, 'name': t(e['name_ua'], 'ua'), 'cat': entry['cat'],
                          'photo': images[0][len(SITE_URL) + 1:] if images else '', 'problem': '',
                          'site': pid in products}
            admin_items.append(admin_item)
            if not images:
                report['no_photo'].append(f'{pid} {t(e["name_ua"], "ua")}')
                admin_item['problem'] = 'немає фото на білому фоні'
                continue
            price = prices.get(pid, {})
            price_uah = price.get('price')
            if not price_uah or price_uah <= 0:
                report['no_price'].append(f'{pid} {t(e["name_ua"], "ua")}')
                continue

            # Switched off in /prom-admin/ -> not available anywhere; the site's
            # stock counts only for items that have a site card.
            available = not price.get('off') and (price.get('in_stock') or pid not in products)

            cat = entry['cat']
            used_cats.add(cat)
            specs_ua = [(t(n, 'ua'), t(v, 'ua')) for n, v in spec_pairs(e['specs'], 'ua')]
            specs_ru = [(t(n, 'ru'), t(v, 'ru')) for n, v in spec_pairs(e['specs'], 'ru')]
            # A site card text already says where the item is used.
            usage_ua = [] if entry.get('auto') and len(e['p_ua']) > 1 else USAGE[cat][0]
            desc_ua = description([t(x, 'ua') for x in e['p_ua']], usage_ua, specs_ua, 'ua')
            # Built from the site card: no Russian text - RU description is left out.
            desc_ru = description([t(x, 'ru') for x in e['p_ru']], USAGE[cat][1], specs_ru, 'ru') if e['p_ru'] else ''
            vendor = e.get('vendor', '')
            code = (e.get('code') or '')[:25]

            lines = [
                f'    <item id="{esc(pid)}" selling_type="r">',
                f'      <name>{esc(t(e["name_ru"] or e["name_ua"], "ru"))}</name>',
                f'      <name_ua>{esc(t(e["name_ua"], "ua"))}</name_ua>',
                f'      <categoryId>{cat}</categoryId>',
                f'      <portal_category_id>{e.get("portal") or CATEGORIES[cat][1]}</portal_category_id>',
                '      <priceuah>{price}</priceuah>',
                f'      <available>{"true" if available else "false"}</available>',
            ]
            if code:
                lines.append(f'      <vendorCode>{esc(code)}</vendorCode>')
            if vendor in PROM_VENDORS:
                lines.append(f'      <vendor>{esc(vendor)}</vendor>')
            lines += [f'      <image>{esc(u)}</image>' for u in images[:10]]
            # No <param>: Prom validates them against each marketplace category's
            # own characteristic list and flagged ours as invalid data. Specs stay
            # in the description (both languages).
            if desc_ru:
                lines.append(f'      <description>{cdata(desc_ru)}</description>')
            lines.append(f'      <description_ua>{cdata(desc_ua)}</description_ua>')
            if e['kw_ru']:
                lines.append(f'      <keywords>{esc(cap_keywords(e["kw_ru"]))}</keywords>')
            lines += [
                f'      <keywords_ua>{esc(cap_keywords(e["kw_ua"]))}</keywords_ua>',
                '    </item>',
            ]
            usd = price.get('wholesale_usd')
            wholesale = round(usd * rate, 2) if is_num(usd) and usd > 0 else 0
            items.append((price_uah, random.randint(*RANDOM_ADD_UAH), wholesale, '\n'.join(lines)))

    catalog = '\n'.join(f'    <category id="{cid}" portal_id="{CATEGORIES[cid][1]}">{esc(CATEGORIES[cid][0])}</category>'
                        for cid in sorted(used_cats))
    feeds = load_feeds()
    for feed in feeds:
        fname, markup = feed['file'], feed['mult']
        body = []
        for base, bump, wholesale, text in items:
            has_wholesale = is_num(wholesale) and wholesale > 0
            if feed.get('wholesale'):
                if not has_wholesale:
                    continue
                value = wholesale
            elif feed.get('from_wholesale'):
                # Client feed built on the wholesale price: +/- % and its own range, no 1-10.
                if not has_wholesale:
                    continue
                value = max(1, wholesale * markup + (random.randint(*feed['add']) if feed['add'] else 0))
            elif feed['add']:
                # Random-range feed: table price (+/- %) plus its own random UAH,
                # not the main feed's 1-10.
                value = max(1, base * markup + random.randint(*feed['add']))
            else:
                value = (base + bump) * markup
            body.append(text.replace('{price}', f'{round(value, 2):.2f}'))
        xml = clean('<?xml version="1.0" encoding="UTF-8"?>\n<shop>\n  <catalog>\n' + catalog +
                    '\n  </catalog>\n  <items>\n' + '\n'.join(body) + '\n  </items>\n</shop>\n')
        if FORBIDDEN.search(xml):
            sys.exit(f'{fname}: forbidden substring found, file not written')
        ElementTree.fromstring(xml.encode('utf-8'))
        (ROOT / fname).parent.mkdir(parents=True, exist_ok=True)
        (ROOT / fname).write_text(xml, encoding='utf-8')
        print(f'{fname} generated: {len(body)} items, markup x{markup:.2f}'
              + (' from wholesale' if feed.get('from_wholesale') else '')
              + (f', +{feed["add"][0]}..{feed["add"][1]} UAH' if feed['add'] else ''))

    built = [f['file'] for f in feeds]
    try:
        previous = json.loads(FEEDS_BUILT.read_text('utf-8'))
    except FileNotFoundError:
        previous = []
    for old in previous:
        if old not in built and FEED_FILE_RE.match(old) and old not in RESERVED_FILES and (ROOT / old).exists():
            (ROOT / old).unlink()
            print(f'{old} removed (feed deleted in /prom-admin/)')
    FEEDS_BUILT.write_text(json.dumps(built, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    (ROOT / 'data/ultradomik/feed_items.json').write_text(
        json.dumps(admin_items, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

    labels = {'no_data': 'Немає даних/фото на сайті (пропущено)',
              'no_price': 'Без ціни (пропущено)',
              'no_photo': 'Немає фото на білому фоні (пропущено)',
              'rejected_photos': 'Відхилено фото не на білому фоні'}
    for key, label in labels.items():
        if report[key]:
            print(f'\n{label}:')
            for line in report[key]:
                print(f'  - {line}')


if __name__ == '__main__':
    main()
