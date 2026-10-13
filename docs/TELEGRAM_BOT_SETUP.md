# Підключення Telegram-бота (розсилки, перевірка мініаппа)

Код уже готовий і лежить у репозиторії. Коли буде токен бота, лишається
вставити секрети, розгорнути 3 функції в Supabase і вказати Telegram адресу
вебхука. Займає ~15 хвилин.

| Функція | Що робить | JWT-перевірка |
|---|---|---|
| `supabase/functions/miniapp-api` | перевіряє підпис Telegram і записує заходи й лайки мініаппа | **вимкнути** |
| `supabase/functions/tg-send-campaign` | надсилає розсилки з адмінки (розділ «Розсилка») | **лишити увімкненою** |
| `supabase/functions/tg-webhook` | «Не надсилати мені пропозицій», /start, /stop, блокування бота, замовлення з мініаппа менеджеру | **вимкнути** |

## 0. Перед початком

- Токен: @BotFather → /mybots → бот → **API Token**.
- **Перевірте, чи бот уже кудись підключений** (n8n тощо): відкрийте в браузері
  `https://api.telegram.org/bot<ТОКЕН>/getWebhookInfo`. Якщо поле `url` не
  порожнє, бот уже має вебхук, і крок 3 його **замінить**. Тоді спершу
  з'ясуйте, що там працює.
- SQL з `scripts/supabase/miniapp_tracking_schema.sql` має бути виконаний
  (останню версію, з розсилками).

## 1. Секрети

Supabase → **Edge Functions → Secrets** → Add:

| Назва | Значення |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен від @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | будь-який довгий випадковий рядок з латинських літер і цифр (≥ 20 символів), його ж вставити в кроці 3 |
| `MANAGER_CHAT_ID` | *(необов'язково)* chat id менеджера, щоб замовлення з мініаппа приходили йому в Telegram |

`SUPABASE_URL` і ключі Supabase додає сам.

## 2. Розгорнути функції

Для кожної з трьох: Supabase → **Edge Functions → Deploy a new function → Via
Editor** → назва **точно як у таблиці** (`miniapp-api`, `tg-send-campaign`,
`tg-webhook`) → замінити код вмістом відповідного `index.ts` → **Deploy**.

Потім у функціях `miniapp-api` і `tg-webhook` → **Details / Settings** →
вимкнути **Enforce JWT verification** → Save.

Перевірка: адмінка → **Розсилка**. Зверху має з'явитися «Бот @… підключено».

## 3. Вебхук бота

Відкрити в браузері (підставити токен і секрет з кроку 1):

```
https://api.telegram.org/bot<ТОКЕН>/setWebhook?url=https://uvndubhmqzqqsrnrxgaj.supabase.co/functions/v1/tg-webhook&secret_token=<СЕКРЕТ>&allowed_updates=["message","callback_query","my_chat_member"]
```

Відповідь має бути `{"ok":true,...}`. Перевірка: написати боту `/start`, і він
відповість кнопкою «Відкрити каталог».

## 4. Увімкнути перевірку підпису в мініаппі

1. У `miniapp_v/index.html` → `CONFIG.MINIAPP_API` вписати
   `https://uvndubhmqzqqsrnrxgaj.supabase.co/functions/v1/miniapp-api` і
   опублікувати.
2. Після цього заборонити прямі виклики без підпису, Supabase → SQL Editor:

   ```sql
   revoke execute on function public.miniapp_visit(jsonb, text, text)                   from anon;
   revoke execute on function public.miniapp_track(bigint, text, text, text, text, text) from anon;
   revoke execute on function public.miniapp_set_like(bigint, text, text, boolean)      from anon;
   revoke execute on function public.miniapp_set_write_access(bigint, boolean)          from anon;
   ```

   Відкотити, якщо щось пішло не так: ті самі рядки з `grant ... to anon`
   замість `revoke ... from anon` і порожній `MINIAPP_API`.

## 5. Перевірити розсилку

Адмінка → **Розсилка** → товар → «Показати отримувачів» → текст →
**Надіслати тест собі** (ваш @username; ви маєте хоч раз відкрити мініапп і
запустити бота). Прийшло повідомлення з фото й кнопками, кнопка відкриває
товар у мініаппі. Після цього можна надсилати клієнтам.

## Chat id менеджера

Менеджер пише боту `/start`, після чого його id видно в адмінці → Мініапп
(колонка Telegram id у картці клієнта). Або через @userinfobot. Вписати в
секрет `MANAGER_CHAT_ID` і перерозгорнути `tg-webhook` (Deploy ще раз).
