# Адмінка сайту

Вхід: **https://avtonomka.com.ua/admin.html**. Один email і пароль (користувач
Supabase Auth) для всіх розділів. Увійти достатньо один раз, і решта розділів
відкриваються вже залогіненими.

| Розділ | Адреса | Що там |
|---|---|---|
| Контент | `admin.html` | статті, модерація коментарів, віртуальні товари (SEO) |
| Мініапп | `miniapp-admin.html` | клієнти Telegram-мініаппа: заходи, перегляди, лайки |
| Розсилка | `miniapp-mailing.html` | розсилки ботом тим, хто цікавився товаром (див. docs/TELEGRAM_BOT_SETUP.md) |
| Аукціон | `auction-admin.html` | лоти, ставки, контакти лідера |
| Ціни Prom | `prom-admin/` | ціни й наявність для `prom_file.xml` та `invertorshop.xml` |
| Під замовлення | `preorder-admin/` | ціна й строк «під замовлення» (`scripts/backorder_offers.json`); наявність і ціна в наявності - з сайту |

Шапку, меню й вхід малює спільний скрипт `assets/js/admin-shell.js`.

## Забули пароль

Supabase Dashboard → **SQL Editor** → New query, підставити свою пошту й
новий пароль → **Run**:

```sql
update auth.users
   set encrypted_password = crypt('НовийПароль123', gen_salt('bf'))
 where email = 'ваша@пошта';
```

Список користувачів і їхніх email: Authentication → Users.

## Додати ще одного адміна

1. Authentication → Users → **Add user** → email і пароль. Реєстрацію для
   сторонніх вимкнено, тож користувачів створюють тільки тут.
2. Щоб людина бачила також дані мініаппа (клієнтів), у SQL Editor:

   ```sql
   insert into public.tg_admins (user_id, email)
   select id, email from auth.users where email = 'нова@пошта';
   ```

   Прибрати доступ: `delete from public.tg_admins where email = 'нова@пошта';`

Користувач з `app_metadata.role = auction_admin` (див.
`scripts/supabase/auction_schema.sql`) бачить лише аукціон: розділи
«Контент» для нього порожні.

## Ціни Prom і токен GitHub

Ціни Prom зберігаються в репозиторії (`data/ultradomik/prices.json`), тому
крім входу в адмінку розділ один раз просить **токен GitHub** з доступом
Contents: Read and write до репозиторію сайту. Браузер його запам'ятовує. Якщо
токен прострочився, розділ попросить новий.
