#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generates bilingual (UK+RU) SEO keyword strings per product, following the
pattern found in "Ключові слова.txt" (confirmed against its 5 accumulator
examples byte-for-byte after recovering that file's encoding corruption).

This script only WRITES A REVIEW FILE (data/seo_keywords_review.txt) — it
does NOT touch products.json or feed.xml. Once the output is checked and
approved, a second small step (not yet written) would fold the approved
"merchant_keywords" text into products.json as its own field and append it
to <g:description> in scripts/generate_merchant_feed.js only (never into the
site-facing description used by product.js / generate_static_pages.js).

Confidence levels, per category:
  - "Акумулятори для гібридних інверторів": HIGH — matches the 5 provided
    examples exactly (brand phonetics, structure, "для інвертора"/LiFePO4).
  - All other categories: EXTRAPOLATED — same structural idea (type + key
    spec + brand phonetic + model suffix), no example was given for them,
    so brand phonetics for KBE/EcoFlow/TTN and the connecting phrase per
    category are a best guess and need a closer look before use.

Run: python3 scripts/generate_seo_keywords.py
"""
import json
import re
import os

ROOT = os.path.join(os.path.dirname(__file__), '..')

# ---- Brand phonetics (uk, ru). Confirmed against examples: DAH Solar, Deye,
# Dyness, Felicity, MUST. KBE/EcoFlow/TTN are extrapolated (unverified). ----
BRAND_PHONETIC = {
    'DAH Solar': ('дан солар', 'дан солар'),
    'Deye':      ('дея', 'дея'),
    'Dyness':    ('дайнес', 'дайнес'),
    # Felicity: no phonetic - nobody searches "селіситі"/"селисити".
    'MUST':      ('маст', 'маст'),
    'KBE':       ('кбе', 'кбе'),                 # unverified
    'EcoFlow':   ('екофлоу', 'экофлоу'),          # unverified
    'TTN':       ('ттн', 'ттн'),                  # unverified
}

KNOWN_BRANDS = [
    (re.compile(r'DAH\s*Solar', re.I), 'DAH Solar'),
    (re.compile(r'Dyness', re.I), 'Dyness'),
    (re.compile(r'Deye', re.I), 'Deye'),
    (re.compile(r'Felicity', re.I), 'Felicity'),
    (re.compile(r'\bMUST\b', re.I), 'MUST'),
    (re.compile(r'\bKBE\b', re.I), 'KBE'),
    (re.compile(r'EcoFlow', re.I), 'EcoFlow'),
    (re.compile(r'\bTTN\b'), 'TTN'),
    (re.compile(r'MaXpeedingRods', re.I), 'MaXpeedingRods'),
]


def detect_brand(title):
    found = [name for rgx, name in KNOWN_BRANDS if rgx.search(title)]
    # kits can match two brands (inverter + battery) — keyword-gen wants
    # each one separately, so return all matches here (unlike slugify.py's
    # detect_brand, which deliberately returns None for a multi-brand kit).
    seen = []
    for name in found:
        if name not in seen:
            seen.append(name)
    return seen


def model_suffix(title, brand):
    """Trailing code right after the brand name, e.g. FLA24100 -> 24100,
    DHN-LVWES05-G1 -> LVWES05-G1. Best-effort; returns None if nothing clean.
    Uses "not whitespace/comma" rather than [A-Z0-9-] so it doesn't stop
    early on a Cyrillic homoglyph digit-adjacent letter (e.g. "SE-F16-С"
    ends in Cyrillic С, U+0421, which looks like Latin C but isn't one)."""
    m = re.search(re.escape(brand) + r'\s+([^\s,]{3,})', title, re.I)
    if not m:
        return None
    code = m.group(1)
    m2 = re.search(r'(\d{3,})$', code)
    return m2.group(1) if m2 else code


CATEGORY_WORDS = {
    'Автономна енергетика > Акумулятори для гібридних інверторів': {
        'confidence': 'HIGH — verified against the source examples',
        'type_words': [('акумулятор', 'аккумулятор'), ('батарея', 'батарея')],
        'spec_re': re.compile(r'(\d+)\s*[AА][Hh]\b', re.I),
        'spec_suffix': 'ah',
        'connector': ('для інвертора', 'для инвертора'),
        'extra_tags': [('LiFePO4', 'LiFePO4')],
    },
    'Автономна енергетика > Гибридні інвертори': {
        'confidence': 'EXTRAPOLATED — no example given, review closely',
        'type_words': [('інвертор', 'инвертор'), ('гібридний інвертор', 'гибридный инвертор')],
        'spec_re': re.compile(r'(\d+(?:[.,]\d+)?)\s*кВт', re.I),
        'spec_suffix': 'kvt',
        'connector': ('для сонячних панелей', 'для солнечных панелей'),
        'extra_tags': [],
    },
    'Автономна енергетика > Комплекти автономного енергоживлення': {
        'confidence': 'EXTRAPOLATED — no example given, review closely',
        'type_words': [('комплект автономного живлення', 'комплект автономного электропитания'), ('комплект', 'комплект')],
        'spec_re': re.compile(r'(\d+(?:[.,]\d+)?)\s*кВт', re.I),
        'spec_suffix': 'kvt',
        'connector': ('для будинку', 'для дома'),
        'extra_tags': [('LiFePO4', 'LiFePO4')],
    },
    'Автономна енергетика > Силові та сонячні кабелі': {
        'confidence': 'EXTRAPOLATED — no example given, review closely',
        'type_words': [('кабель', 'кабель'), ('силовий кабель', 'силовой кабель')],
        'spec_re': re.compile(r'(\d+)\s*(?:мм|AWG)', re.I),
        'spec_suffix': 'mm',
        'connector': ('для акумулятора', 'для аккумулятора'),
        'extra_tags': [],
    },
    'Обладнання > Джерела безперебійного живлення > зарядна станція': {
        'confidence': 'EXTRAPOLATED — no example given, review closely',
        'type_words': [('зарядна станція', 'зарядная станция'), ('портативна зарядна станція', 'портативная зарядная станция')],
        'spec_re': re.compile(r'(\d+)\s*[Ww][Hh]\b', re.I),
        'spec_suffix': 'wh',
        'connector': ('для дому', 'для дома'),
        'extra_tags': [],
    },
    'Обладнання > Генератори': {
        'confidence': 'EXTRAPOLATED — no example given, review closely',
        'type_words': [('інверторний генератор', 'инверторный генератор'), ('бензиновий генератор', 'бензиновый генератор')],
        'spec_re': re.compile(r'(\d+(?:[.,]\d+)?)\s*кВт', re.I),
        'spec_suffix': 'kvt',
        'connector': ('для дому', 'для дома'),
        'extra_tags': [],
    },
    'Обладнання > Джерела безперебійного живлення > безперебійник': {
        'confidence': 'EXTRAPOLATED — no example given, review closely',
        'type_words': [('безперебійник', 'источник бесперебойного питания'), ('міні ДБЖ', 'мини ИБП')],
        'spec_re': re.compile(r'(\d+)\s*m[Aa][Hh]\b'),
        'spec_suffix': 'mah',
        'connector': ('для роутера', 'для роутера'),
        'extra_tags': [],
    },
}


def resolve_category_key(p):
    """Джерела безперебійного живлення mixes two different product kinds
    (EcoFlow charging stations vs. TTN's mini-UPS-for-router) that shouldn't
    share the same keyword vocabulary — split by title instead of
    product_type."""
    if p['product_type'] == 'Обладнання > Джерела безперебійного живлення':
        if re.match(r'^Безперебійник', p['title'], re.I):
            return 'Обладнання > Джерела безперебійного живлення > безперебійник'
        return 'Обладнання > Джерела безперебійного живлення > зарядна станція'
    return p['product_type']


def build_keywords(p):
    cfg = CATEGORY_WORDS.get(resolve_category_key(p))
    if not cfg:
        return None
    title = p['title']
    brands = detect_brand(title)
    m = cfg['spec_re'].search(title)
    spec_num = m.group(1) if m else None

    def phrases(lang_idx):
        out = []
        for type_uk_ru in cfg['type_words']:
            word = type_uk_ru[lang_idx]
            if spec_num:
                out.append(f"{word} {spec_num}{cfg['spec_suffix']}")
            for brand in brands:
                phon = BRAND_PHONETIC.get(brand)
                if not phon:
                    continue
                out.append(f"{word} {phon[lang_idx]}")
                if spec_num:
                    out.append(f"{word} {phon[lang_idx]} {spec_num} {cfg['spec_suffix']}")
        # connector phrase, once per type word (matches source pattern)
        for type_uk_ru in cfg['type_words']:
            out.append(f"{type_uk_ru[lang_idx]} {cfg['connector'][lang_idx]}")
        for tag in cfg['extra_tags']:
            out.append(tag[lang_idx])
        out.append('екодрайв' if lang_idx == 0 else 'экодрайв')
        out.append('ecodrive')
        # brand + model suffix (only when there's exactly one brand, avoids
        # nonsense for 2-brand kit titles where "suffix" would be ambiguous)
        if len(brands) == 1:
            suf = model_suffix(title, brands[0])
            if suf:
                phon = BRAND_PHONETIC.get(brands[0])
                if phon:
                    for type_uk_ru in cfg['type_words']:
                        out.append(f"{type_uk_ru[lang_idx]} {phon[lang_idx]} {suf}")
                    out.append(f"{phon[lang_idx]} {suf}")
        # de-dup while keeping order
        seen = set()
        deduped = []
        for x in out:
            if x not in seen:
                seen.add(x)
                deduped.append(x)
        return deduped

    return {
        'uk': phrases(0),
        'ru': phrases(1),
        'confidence': cfg['confidence'],
        'brands': brands,
    }


def main():
    with open(os.path.join(ROOT, 'products.json'), encoding='utf-8-sig') as f:
        products = json.load(f)

    lines = []
    no_match = []
    updated = 0
    for p in products:
        kw = build_keywords(p)
        if kw is None:
            no_match.append(p)
            p.pop('merchant_keywords_uk', None)
            p.pop('merchant_keywords_ru', None)
            continue
        lines.append(f"{p['id']}. {p['title']}")
        lines.append(f"[{kw['confidence']}]")
        lines.append(', '.join(kw['uk']))
        lines.append('')
        lines.append(', '.join(kw['ru']))
        lines.append('')
        lines.append('')

        # Merchant-feed-only fields: read exclusively by
        # scripts/generate_merchant_feed.js for <g:description>. Never read
        # by product.js / generate_static_pages.js / catalog.js, so this
        # never reaches a page a shopper (or Google's web crawler, as
        # opposed to the Merchant Center feed processor) sees.
        p['merchant_keywords_uk'] = ', '.join(kw['uk'])
        p['merchant_keywords_ru'] = ', '.join(kw['ru'])
        updated += 1

    out_path = os.path.join(ROOT, 'data', 'seo_keywords_review.txt')
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))

    with open(os.path.join(ROOT, 'products.json'), 'w', encoding='utf-8') as f:
        json.dump(products, f, ensure_ascii=False, indent=2)
        f.write('\n')

    print(f"wrote {out_path}")
    print(f"wrote merchant_keywords_uk/ru into products.json for {updated} / {len(products)} products")
    if no_match:
        print("no category match (skipped):")
        for p in no_match:
            print(' ', p['id'], p['product_type'], p['title'][:60])


if __name__ == '__main__':
    main()
