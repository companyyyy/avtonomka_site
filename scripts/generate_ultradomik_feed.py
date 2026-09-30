"""
Generates the Prom.ua import feeds (Price.ua format, RU + UA) for reseller
clients - see FEEDS: prom_file.xml (Ultradomik) and invertorshop.xml
(ІнверторШоп, +18%). Served at https://avtonomka.com.ua/<file> - each
client's Prom cabinet pulls its own file by link.

Prices and stock come from the Google Sheet "Price Avtonomka під XML"
(USD, converted at a fixed rate of 45). Texts (UA + RU), specs and search
queries come from data/ultradomik/products.json; photos are the supplier's
white-background copies from products.json -> prom_images (plus a photo taken
from the sheet in assets/images/ultradomik/<id>.jpg, if any), re-checked here.
An entry with "feed_only": true has no product card on the site - its id is
our own and its photo comes only from assets/images/ultradomik/.
A sheet row with no entry in data/ultradomik/products.json, no price or no
white-background photo is left out and listed in the report.

Run: python scripts/generate_ultradomik_feed.py
"""

import csv
import io
import json
import re
import sys
import urllib.request
from pathlib import Path
from xml.etree import ElementTree

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SITE_URL = 'https://avtonomka.com.ua'
SHEET_CSV = ('https://docs.google.com/spreadsheets/d/'
             '1hUWLK904eO_jA5wtsJRXIcuyfwHeNJdeo5CteDCY4-0/export?format=csv&gid=1763821507')
USD_RATE = 45
# One build, several files: the same items, texts, photos and categories,
# only the price differs. (file, price markup)
FEEDS = [
    ('prom_file.xml', 1.00),      # Ultradomik
    ('invertorshop.xml', 1.18),   # ІнверторШоп: +18% on every price
]

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
}

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


def norm(s):
    return re.sub(r'\s+', '', str(s or '')).lower()


def fetch_sheet():
    with urllib.request.urlopen(SHEET_CSV, timeout=60) as r:
        text = r.read().decode('utf-8')
    rows = []
    for row in csv.reader(io.StringIO(text)):
        row += [''] * (7 - len(row))
        name, price, stock = row[1].strip(), row[3].strip(), row[6].strip()
        if not name:  # section/brand headers, or a price-only sub-row (e.g. preorder)
            continue
        rows.append((name, price, stock))
    return rows


def parse_price(raw):
    try:
        return float(raw.replace(' ', '').replace(',', '.'))
    except ValueError:
        return None


def in_stock(stock):
    return stock.lstrip('`').startswith('+')


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
    html = ''.join(f'<p>{esc(p)}</p>' for p in paras)
    html += f'<p><strong>{head_use}:</strong></p><ul>' + ''.join(f'<li>{esc(u)}</li>' for u in usage) + '</ul>'
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
    by_sheet = {norm(e['sheet']): e for e in entries}

    report = {'no_data': [], 'no_price': [], 'no_photo': [], 'rejected_photos': []}
    items, used_cats = [], set()

    for name, raw_price, stock in fetch_sheet():
        price_usd = parse_price(raw_price)
        if price_usd is None or price_usd <= 0:
            report['no_price'].append(f'{name} ({raw_price or "порожньо"}, {stock})')
            continue
        entry = by_sheet.get(norm(name))
        if not entry:
            report['no_data'].append(name)
            continue
        price_uah = price_usd * entry.get('mult', 1) * USD_RATE

        for pid in entry['ids']:
            # feed_only: sold through the feed only, no product card on the site
            p = products.get(pid) or ({'id': pid, 'title': ''} if entry.get('feed_only') else None)
            if not p:
                report['no_data'].append(f'{name} (товару {pid} немає в products.json)')
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
            for img in sheet_photos + list(p.get('prom_images') or []):
                path = ROOT / img
                if FORBIDDEN.search(img) or not path.exists() or white_ratio(path) < 0.95:
                    rejected += 1
                    continue
                images.append(f'{SITE_URL}/{img}')
            if rejected:
                report['rejected_photos'].append(f'{pid} {t(e["name_ua"], "ua")}: {rejected}')
            if not images:
                report['no_photo'].append(f'{pid} {t(e["name_ua"], "ua")}')
                continue

            cat = entry['cat']
            used_cats.add(cat)
            specs_ua = [(t(n, 'ua'), t(v, 'ua')) for n, v in spec_pairs(e['specs'], 'ua')]
            specs_ru = [(t(n, 'ru'), t(v, 'ru')) for n, v in spec_pairs(e['specs'], 'ru')]
            desc_ua = description([t(x, 'ua') for x in e['p_ua']], USAGE[cat][0], specs_ua, 'ua')
            desc_ru = description([t(x, 'ru') for x in e['p_ru']], USAGE[cat][1], specs_ru, 'ru')
            vendor = e.get('vendor', '')
            code = (e.get('code') or '')[:25]

            lines = [
                f'    <item id="{esc(pid)}" selling_type="r">',
                f'      <name>{esc(t(e["name_ru"], "ru"))}</name>',
                f'      <name_ua>{esc(t(e["name_ua"], "ua"))}</name_ua>',
                f'      <categoryId>{cat}</categoryId>',
                f'      <portal_category_id>{e.get("portal") or CATEGORIES[cat][1]}</portal_category_id>',
                '      <priceuah>{price}</priceuah>',
                f'      <available>{"true" if in_stock(stock) else "false"}</available>',
            ]
            if code:
                lines.append(f'      <vendorCode>{esc(code)}</vendorCode>')
            if vendor in PROM_VENDORS:
                lines.append(f'      <vendor>{esc(vendor)}</vendor>')
            lines += [f'      <image>{esc(u)}</image>' for u in images[:10]]
            # No <param>: Prom validates them against each marketplace category's
            # own characteristic list and flagged ours as invalid data. Specs stay
            # in the description (both languages).
            lines += [
                f'      <description>{cdata(desc_ru)}</description>',
                f'      <description_ua>{cdata(desc_ua)}</description_ua>',
                f'      <keywords>{esc(cap_keywords(e["kw_ru"]))}</keywords>',
                f'      <keywords_ua>{esc(cap_keywords(e["kw_ua"]))}</keywords_ua>',
                '    </item>',
            ]
            items.append((price_uah, '\n'.join(lines)))

    catalog = '\n'.join(f'    <category id="{cid}" portal_id="{CATEGORIES[cid][1]}">{esc(CATEGORIES[cid][0])}</category>'
                        for cid in sorted(used_cats))
    for fname, markup in FEEDS:
        body = '\n'.join(text.replace('{price}', f'{round(base * markup, 2):.2f}') for base, text in items)
        xml = clean('<?xml version="1.0" encoding="UTF-8"?>\n<shop>\n  <catalog>\n' + catalog +
                    '\n  </catalog>\n  <items>\n' + body + '\n  </items>\n</shop>\n')
        if FORBIDDEN.search(xml):
            sys.exit(f'{fname}: forbidden substring found, file not written')
        ElementTree.fromstring(xml.encode('utf-8'))
        (ROOT / fname).write_text(xml, encoding='utf-8')
        print(f'{fname} generated: {len(items)} items, markup x{markup:.2f}')

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
