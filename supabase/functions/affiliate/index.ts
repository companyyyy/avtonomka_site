// affiliate - бекенд партнерської програми: переходи за реферальними
// посиланнями (assets/js/affiliate.js), вкладка «Партнерська програма» в
// B2B-кабінеті (/b2b/), розділ адмінки «Партнерка» (affiliate-admin/) і
// публічна сторінка partnerska-programa.html.
// Схема й уся грошова логіка: scripts/supabase/affiliate_schema.sql. Інструкція: docs/AFFILIATE.md.
//
// Запит: POST JSON { action, ... }, заголовок Authorization: Bearer <JWT>
// (supabase-js functions.invoke ставить його сам: сесію користувача або anon-ключ).
//
// Без входу:
//   terms        - умови програми (для публічної сторінки): %, cookie, мін. виплата, правила
//   click        { code, landing?, referrer?, token? } - перехід за посиланням; повертає
//                  { token, max_age } для cookie aff_ref (token = код.час.підпис) або token: null
// B2B-клієнт (app_metadata.role = 'b2b', статус approved, b2b_clients.affiliate_enabled):
//   me           - умови, мій партнерський запис (або null), баланс, реквізити
//   join         { accept: true } - стати партнером (погодився з правилами)
//   stats        { from?, to? } - зведення за період, нарахування, журнал, виплати
//   payout       { points, details: { method: 'iban'|'card', iban?, card?, name, ipn? } }
// Адмін (tg_admins):
//   admin_overview            - налаштування, ставки, категорії, партнери, нарахування, виплати, журнал дій
//   admin_settings            { settings: {...}, rates: [{ scope, scope_id, rate }] } - ставки замінюються повністю
//   admin_partner             { id, status?, custom_rate? }
//   admin_adjust              { id, points, comment }
//   admin_commission_status   { id, status, comment }
//   admin_assign              { number, code | null } - призначити / зняти партнера з замовлення
//   admin_payout_details      { id } - розшифровані реквізити заявки (перегляд пишеться в журнал)
//   admin_payout              { id, status: 'paid'|'rejected', comment? }
//
// Секрети: AFFILIATE_SECRET (обов'язково, той самий в order-submit) - підпис
// cookie, хеш IP і шифрування реквізитів; змінювати не можна, інакше старі
// реквізити не розшифруються, а cookie стануть недійсні. TELEGRAM_BOT_TOKEN,
// MANAGER_CHAT_ID - сповіщення адміну (як для b2b). SUPABASE_URL і
// SUPABASE_SERVICE_ROLE_KEY Supabase додає сам.

import { createClient } from "npm:@supabase/supabase-js@2";

const SECRET = Deno.env.get("AFFILIATE_SECRET") ?? "";
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const MANAGER_CHAT_ID = Deno.env.get("MANAGER_CHAT_ID") ?? "";
const TG_API = Deno.env.get("TELEGRAM_API_BASE") ?? "https://api.telegram.org";
const SITE_URL = (Deno.env.get("SITE_URL") ?? "https://avtonomka.com.ua").replace(/\/$/, "");
const CODE_RE = /^[A-HJ-NP-Z2-9]{6,8}$/;

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

const text = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "") || null;
const escHtml = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n: number) => `${Math.round(n).toLocaleString("uk-UA")} грн`;

async function notifyManager(lines: string[]) {
  if (!MANAGER_CHAT_ID || !BOT_TOKEN) return;
  try {
    await fetch(`${TG_API}/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: MANAGER_CHAT_ID, text: lines.filter((l) => l !== "").join("\n"), parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (e) {
    console.error("affiliate: Telegram", e);
  }
}

// Помилки SQL-функцій (raise exception) → зрозумілий текст для кабінету й адмінки.
const ERRORS: Record<string, string> = {
  "not enough points": "Недостатньо балів",
  "below minimum": "Сума менша за мінімальну виплату",
  "payout already requested": "У вас уже є необроблена заявка на виплату",
  "partner blocked": "Участь у програмі призупинено",
  "no payout details": "Вкажіть реквізити",
  "comment required": "Потрібен коментар",
  "amount required": "Вкажіть кількість балів",
  "already processed": "Заявку вже оброблено",
  "order not found": "Замовлення не знайдено",
  "partner not found": "Партнера з таким кодом немає",
  "client not approved": "Доступ до кабінету ще не схвалено",
};
function rpcError(e: { message?: string } | null) {
  const m = e?.message ?? "error";
  const key = Object.keys(ERRORS).find((k) => m.includes(k));
  if (key) return ERRORS[key];
  if (m.includes("not allowed")) return "Такий перехід статусу неможливий";
  if (m.includes("cannot attach")) return m.includes("self") ? "Це замовлення самого партнера" : "Не вдалося прив'язати: " + m.split("cannot attach: ")[1];
  return m;
}

// ─── Підпис cookie, хеш IP, шифрування реквізитів ─────────────────────

const enc = new TextEncoder();
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function hmac(data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

// Cookie aff_ref = «КОД.unix-секунди.підпис». Те саме - verifyAffToken() в order-submit.
async function signToken(code: string, ts: number) {
  return `${code}.${ts}.${b64url(await hmac(`aff:${code}.${ts}`)).slice(0, 22)}`;
}
async function verifyToken(token: string | null) {
  const m = /^([A-HJ-NP-Z2-9]{6,8})\.(\d{9,11})\.([\w-]{22})$/.exec(token ?? "");
  if (!m || !SECRET) return null;
  if ((await signToken(m[1], Number(m[2]))) !== token) return null;
  return { code: m[1], ts: Number(m[2]) };
}

async function aesKey() {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`payout:${SECRET}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(obj: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(), enc.encode(JSON.stringify(obj))));
  const out = new Uint8Array(iv.length + data.length);
  out.set(iv);
  out.set(data, iv.length);
  return "v1:" + btoa(String.fromCharCode(...out));
}
async function decrypt(s: string | null) {
  if (!s?.startsWith("v1:")) return null;
  try {
    const b = fromB64(s.slice(3));
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12) }, await aesKey(), b.slice(12));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

function clientIp(req: Request) {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "unknown";
}

// ─── Дані сайту ───────────────────────────────────────────────────────

let productsCache: { at: number; map: Map<string, any> } | null = null;
async function siteProducts() {
  if (productsCache && Date.now() - productsCache.at < 60_000) return productsCache.map;
  const r = await fetch(`${SITE_URL}/products.json?t=${Date.now()}`, { headers: { "Cache-Control": "no-cache" } });
  if (!r.ok) throw new Error(`products.json: ${r.status}`);
  const map = new Map<string, any>((await r.json() as any[]).map((p) => [String(p.id), p]));
  productsCache = { at: Date.now(), map };
  return map;
}

// { "<product_id>": "<product_type>" } для позицій замовлення - категорійні ставки.
async function categoriesFor(orderId: string) {
  const { data } = await db.from("order_items").select("product_id").eq("order_id", orderId);
  const products = await siteProducts().catch(() => new Map<string, any>());
  const out: Record<string, string> = {};
  for (const i of data ?? []) {
    const t = i.product_id && products.get(String(i.product_id))?.product_type;
    if (t) out[i.product_id] = t;
  }
  return out;
}

async function settings() {
  const { data, error } = await db.from("affiliate_settings").select("*").eq("id", 1).single();
  if (error) throw new Error(error.message);
  return data;
}

async function rates() {
  const { data } = await db.from("affiliate_rates").select("scope, scope_id, rate").order("scope").order("scope_id");
  return data ?? [];
}

// Що можна показати будь-кому: умови програми.
async function publicTerms() {
  const s = await settings();
  const cats = (await rates()).filter((r) => r.scope === "category")
    .map((r) => ({ category: r.scope_id.split(">").pop()!.trim(), rate: Number(r.rate) }));
  return {
    enabled: s.enabled, default_rate: Number(s.default_rate), category_rates: cats, cookie_days: s.cookie_days,
    hold_days: s.hold_days, min_payout: Number(s.min_payout), point_value: Number(s.point_value),
    max_points_share: Number(s.max_points_share), attribution: s.attribution, rules_text: s.rules_text ?? "",
  };
}

// ─── Без входу ────────────────────────────────────────────────────────

async function click(req: Request, b: any) {
  if (!SECRET) { console.error("affiliate: AFFILIATE_SECRET не задано"); return json({ ok: true, token: null }); }
  const s = await settings();
  const now = Math.floor(Date.now() / 1000);
  const life = s.cookie_days * 86400;
  const oldToken = text(b.token, 80);
  const old = await verifyToken(oldToken);
  const oldValid = old && old.ts > now - life;
  const keep = () => json({ ok: true, token: oldValid ? oldToken : null, max_age: oldValid ? old!.ts + life - now : 0 });

  const code = (text(b.code, 12) ?? "").toUpperCase();
  if (!s.enabled || !CODE_RE.test(code)) return keep();
  const ipHash = b64url(await hmac(`ip:${clientIp(req)}`)).slice(0, 32);
  const { data: hit, error } = await db.rpc("affiliate_record_click", {
    p_code: code, p_landing: text(b.landing, 500), p_referer: text(b.referrer, 500),
    p_ip_hash: ipHash, p_ua: text(req.headers.get("user-agent"), 300),
  });
  if (error) { console.error("affiliate: click", error); return keep(); }
  if (!hit) return keep(); // невідомий або заблокований код - мовчки ігноруємо
  // Перший клік: діючу cookie не чіпаємо (ні строк, ні партнера). Останній клік - нова cookie.
  if (s.attribution === "first" && oldValid) return keep();
  return json({ ok: true, token: await signToken(hit.code, now), max_age: life });
}

// ─── Партнер (B2B-клієнт) ─────────────────────────────────────────────

const mask = (n: number | string) => { const s = String(n); return s.slice(0, 2) + "•".repeat(Math.max(0, s.length - 2)); };

async function partnerOf(clientId: string) {
  const { data } = await db.from("affiliates").select("*").eq("client_id", clientId).maybeSingle();
  return data;
}

async function summary(affId: string, from = "2000-01-01", to = "2100-01-01") {
  const { data, error } = await db.rpc("affiliate_summary", { p_affiliate: affId, p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  return data;
}

async function partnerAction(action: string, client: any, b: any) {
  if (action === "me") {
    await db.rpc("affiliate_approve_due");
    const a = await partnerOf(client.id);
    return json({
      ok: true, terms: await publicTerms(),
      partner: a ? { code: a.code, status: a.status, custom_rate: a.custom_rate, created_at: a.created_at } : null,
      summary: a ? await summary(a.id) : null,
      details: a ? await decrypt(a.payout_details) : null,
    });
  }

  if (action === "join") {
    if (b.accept !== true) return json({ error: "Потрібно погодитися з правилами програми" }, 400);
    const s = await settings();
    if (!s.enabled) return json({ error: "Програма зараз не приймає нових партнерів" }, 400);
    const existed = await partnerOf(client.id);
    const { data: a, error } = await db.rpc("affiliate_join", { p_client: client.id });
    if (error) return json({ error: rpcError(error) }, 400);
    if (!existed) {
      await notifyManager([
        `🤝 <b>Новий партнер</b> · код <code>${escHtml(a.code)}</code>`,
        `${escHtml(client.company)}, ${escHtml(client.contact_name)}, ${escHtml(client.phone)}`,
        `\n<a href="${SITE_URL}/affiliate-admin/#${a.id}">Відкрити в адмінці</a>`,
      ]);
    }
    return json({ ok: true, code: a.code });
  }

  const a = await partnerOf(client.id);
  if (!a) return json({ error: "not a partner" }, 403);

  if (action === "stats") {
    const from = text(b.from, 40) ?? "2000-01-01";
    const to = text(b.to, 40) ?? "2100-01-01";
    const [sum, comm, tx, payouts] = await Promise.all([
      summary(a.id, from, to),
      db.from("affiliate_commissions").select("created_at, base_amount, commission_amount, rates_snapshot, status, approved_at, orders(number)")
        .eq("affiliate_id", a.id).gte("created_at", from).lt("created_at", to).order("created_at", { ascending: false }).limit(500),
      db.from("affiliate_transactions").select("created_at, type, amount, comment")
        .eq("affiliate_id", a.id).order("created_at", { ascending: false }).limit(300),
      db.from("affiliate_payouts").select("created_at, amount, amount_uah, status, admin_comment, processed_at")
        .eq("affiliate_id", a.id).order("created_at", { ascending: false }),
    ]);
    // Без персональних даних покупця: лише частково замаскований номер і суми.
    const commissions = (comm.data ?? []).map((k: any) => {
      const pv = Number(k.rates_snapshot?._point_value) || 1;
      const base = Number(k.base_amount);
      return {
        date: k.created_at, order: mask(k.orders?.number ?? ""), base, points: k.commission_amount, status: k.status,
        rate: base > 0 ? Math.round(k.commission_amount * pv / base * 10000) / 100 : null, approved_at: k.approved_at,
      };
    });
    return json({ ok: true, summary: sum, commissions, transactions: tx.data ?? [], payouts: payouts.data ?? [] });
  }

  if (action === "payout") {
    const d = b.details ?? {};
    const method = d.method === "card" ? "card" : "iban";
    const details = {
      method,
      iban: method === "iban" ? (text(d.iban, 40) ?? "").replace(/\s/g, "").toUpperCase() : null,
      card: method === "card" ? (text(d.card, 30) ?? "").replace(/\D/g, "") : null,
      name: text(d.name, 150),
      ipn: (text(d.ipn, 12) ?? "").replace(/\D/g, "") || null,
    };
    if (!details.name) return json({ error: "Вкажіть ПІБ отримувача" }, 400);
    if (method === "iban" && !/^UA\d{27}$/.test(details.iban!)) return json({ error: "IBAN має вигляд UA і 27 цифр" }, 400);
    if (method === "card" && !/^\d{16,19}$/.test(details.card!)) return json({ error: "Номер картки - 16 цифр" }, 400);
    if (details.ipn && !/^\d{10}$/.test(details.ipn)) return json({ error: "ІПН - 10 цифр" }, 400);
    const points = Math.floor(Number(b.points));
    const sealed = await encrypt(details);
    const { data: p, error } = await db.rpc("affiliate_request_payout", { p_affiliate: a.id, p_points: points, p_details: sealed });
    if (error) return json({ error: rpcError(error) }, 400);
    await db.from("affiliates").update({ payout_details: sealed }).eq("id", a.id); // підставимо наступного разу
    await notifyManager([
      `💸 <b>Заявка на виплату</b> · ${escHtml(client.company)} (код ${escHtml(a.code)})`,
      `${points} балів = ${money(Number(p.amount_uah))}, ${method === "iban" ? "IBAN" : "картка"}`,
      `\n<a href="${SITE_URL}/affiliate-admin/#payouts">Відкрити в адмінці</a>`,
    ]);
    return json({ ok: true });
  }

  return json({ error: "unknown action" }, 400);
}

// ─── Адмін ────────────────────────────────────────────────────────────

async function log(adminId: string, action: string, target: string | null, details: unknown) {
  await db.from("affiliate_admin_log").insert({ admin_id: adminId, action, target, details });
}

const num = (v: unknown, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

async function admin(action: string, adminId: string, b: any) {
  if (action === "admin_overview") {
    await db.rpc("affiliate_approve_due");
    const [s, r, products, partners, comm, payouts, logRows] = await Promise.all([
      settings(), rates(), siteProducts().catch(() => new Map()),
      db.from("affiliates").select("id, code, status, custom_rate, created_at, client_id, b2b_clients(company, contact_name, phone, email, status)").order("created_at", { ascending: false }),
      db.from("affiliate_commissions").select("id, affiliate_id, created_at, approved_at, base_amount, commission_amount, status, source, comment, items_snapshot, orders(number, status, total)")
        .order("created_at", { ascending: false }).limit(2000),
      db.from("affiliate_payouts").select("id, affiliate_id, created_at, amount, amount_uah, status, admin_comment, processed_at").order("created_at", { ascending: false }),
      db.from("affiliate_admin_log").select("created_at, admin_id, action, target, details").order("created_at", { ascending: false }).limit(300),
    ]);
    const list = await Promise.all((partners.data ?? []).map(async (p: any) => ({ ...p, summary: await summary(p.id) })));
    const categories = [...new Set([...products.values()].map((p: any) => p.product_type).filter(Boolean))].sort();
    const { data: admins } = await db.from("tg_admins").select("user_id, email");
    return json({
      ok: true, settings: s, rates: r, categories, partners: list, commissions: comm.data ?? [], payouts: payouts.data ?? [],
      log: logRows.data ?? [], admins: Object.fromEntries((admins ?? []).map((x) => [x.user_id, x.email])),
      products: [...products.values()].map((p: any) => ({ id: String(p.id), title: p.title, category: p.product_type })),
    });
  }

  if (action === "admin_settings") {
    const i = b.settings ?? {};
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const ranges: Record<string, [number, number]> = {
      default_rate: [0, 100], cookie_days: [1, 365], hold_days: [0, 365], min_payout: [0, 1e7],
      max_points_share: [0, 100], point_value: [0.0001, 1e4], lifetime_days: [0, 3650],
    };
    for (const [k, [lo, hi]] of Object.entries(ranges)) {
      if (!(k in i)) continue;
      const n = num(i[k], lo, hi);
      if (n === null) return json({ error: `Невірне значення: ${k}` }, 400);
      patch[k] = ["cookie_days", "hold_days", "lifetime_days"].includes(k) ? Math.round(n) : n;
    }
    if ("enabled" in i) patch.enabled = !!i.enabled;
    if ("attribution" in i) patch.attribution = i.attribution === "first" ? "first" : "last";
    if ("rules_text" in i) patch.rules_text = text(i.rules_text, 20000);
    const { error } = await db.from("affiliate_settings").update(patch).eq("id", 1);
    if (error) return json({ error: error.message }, 500);

    if (Array.isArray(b.rates)) {
      const rows = b.rates
        .map((x: any) => ({ scope: x.scope === "product" ? "product" : "category", scope_id: text(x.scope_id, 200), rate: num(x.rate, 0, 100) }))
        .filter((x: any) => x.scope_id && x.rate !== null);
      const { error: e1 } = await db.from("affiliate_rates").delete().gte("id", 0);
      if (e1) return json({ error: e1.message }, 500);
      if (rows.length) {
        const { error: e2 } = await db.from("affiliate_rates").insert(rows);
        if (e2) return json({ error: e2.message }, 500);
      }
      patch.rates = rows;
    }
    await log(adminId, "settings", null, patch);
    return json({ ok: true });
  }

  if (action === "admin_partner") {
    const id = text(b.id, 40) ?? "";
    const patch: Record<string, unknown> = {};
    if (b.status) {
      if (!["active", "blocked"].includes(b.status)) return json({ error: "bad status" }, 400);
      patch.status = b.status;
    }
    if ("custom_rate" in b) {
      if (b.custom_rate === null || b.custom_rate === "") patch.custom_rate = null;
      else {
        const n = num(b.custom_rate, 0, 100);
        if (n === null) return json({ error: "Відсоток - від 0 до 100" }, 400);
        patch.custom_rate = n;
      }
    }
    const { error } = await db.from("affiliates").update(patch).eq("id", id);
    if (error) return json({ error: error.message }, 500);
    await log(adminId, "partner", id, patch);
    return json({ ok: true });
  }

  if (action === "admin_adjust") {
    const { data, error } = await db.rpc("affiliate_adjust", {
      p_affiliate: text(b.id, 40), p_points: Math.trunc(Number(b.points)) || 0, p_comment: text(b.comment, 500), p_admin: adminId,
    });
    if (error) return json({ error: rpcError(error) }, 400);
    return json({ ok: true, balance: data });
  }

  if (action === "admin_commission_status") {
    const { error } = await db.rpc("affiliate_set_commission_status", {
      p_commission: text(b.id, 40), p_status: text(b.status, 20), p_comment: text(b.comment, 500), p_admin: adminId,
    });
    if (error) return json({ error: rpcError(error) }, 400);
    return json({ ok: true });
  }

  if (action === "admin_assign") {
    const number = Math.trunc(Number(b.number));
    const code = text(b.code, 12)?.toUpperCase() ?? null;
    const { data: o } = await db.from("orders").select("id").eq("number", number).maybeSingle();
    if (!o) return json({ error: "Замовлення не знайдено" }, 400);
    const { data, error } = await db.rpc("affiliate_admin_set_order", {
      p_number: number, p_code: code, p_categories: code ? await categoriesFor(o.id) : {}, p_admin: adminId,
    });
    if (error) return json({ error: rpcError(error) }, 400);
    return json({ ok: true, result: data });
  }

  if (action === "admin_payout_details") {
    const { data: p } = await db.from("affiliate_payouts").select("id, details_snapshot").eq("id", text(b.id, 40) ?? "").maybeSingle();
    if (!p) return json({ error: "not found" }, 404);
    await log(adminId, "view_payout_details", p.id, null);
    return json({ ok: true, details: await decrypt(p.details_snapshot) });
  }

  if (action === "admin_payout") {
    const { error } = await db.rpc("affiliate_process_payout", {
      p_payout: text(b.id, 40), p_status: text(b.status, 20), p_comment: text(b.comment, 500), p_admin: adminId,
    });
    if (error) return json({ error: rpcError(error) }, 400);
    return json({ ok: true });
  }

  return json({ error: "unknown action" }, 400);
}

// ─── Хто викликає ─────────────────────────────────────────────────────

async function caller(req: Request) {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data } = await db.auth.getUser(token);
  return data?.user ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const action = String(b?.action ?? "");

  try {
    if (action === "terms") return json({ ok: true, terms: await publicTerms() });
    if (action === "click") return await click(req, b);

    const user = await caller(req);
    if (!user) return json({ error: "not signed in" }, 401);

    if (action.startsWith("admin_")) {
      const { data: isAdmin } = await db.from("tg_admins").select("user_id").eq("user_id", user.id).maybeSingle();
      if (!isAdmin) return json({ error: "not allowed" }, 403);
      return await admin(action, user.id, b);
    }

    if (user.app_metadata?.role !== "b2b") return json({ error: "not a b2b client" }, 403);
    const { data: client } = await db.from("b2b_clients").select("*").eq("user_id", user.id).maybeSingle();
    if (!client || client.status !== "approved") return json({ error: "not approved" }, 403);
    // Програму вмикає менеджер окремо для кожного клієнта (галочка в b2b-admin/).
    if (client.affiliate_enabled !== true) return json({ error: "Партнерська програма для вашого акаунта не підключена" }, 403);
    return await partnerAction(action, client, b);
  } catch (e) {
    console.error("affiliate:", action, e);
    return json({ error: "server error" }, 500);
  }
});
