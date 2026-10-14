/* admin-shell.js - спільна шапка, меню й вхід для всіх сторінок адмінки:
   admin.html (контент), miniapp-admin.html, miniapp-mailing.html,
   auction-admin.html, prom-admin/, preorder-admin/.

   Один вхід - користувач Supabase Auth (email + пароль). Сесію supabase-js
   тримає в localStorage цього домену, тож увійти достатньо на будь-якій
   сторінці адмінки - решта вже відкриваються залогіненими.

   Підключення на сторінці (після supabase-js, до власного скрипта сторінки):
     <body data-admin-section="content|miniapp|mailing|auction|prom|preorder">
       <div id="admin-app" hidden> ...вміст розділу... </div>
       <script src=".../supabase.js"></script>
       <script src=".../assets/js/admin-shell.js"></script>
       <script> AdminShell.ready(session => { ...завантажити дані... }); </script>
   Клієнт Supabase для запитів сторінки - AdminShell.sb.

   ⚠ SUPABASE_URL / ключ - ті самі, що в assets/js/comments.js,
   assets/js/articles.js, index.html і scripts/generate_static_pages.js.
   Як скинути пароль чи додати адміна - docs/ADMIN.md. */
(function () {
  const SUPABASE_URL = 'https://uvndubhmqzqqsrnrxgaj.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2bmR1YmhtcXpxcXNybnJ4Z2FqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzNDY4MDIsImV4cCI6MjEwMzkyMjgwMn0.AavrYyhDXBQkjKOMdQ9wAQX6B901dOfUpmtUDwO5Cv8';

  // Корінь сайту - від адреси самого скрипта (assets/js/ → ../../), щоб
  // посилання працювали і з prom-admin/, і з копії сайту в підпапці.
  const ROOT = new URL('../../', document.currentScript.src).href;
  const SECTIONS = [
    ['content', 'Контент', 'admin.html'],
    ['miniapp', 'Мініапп', 'miniapp-admin.html'],
    ['mailing', 'Розсилка', 'miniapp-mailing.html'],
    ['auction', 'Аукціон', 'auction-admin.html'],
    ['prom', 'Ціни Prom', 'prom-admin/'],
    ['preorder', 'Під замовлення', 'preorder-admin/'],
  ];

  const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const current = document.body.dataset.adminSection;
  const app = document.getElementById('admin-app');

  const style = document.createElement('style');
  style.textContent = `
    :root { --ash-h: 58px; }
    .ash-header { position: sticky; top: 0; z-index: 50; height: var(--ash-h); background: #1a2e4a; color: #fff;
      display: flex; align-items: center; gap: 18px; padding: 0 20px; box-shadow: 0 2px 12px rgba(0,0,0,.25);
      font-family: 'Segoe UI', Arial, sans-serif; }
    .ash-logo { display: flex; align-items: center; gap: 9px; color: #2ecc40; font-weight: 800; font-size: 1.02rem; text-decoration: none; flex-shrink: 0; }
    .ash-logo img { width: 34px; height: 34px; border-radius: 5px; object-fit: contain; background: #fff; }
    .ash-nav { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; flex: 1; min-width: 0; }
    .ash-nav::-webkit-scrollbar { display: none; }
    .ash-nav a { color: rgba(255,255,255,.75); text-decoration: none; padding: 7px 13px; border-radius: 7px; font-size: .9rem; font-weight: 600; white-space: nowrap; }
    .ash-nav a:hover { background: rgba(255,255,255,.1); color: #fff; }
    .ash-nav a.active { background: #f5a623; color: #1a2e4a; }
    .ash-user { display: flex; align-items: center; gap: 10px; flex-shrink: 0; font-size: .84rem; }
    .ash-email { color: rgba(255,255,255,.65); }
    .ash-btn { background: rgba(255,255,255,.1); color: #fff; border: none; border-radius: 7px; padding: 7px 13px; font: 600 .86rem 'Segoe UI', Arial, sans-serif; cursor: pointer; text-decoration: none; white-space: nowrap; }
    .ash-btn:hover { background: rgba(255,255,255,.2); }
    .ash-login { max-width: 420px; margin: 48px auto; padding: 0 16px; font-family: 'Segoe UI', Arial, sans-serif; }
    .ash-login form { background: #fff; color: #222831; border-radius: 12px; box-shadow: 0 4px 24px rgba(26,46,74,.12); padding: 32px 28px; }
    .ash-login h1 { font-size: 1.25rem; color: #1a2e4a; margin: 0 0 6px; }
    .ash-login p { font-size: .86rem; color: #6c757d; margin: 0 0 20px; line-height: 1.5; }
    .ash-login label { display: block; font-size: .78rem; font-weight: 600; color: #6c757d; text-transform: uppercase; letter-spacing: .05em; margin: 0 0 6px; }
    .ash-login input { width: 100%; box-sizing: border-box; padding: 10px 14px; border: 2px solid #e0e6ed; border-radius: 8px; font: .95rem 'Segoe UI', Arial, sans-serif; margin: 0 0 16px; outline: none; background: #fff; color: #222831; }
    .ash-login input:focus { border-color: #f5a623; }
    .ash-login button { width: 100%; padding: 12px; background: #f5a623; color: #1a2e4a; border: none; border-radius: 8px; font: 700 1rem 'Segoe UI', Arial, sans-serif; cursor: pointer; }
    .ash-login button:hover { background: #e0921a; }
    .ash-login .ash-msg { color: #e74c3c; font-size: .85rem; min-height: 20px; margin: 10px 0 0; }
    .ash-login .ash-forgot { margin: 16px 0 0; font-size: .8rem; }
    @media (max-width: 760px) {
      .ash-header { gap: 10px; padding: 0 10px; }
      .ash-logo span, .ash-email, .ash-site { display: none; }
      .ash-nav a { padding: 7px 10px; font-size: .85rem; }
    }`;
  document.head.append(style);

  const header = document.createElement('header');
  header.className = 'ash-header';
  header.innerHTML = `
    <a class="ash-logo" href="${ROOT}admin.html"><img src="${ROOT}assets/images/logo.jpg" alt=""><span>Автономка</span></a>
    <nav class="ash-nav">${SECTIONS.map(([id, label, href]) =>
      `<a href="${ROOT}${href}"${id === current ? ' class="active" aria-current="page"' : ''}>${label}</a>`).join('')}</nav>
    <div class="ash-user">
      <span class="ash-email" id="ash-email"></span>
      <a class="ash-btn ash-site" href="${ROOT}" target="_blank" rel="noopener">Сайт ↗</a>
      <button type="button" class="ash-btn" id="ash-logout" hidden>Вийти</button>
    </div>`;

  const login = document.createElement('div');
  login.className = 'ash-login';
  login.hidden = true;
  login.innerHTML = `
    <form id="ash-login-form">
      <h1>Вхід в адмінку</h1>
      <p>Один вхід для всіх розділів: контент, мініапп, розсилка, аукціон, ціни Prom.</p>
      <label for="ash-login-email">Email</label>
      <input type="email" id="ash-login-email" autocomplete="username" required>
      <label for="ash-login-password">Пароль</label>
      <input type="password" id="ash-login-password" autocomplete="current-password" required>
      <button type="submit">Увійти</button>
      <div class="ash-msg" id="ash-login-msg"></div>
      <p class="ash-forgot">Забули пароль? Новий задається в Supabase → SQL Editor, інструкція - docs/ADMIN.md у репозиторії сайту.</p>
    </form>`;

  document.body.prepend(header, login);

  let session = null;
  const waiting = [];

  function show(s) {
    session = s;
    document.getElementById('ash-logout').hidden = !s;
    document.getElementById('ash-email').textContent = s ? s.user.email : '';
    login.hidden = !!s;
    if (app) app.hidden = !s;
    if (s) waiting.splice(0).forEach(cb => cb(s));
  }

  document.getElementById('ash-login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = document.getElementById('ash-login-msg');
    msg.textContent = '';
    const { data, error } = await sb.auth.signInWithPassword({
      email: document.getElementById('ash-login-email').value.trim(),
      password: document.getElementById('ash-login-password').value,
    });
    if (error) {
      msg.textContent = error.message === 'Invalid login credentials' ? 'Невірний email або пароль' : error.message;
      return;
    }
    document.getElementById('ash-login-password').value = '';
    show(data.session);
  });

  // Після виходу сторінка перезавантажується - так з неї гарантовано зникають
  // дані, завантажені під попереднім користувачем.
  document.getElementById('ash-logout').addEventListener('click', async () => {
    await sb.auth.signOut();
    location.reload();
  });
  sb.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_OUT' && session) location.reload();
  });

  sb.auth.getSession().then(({ data }) => show(data.session));

  window.AdminShell = {
    sb,
    // cb(session) - одразу, якщо вже увійшли, або після входу.
    ready(cb) { if (session) cb(session); else waiting.push(cb); },
  };
})();
