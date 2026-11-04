/**
 * Reads products.json and generates catalog_export.csv
 * Columns: category, brand, name, price, unit, photo_url, description
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const BRAND_KEYWORDS = [
  ['EcoFlow',   'EcoFlow'],
  ['DAH Solar', 'DAH Solar'],
  ['Dyness',    'DYNESS'],
  ['Deye',      'DEYE'],
  ['DEYE',      'DEYE'],
  ['Felicity',  'FELICITY'],
  ['Must',      'MUST'],
  ['MUST',      'MUST'],
  ['KBE',       'KBE'],
  ['TOMZN',     'TOMZN'],
  ['Geya',      'Geya'],
  ['MaXpeedingRods', 'MaXpeedingRods'],
];

function extractBrand(title) {
  for (const [kw, brand] of BRAND_KEYWORDS) {
    if (title.includes(kw)) return brand;
  }
  return '—';
}

function csvCell(val) {
  const s = String(val ?? '');
  return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
    ? '"' + s.replace(/"/g, '""') + '"'
    : s;
}

let raw = fs.readFileSync(path.join(ROOT, 'products.json'), 'utf8');
if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
const products = JSON.parse(raw);

const rows = [['category', 'brand', 'name', 'price', 'unit', 'photo_url', 'description']];

for (const p of products) {
  const category    = (p.product_type || '').split('>').pop().trim();
  const brand       = extractBrand(p.title || '');
  const name        = p.title || '';
  const price       = parseFloat(p.price) || '';
  const unit        = 'грн';
  const photoUrl    = p.image_link || '';
  const description = (p.description || '').replace(/[\r\n]+/g, ' ').trim();

  rows.push([category, brand, name, price, unit, photoUrl, description]);
}

const csv = '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
fs.writeFileSync(path.join(ROOT, 'catalog_export.csv'), csv, 'utf8');
console.log(`Done — exported ${rows.length - 1} products to catalog_export.csv`);
