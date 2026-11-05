/* blog.js - завантаження та рендер постів Telegram */

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len).trimEnd() + '…' : str;
}

function t(key) {
  return window.I18n ? window.I18n.t(key) : key;
}

/* ---- Blog page: full Telegram-style post ---- */
function renderPostFull(post) {
  const dateStr = post.date
    ? new Date(post.date).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  const imgHtml = post.photo
    ? `<div class="tg-post__img"><img src="${escHtml(post.photo)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
    : '';

  return `
  <article class="tg-post">
    <div class="tg-post__header">
      <img src="assets/images/logo.jpg" alt="Автономка" class="tg-post__avatar">
      <div class="tg-post__meta">
        <span class="tg-post__channel">Автономка</span>
        ${dateStr ? `<span class="tg-post__date">${escHtml(dateStr)}</span>` : ''}
      </div>
    </div>
    ${imgHtml}
    ${post.text ? `<div class="tg-post__text">${escHtml(post.text)}</div>` : ''}
    <div class="tg-post__footer">
      <a href="${escHtml(post.url || 'https://telegram.me/avtonomka_od')}"
         target="_blank" rel="noopener noreferrer"
         class="tg-post__link">${escHtml(t('blog.view_link'))}</a>
    </div>
  </article>`;
}

/* ---- Home page preview card (compact) ---- */
function renderCard(post) {
  const dateStr = post.date
    ? new Date(post.date).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';
  const imgHtml = post.photo
    ? `<div class="blog-card__img"><img src="${escHtml(post.photo)}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'"></div>`
    : '';
  const shortText = truncate(post.text || '', 160);

  return `
  <div class="blog-card">
    ${imgHtml}
    <div class="blog-card__body">
      ${dateStr ? `<div class="blog-card__date">${escHtml(dateStr)}</div>` : ''}
      <div class="blog-card__text">${escHtml(shortText)}</div>
      <a href="${escHtml(post.url || 'https://telegram.me/avtonomka_od')}"
         target="_blank" rel="noopener noreferrer"
         class="blog-card__link">${escHtml(t('home.read_more'))}</a>
    </div>
  </div>`;
}

/* ---- Blog page init ---- */
async function init() {
  const grid = document.getElementById('blog-grid');
  if (!grid) return;

  showLoading(grid);

  try {
    const resp = await fetch('data/telegram_posts.json');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const posts = await resp.json();

    if (!Array.isArray(posts) || posts.length === 0) {
      showEmpty(grid);
      return;
    }

    grid.innerHTML = posts.map(renderPostFull).join('');
  } catch (e) {
    showError(grid);
    console.error('Помилка завантаження telegram_posts.json:', e);
  }
}

/* ---- Home page: 2 latest posts ---- */
async function initHomePreview() {
  const grid = document.getElementById('home-blog-grid');
  if (!grid) return;

  try {
    const resp  = await fetch('data/telegram_posts.json');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const posts = await resp.json();
    const latest = (Array.isArray(posts) ? posts : []).slice(0, 2);

    if (latest.length === 0) {
      grid.innerHTML = '<p class="text-muted">Новини незабаром з\'являться.</p>';
      return;
    }
    grid.innerHTML = latest.map(renderCard).join('');
  } catch {
    grid.innerHTML = '<p class="text-muted">Не вдалося завантажити новини.</p>';
  }
}

function showLoading(grid) {
  grid.innerHTML = `
    <div class="loading-state">
      <div class="spinner"></div>
      <span>Завантаження новин…</span>
    </div>`;
}

function showEmpty(grid) {
  grid.innerHTML = `
    <div class="empty-state">
      <h3>${escHtml(t('blog.empty_title'))}</h3>
      <p>${escHtml(t('blog.empty_text'))}</p>
      <a href="https://telegram.me/avtonomka_od" target="_blank" rel="noopener" class="btn btn-tg">
        ${escHtml(t('blog.subscribe'))}
      </a>
    </div>`;
}

function showError(grid) {
  grid.innerHTML = `
    <div class="empty-state">
      <h3>${escHtml(t('blog.error_title'))}</h3>
      <p>${escHtml(t('blog.error_text'))}</p>
      <a href="https://telegram.me/avtonomka_od" target="_blank" rel="noopener" class="btn btn-tg">
        ${escHtml(t('blog.error_button'))}
      </a>
    </div>`;
}

/* ---- Start (wait for i18n so renderPostFull/showEmpty/showError get
   real translations instead of raw keys) ---- */
function start() {
  init();
  initHomePreview();
}
if (window.I18n) {
  start();
} else {
  document.addEventListener('i18n:ready', start);
}
