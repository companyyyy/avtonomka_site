"""
Python port of scripts/slugify.js — kept logically identical (same regexes,
same core-name extraction) since fetch_feed.py (Python) is what actually
persists the "slug" field in products.json; generate_static_pages.js /
generate_merchant_feed.js (Node) just read p.slug back out, they never
recompute it. See scripts/slugify.js for the full rationale.
"""

import re

TRANSLIT = {
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'h', 'ґ': 'g', 'д': 'd', 'е': 'e', 'є': 'ie', 'ж': 'zh',
    'з': 'z', 'и': 'y', 'і': 'i', 'ї': 'i', 'й': 'i', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n',
    'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'kh', 'ц': 'ts',
    'ч': 'ch', 'ш': 'sh', 'щ': 'shch', 'ь': '', 'ю': 'iu', 'я': 'ia', "'": '',
    'ё': 'e', 'э': 'e', 'ы': 'y', 'ъ': '',
}

TYPE_PREFIXES = [
    r'^Комплект силових кабелів\s*',
    r'^Сонячний кабель\s*',
    r'^Гібридний інвертор\s*',
    r'^Акумуляторна батарея\s*',
    r'^Акумулятор\s*',
    r'^Зарядна станція\s*',
    r'^Безперебійник(?:\s+для\s+\S+)?\s*',
]

UNIT_CUT_RE = re.compile(
    r'\d+(?:[.,]\d+)?\s*(?:кВт|kW|kw|Вт|фаза|V|В|Ah|Аh|ah)(?![A-Za-zА-Яа-яІіЇїЄєҐґ])', re.I
)
WIFI_RE = re.compile(r'\bWi-?Fi\b', re.I)


def strip_type_prefix(name):
    for pat in TYPE_PREFIXES:
        stripped = re.sub(pat, '', name, count=1, flags=re.I)
        if stripped != name:
            return stripped.strip()
    return name


def part_short(segment):
    # A cut at position 0 would leave nothing (e.g. "Wi-Fi-модуль для ...") -
    # only cut a tail that follows a real name.
    cuts = []
    m1 = UNIT_CUT_RE.search(segment)
    if m1 and m1.start() > 0:
        cuts.append(m1.start())
    m2 = WIFI_RE.search(segment)
    if m2 and m2.start() > 0:
        cuts.append(m2.start())
    s = segment[:min(cuts)] if cuts else segment
    return s.strip().rstrip(',+').strip()


def kit_core_name(title):
    body = re.sub(r'^Комплект автономного енергоживлення:\s*', '', title, flags=re.I)
    parts = re.split(r'\s*\+\s*', body, maxsplit=1)
    if len(parts) != 2:
        return part_short(body)
    return part_short(parts[0]) + ' ' + part_short(parts[1])


def core_name(title):
    if re.match(r'^Комплект автономного енергоживлення', title, re.I):
        return kit_core_name(title)
    return part_short(strip_type_prefix(title))


def transliterate(s):
    return ''.join(TRANSLIT.get(ch.lower(), ch) for ch in s)


def truncate_slug(slug, max_len):
    if len(slug) <= max_len:
        return slug
    cut = slug[:max_len]
    if '-' in cut:
        cut = cut.rsplit('-', 1)[0]
    return cut


def slugify(title, max_len=65):
    name = core_name(title or '')
    translit = transliterate(name).lower()
    slug = re.sub(r'[^a-z0-9]+', '-', translit)
    slug = re.sub(r'-{2,}', '-', slug).strip('-')
    return truncate_slug(slug, max_len)
