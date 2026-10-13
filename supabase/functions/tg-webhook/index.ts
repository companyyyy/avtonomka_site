// tg-webhook - приймає оновлення від Telegram (вебхук бота).
//
//   /stop (і кнопка «Не надсилати мені пропозицій» у старих розсилках, callback "unsub")
//                         → tg_users.opted_out = true
//   /start                → клієнт у tg_users, боту можна писати; відповідь з
//                           кнопкою «Відкрити каталог»
//   бота заблокували / розблокували (my_chat_member)
//                         → tg_users.bot_blocked
//   замовлення з мініаппа (web_app_data, Telegram.WebApp.sendData)
//                         → повідомлення менеджеру, якщо задано MANAGER_CHAT_ID
//
// Секрети: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (довільний рядок, той
// самий, що в setWebhook secret_token); необов'язково MANAGER_CHAT_ID,
// MINIAPP_URL. JWT-перевірку вимкнути - Telegram не має сесії Supabase,
// захист - заголовок X-Telegram-Bot-Api-Secret-Token.
// Інструкція - docs/TELEGRAM_BOT_SETUP.md.

import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const TG_API = Deno.env.get("TELEGRAM_API_BASE") ?? "https://api.telegram.org"; // для тестів
const SITE_URL = (Deno.env.get("SITE_URL") ?? "https://avtonomka.com.ua").replace(/\/$/, "");
const MINIAPP_URL = Deno.env.get("MINIAPP_URL") ?? `${SITE_URL}/miniapp_v/index.html`;
const MANAGER_CHAT_ID = Deno.env.get("MANAGER_CHAT_ID") ?? "";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

async function tg(method: string, payload: unknown) {
  const res = await fetch(`${TG_API}/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await res.json();
}

const catalogButton = { inline_keyboard: [[{ text: "🛒 Відкрити каталог", web_app: { url: MINIAPP_URL } }]] };

// Клієнт міг ніколи не відкривати мініапп - тоді створюємо запис.
async function upsertUser(from: any, patch: Record<string, unknown>) {
  const { data } = await db.from("tg_users").select("tg_id").eq("tg_id", from.id).maybeSingle();
  if (data) {
    await db.from("tg_users").update(patch).eq("tg_id", from.id);
  } else {
    await db.from("tg_users").insert({
      tg_id: from.id,
      username: from.username ?? null,
      first_name: from.first_name ?? null,
      last_name: from.last_name ?? null,
      language_code: from.language_code ?? null,
      ...patch,
    });
  }
}

function orderText(o: any, from: any) {
  const items = (o.items ?? []).map((i: any) => `• ${i.name} × ${i.qty} - ${i.price} ${i.unit ?? "UAH"}`).join("\n");
  const who = from.username ? `@${from.username}` : `id ${from.id}`;
  return [
    "🛒 Нове замовлення з мініаппа",
    `${o.name ?? ""}, ${o.phone ?? ""} (${who})`,
    o.city ? `Доставка: ${o.city}` : "",
    o.comment ? `Коментар: ${o.comment}` : "",
    "",
    items,
    `Разом: ${Math.round(Number(o.total) || 0).toLocaleString("uk-UA")} грн`,
  ].filter((l) => l !== "").join("\n");
}

export async function handleUpdate(u: any) {
  // Кнопка «Не надсилати мені пропозицій» - була в розсилках до 13.10, лишається робочою у старих повідомленнях
  if (u.callback_query?.data === "unsub") {
    const from = u.callback_query.from;
    await upsertUser(from, { opted_out: true });
    await tg("answerCallbackQuery", {
      callback_query_id: u.callback_query.id,
      text: "Готово: більше не надсилатимемо пропозицій.",
    });
    return;
  }

  // Бота заблокували / розблокували
  const cm = u.my_chat_member;
  if (cm && cm.chat?.type === "private") {
    const status = cm.new_chat_member?.status;
    if (status === "kicked") await upsertUser(cm.from, { bot_blocked: true });
    else if (status === "member") await upsertUser(cm.from, { bot_blocked: false, write_access: true, write_access_at: new Date().toISOString() });
    return;
  }

  const msg = u.message;
  if (!msg || msg.chat?.type !== "private") return;
  const from = msg.from;

  // Замовлення з мініаппа (Telegram.WebApp.sendData)
  if (msg.web_app_data?.data) {
    let order;
    try { order = JSON.parse(msg.web_app_data.data); } catch { return; }
    if (order?.type === "order" && MANAGER_CHAT_ID) {
      await tg("sendMessage", { chat_id: MANAGER_CHAT_ID, text: orderText(order, from) });
    }
    await tg("sendMessage", { chat_id: from.id, text: "✅ Дякуємо! Замовлення отримано, менеджер скоро зв'яжеться з вами." });
    return;
  }

  const text = (msg.text ?? "").trim();
  if (text.startsWith("/start")) {
    await upsertUser(from, {
      username: from.username ?? null, first_name: from.first_name ?? null, last_name: from.last_name ?? null,
      write_access: true, write_access_at: new Date().toISOString(), bot_blocked: false,
    });
    await tg("sendMessage", {
      chat_id: from.id,
      text: "Вітаємо в Автономці! ⚡\nІнвертори, акумулятори та готові комплекти автономного живлення - у каталозі нижче.",
      reply_markup: catalogButton,
    });
  } else if (text.startsWith("/stop")) {
    await upsertUser(from, { opted_out: true });
    await tg("sendMessage", { chat_id: from.id, text: "Готово: більше не надсилатимемо пропозицій. Каталог лишається доступним.", reply_markup: catalogButton });
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  if (!SECRET || req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  try {
    await handleUpdate(await req.json());
  } catch (e) {
    console.error(e);
  }
  // Завжди 200: інакше Telegram повторюватиме те саме оновлення.
  return new Response("ok");
});
