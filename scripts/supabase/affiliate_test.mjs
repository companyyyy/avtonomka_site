// Перевірка партнерської програми (scripts/supabase/affiliate_schema.sql) на
// тестовій БД у пам'яті - PGlite (Postgres 16 у WASM), без Docker і без
// доступу до бойового Supabase.
//
// Запуск з кореня репозиторію:
//   npm i --no-save @electric-sql/pglite@0.2.17
//   node scripts/supabase/affiliate_test.mjs
//
// Порядок: заглушки Supabase (ролі, auth, storage) → miniapp_tracking_schema.sql →
// orders_schema.sql → b2b_schema.sql → affiliate_schema.sql → сценарії з
// affiliate_test.sql. Кожен сценарій - блок «-- @test назва»; провал = exception.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const dir = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(dir, f), 'utf8');

const STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create schema storage;
  create table storage.objects (id serial primary key);
  alter table storage.objects enable row level security;
`;

const db = new PGlite();
await db.exec(STUBS);
for (const f of ['miniapp_tracking_schema.sql', 'orders_schema.sql', 'b2b_schema.sql', 'affiliate_schema.sql']) {
  try {
    await db.exec(read(f));
  } catch (e) {
    console.error(`✗ ${f}: ${e.message}`);
    process.exit(1);
  }
}
// Повторний запуск схеми не має падати (інструкція каже «безпечно запускати повторно»).
await db.exec(read('affiliate_schema.sql'));
console.log('✓ схеми застосовано (affiliate_schema.sql - двічі)');

const blocks = read('affiliate_test.sql').split(/^-- @test /m);
await db.exec(blocks.shift()); // спільна підготовка
let failed = 0;
for (const block of blocks) {
  const nl = block.indexOf('\n');
  const name = block.slice(0, nl).trim();
  try {
    await db.exec(block.slice(nl + 1));
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${name}\n    ${e.message}`);
  }
}
console.log(failed ? `\nПровалено: ${failed} з ${blocks.length}` : `\nУсі ${blocks.length} сценаріїв пройдено`);
process.exit(failed ? 1 : 0);
