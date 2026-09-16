/* auction.js - публічні сторінки аукціону (Supabase).
 *
 * Обслуговує дві сторінки:
 * - auction.html      (#auction-list)  - список активних лотів
 * - auction-lot.html  (#auction-lot)   - картка лота: галерея, ставки, таймер
 *
 * ⚠ Значення нижче мають збігатися з comments.js/admin.html/auction-admin.html -
 * той самий Supabase-проєкт, доступ розділяється RLS-політиками
 * (scripts/supabase/auction_schema.sql), а не окремими ключами.
 */
(function () {
  'use strict';

  const SUPABASE_URL = 'https://uvndubhmqzqqsrnrxgaj.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV2bmR1YmhtcXpxcXNybnJ4Z2FqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzNDY4MDIsImV4cCI6MjEwMzkyMjgwMn0.AavrYyhDXBQkjKOMdQ9wAQX6B901dOfUpmtUDwO5Cv8';
  const BIDDER_KEY = 'auction_bidder_id';

  function t(key, vars) {
    return window.I18n ? window.I18n.t(key, vars) : key;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtMoney(n) {
    return Math.round(Number(n) || 0).toLocaleString('uk-UA') + ' UAH';
  }

  function fmtCountdown(endsAt) {
    const diff = new Date(endsAt).getTime() - Date.now();
    if (diff <= 0) return t('auction.ended');
    const s = Math.floor(diff / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (d > 0) return `${d}д ${h}г ${m}хв ${sec}с`;
    if (h > 0) return `${h}г ${m}хв ${sec}с`;
    if (m > 0) return `${m}хв ${sec}с`;
    return `${sec}с`;
  }

  let client = null;
  function getClient() {
    if (client) return client;
    if (!window.supabase) return null;
    /* persistSession: false - публічна сторінка має завжди діяти як анонімний
       відвідувач, навіть якщо в цьому браузері одночасно залогінені в
       auction-admin.html (той самий origin ділить localStorage/сесію). */
    client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
    });
    return client;
  }

  /* ============================================================
   * Registration modal (shared by auction-lot.html)
   * ============================================================ */
  let regOverlay, regForm, regSubmitBtn, regErrorEl;
  let pendingAfterRegister = null;

  function buildRegModalHtml() {
    return `
    <div id="auction-reg-overlay" class="order-form-overlay hidden">
      <div class="order-form-modal" role="dialog" aria-modal="true" aria-labelledby="auction-reg-title">
        <button type="button" class="order-form-close" id="auction-reg-close" aria-label="Close">&times;</button>
        <h3 id="auction-reg-title">${escHtml(t('auction.register_title'))}</h3>
        <p class="order-form-product">${escHtml(t('auction.register_intro'))}</p>
        <form id="auction-reg-form">
          <div class="form-group">
            <label for="auction-reg-name">${escHtml(t('auction.register_name_label'))}</label>
            <input type="text" id="auction-reg-name" required autocomplete="name">
          </div>
          <div class="form-group">
            <label for="auction-reg-phone">${escHtml(t('auction.register_phone_label'))}</label>
            <input type="tel" id="auction-reg-phone" required autocomplete="tel" placeholder="+380 XX XXX XX XX">
          </div>
          <div class="form-group">
            <label for="auction-reg-email">${escHtml(t('auction.register_email_label'))}</label>
            <input type="email" id="auction-reg-email" autocomplete="email">
          </div>
          <div class="form-group form-group--consent">
            <label class="consent-label">
              <input type="checkbox" id="auction-reg-consent" required>
              <span>${t('auction.register_consent_html')}</span>
            </label>
          </div>
          <button type="submit" class="btn btn-primary btn-block" id="auction-reg-submit">${escHtml(t('auction.register_submit'))}</button>
        </form>
        <div id="auction-reg-error" class="order-form-state order-form-state--error hidden"></div>
      </div>
    </div>`;
  }

  function buildRegModal() {
    document.body.insertAdjacentHTML('beforeend', buildRegModalHtml());
    regOverlay   = document.getElementById('auction-reg-overlay');
    regForm      = document.getElementById('auction-reg-form');
    regSubmitBtn = document.getElementById('auction-reg-submit');
    regErrorEl   = document.getElementById('auction-reg-error');

    regOverlay.addEventListener('click', (e) => { if (e.target === regOverlay) closeRegModal(); });
    document.getElementById('auction-reg-close').addEventListener('click', closeRegModal);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !regOverlay.classList.contains('hidden')) closeRegModal();
    });
    regForm.addEventListener('submit', onRegisterSubmit);
  }

  function openRegModal(afterRegisterCb) {
    if (!regOverlay) buildRegModal();
    pendingAfterRegister = afterRegisterCb || null;
    regForm.reset();
    regErrorEl.classList.add('hidden');
    regSubmitBtn.disabled = false;
    regSubmitBtn.textContent = t('auction.register_submit');
    regOverlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    document.getElementById('auction-reg-name')?.focus();
  }

  function closeRegModal() {
    if (!regOverlay) return;
    regOverlay.classList.add('hidden');
    document.body.style.overflow = '';
  }

  async function onRegisterSubmit(e) {
    e.preventDefault();
    const sb = getClient();
    if (!sb) return;

    const name    = document.getElementById('auction-reg-name').value.trim();
    const phone   = document.getElementById('auction-reg-phone').value.trim();
    const email   = document.getElementById('auction-reg-email').value.trim();
    const consent = document.getElementById('auction-reg-consent').checked;
    if (!name || !phone || !consent) return;

    regSubmitBtn.disabled = true;
    regSubmitBtn.textContent = t('auction.register_sending');
    regErrorEl.classList.add('hidden');

    /* Anon не має SELECT-прав на auction_bidders (щоб ніхто не бачив чужі
       телефони), тож RETURNING після INSERT впаде на RLS. Генеруємо id
       на клієнті й вставляємо його явно - тоді сервер нічого повертати
       не мусить. */
    const bidderId = crypto.randomUUID();
    const { error } = await sb
      .from('auction_bidders')
      .insert({ id: bidderId, name, phone, email: email || null, consent: true });

    regSubmitBtn.disabled = false;
    regSubmitBtn.textContent = t('auction.register_submit');

    if (error) {
      console.warn('auction.js: не вдалося зареєструвати учасника', error);
      regErrorEl.textContent = t('auction.register_error');
      regErrorEl.classList.remove('hidden');
      return;
    }

    localStorage.setItem(BIDDER_KEY, bidderId);
    closeRegModal();
    if (pendingAfterRegister) {
      const cb = pendingAfterRegister;
      pendingAfterRegister = null;
      cb();
    }
  }

  function getBidderId() {
    return localStorage.getItem(BIDDER_KEY);
  }

  function ensureRegistered(cb) {
    const id = getBidderId();
    if (id) { cb(); return; }
    openRegModal(cb);
  }

  /* ============================================================
   * List page (#auction-list)
   * ============================================================ */
  function lotCardHtml(lot) {
    const ended = new Date(lot.ends_at).getTime() <= Date.now();
    const photo = (Array.isArray(lot.media) ? lot.media : []).find(m => m.type === 'photo');
    return `
    <a class="auction-card" href="auction-lot.html?id=${encodeURIComponent(lot.slug)}">
      <div class="auction-card__media">
        ${photo ? `<img src="${escHtml(photo.url)}" alt="${escHtml(lot.title)}" loading="lazy">` : ''}
        ${ended ? `<span class="auction-card__badge auction-card__badge--ended">${escHtml(t('auction.ended'))}</span>` : ''}
      </div>
      <div class="auction-card__body">
        <h3 class="auction-card__title">${escHtml(lot.title)}</h3>
        <div class="auction-card__price">${escHtml(t('auction.current_price'))}: <strong>${fmtMoney(lot.current_price)}</strong></div>
        <div class="auction-card__time">${escHtml(t('auction.time_left'))}: ${escHtml(fmtCountdown(lot.ends_at))}</div>
      </div>
    </a>`;
  }

  async function initList() {
    const listEl = document.getElementById('auction-list');
    const sb = getClient();
    if (!sb) { listEl.innerHTML = ''; return; }

    listEl.innerHTML = `<p class="auction-hint">${escHtml(t('auction.loading'))}</p>`;

    const { data, error } = await sb
      .from('auction_lots')
      .select('slug, title, media, current_price, ends_at')
      .eq('status', 'active')
      .order('ends_at', { ascending: true });

    if (error) {
      console.warn('auction.js: не вдалося завантажити лоти', error);
      listEl.innerHTML = '';
      return;
    }

    if (!data.length) {
      listEl.innerHTML = `<p class="auction-hint">${escHtml(t('auction.empty'))}</p>`;
      return;
    }

    listEl.innerHTML = `<div class="auction-grid">${data.map(lotCardHtml).join('')}</div>`;

    setInterval(() => {
      listEl.querySelectorAll('.auction-card__time').forEach((el, i) => {
        el.textContent = `${t('auction.time_left')}: ${fmtCountdown(data[i].ends_at)}`;
      });
    }, 1000);
  }

  /* ============================================================
   * Lot page (#auction-lot)
   * ============================================================ */
  function getLotSlug() {
    return new URLSearchParams(window.location.search).get('id');
  }

  /* ---- Gallery: big main photo + thumbs + swipe + lightbox ---- */
  let galleryMedia = [];
  let galleryIndex = 0;
  let lightboxOverlay = null;
  let lightboxOpen = false;

  function galleryItemHtml(m) {
    return m.type === 'video'
      ? `<video src="${escHtml(m.url)}" controls playsinline></video>`
      : `<img src="${escHtml(m.url)}" alt="" loading="lazy">`;
  }

  function mediaGalleryHtml(media) {
    galleryMedia = Array.isArray(media) ? media : [];
    if (!galleryMedia.length) return '';
    const multi = galleryMedia.length > 1;
    return `
    <div class="auction-gallery">
      <div class="auction-gallery__main" id="auction-gallery-main">
        ${galleryItemHtml(galleryMedia[0])}
        <button type="button" class="auction-gallery__zoom" id="auction-gallery-zoom" aria-label="${escHtml(t('auction.gallery_zoom'))}">⤢</button>
        ${multi ? `
          <button type="button" class="auction-gallery__nav auction-gallery__nav--prev" id="auction-gallery-prev" aria-label="${escHtml(t('auction.gallery_prev'))}">&#8249;</button>
          <button type="button" class="auction-gallery__nav auction-gallery__nav--next" id="auction-gallery-next" aria-label="${escHtml(t('auction.gallery_next'))}">&#8250;</button>
          <span class="auction-gallery__counter" id="auction-gallery-counter">1 / ${galleryMedia.length}</span>
        ` : ''}
      </div>
      ${multi ? `<div class="auction-gallery__thumbs" id="auction-gallery-thumbs">${galleryMedia.map((m, i) => `
        <button type="button" class="auction-gallery__thumb${i === 0 ? ' is-active' : ''}" data-index="${i}">
          ${m.type === 'video' ? `<video src="${escHtml(m.url)}" muted playsinline></video>` : `<img src="${escHtml(m.url)}" alt="" loading="lazy">`}
        </button>`).join('')}</div>` : ''}
    </div>`;
  }

  function attachSwipe(el, onLeft, onRight) {
    let startX = null;
    el.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
    el.addEventListener('touchend', (e) => {
      if (startX === null) return;
      const dx = e.changedTouches[0].clientX - startX;
      startX = null;
      if (Math.abs(dx) < 40) return;
      if (dx < 0) onLeft(); else onRight();
    }, { passive: true });
  }

  function showGalleryIndex(i) {
    const n = galleryMedia.length;
    if (!n) return;
    galleryIndex = ((i % n) + n) % n;
    const mainEl = document.getElementById('auction-gallery-main');
    if (mainEl) {
      const old = mainEl.querySelector('img, video');
      if (old) old.remove();
      mainEl.insertAdjacentHTML('afterbegin', galleryItemHtml(galleryMedia[galleryIndex]));
      const counter = document.getElementById('auction-gallery-counter');
      if (counter) counter.textContent = `${galleryIndex + 1} / ${n}`;
    }
    document.querySelectorAll('.auction-gallery__thumb').forEach((el, idx) =>
      el.classList.toggle('is-active', idx === galleryIndex));
    if (lightboxOpen) renderLightbox();
  }

  function renderLightbox() {
    const content = document.getElementById('auction-lightbox-content');
    content.innerHTML = galleryItemHtml(galleryMedia[galleryIndex]);
    const n = galleryMedia.length;
    document.getElementById('auction-lightbox-counter').textContent = n > 1 ? `${galleryIndex + 1} / ${n}` : '';
    document.getElementById('auction-lightbox-prev').classList.toggle('hidden', n <= 1);
    document.getElementById('auction-lightbox-next').classList.toggle('hidden', n <= 1);
  }

  function buildLightbox() {
    document.body.insertAdjacentHTML('beforeend', `
      <div id="auction-lightbox" class="auction-lightbox hidden">
        <button type="button" class="auction-lightbox__close" id="auction-lightbox-close" aria-label="Close">&times;</button>
        <button type="button" class="auction-lightbox__nav auction-lightbox__nav--prev" id="auction-lightbox-prev" aria-label="${escHtml(t('auction.gallery_prev'))}">&#8249;</button>
        <div class="auction-lightbox__content" id="auction-lightbox-content"></div>
        <button type="button" class="auction-lightbox__nav auction-lightbox__nav--next" id="auction-lightbox-next" aria-label="${escHtml(t('auction.gallery_next'))}">&#8250;</button>
        <span class="auction-lightbox__counter" id="auction-lightbox-counter"></span>
      </div>`);
    lightboxOverlay = document.getElementById('auction-lightbox');
    document.getElementById('auction-lightbox-close').addEventListener('click', closeLightbox);
    document.getElementById('auction-lightbox-prev').addEventListener('click', () => showGalleryIndex(galleryIndex - 1));
    document.getElementById('auction-lightbox-next').addEventListener('click', () => showGalleryIndex(galleryIndex + 1));
    lightboxOverlay.addEventListener('click', (e) => { if (e.target === lightboxOverlay) closeLightbox(); });
    document.addEventListener('keydown', (e) => {
      if (!lightboxOpen) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') showGalleryIndex(galleryIndex - 1);
      if (e.key === 'ArrowRight') showGalleryIndex(galleryIndex + 1);
    });
    attachSwipe(lightboxOverlay, () => showGalleryIndex(galleryIndex + 1), () => showGalleryIndex(galleryIndex - 1));
  }

  function openLightbox(index) {
    if (!lightboxOverlay) buildLightbox();
    galleryIndex = index;
    lightboxOpen = true;
    renderLightbox();
    lightboxOverlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    if (!lightboxOverlay) return;
    lightboxOpen = false;
    lightboxOverlay.classList.add('hidden');
    document.body.style.overflow = '';
    const v = lightboxOverlay.querySelector('video');
    if (v) v.pause();
  }

  function setupGallery() {
    if (!galleryMedia.length) return;
    galleryIndex = 0;
    const mainEl = document.getElementById('auction-gallery-main');
    document.getElementById('auction-gallery-prev')?.addEventListener('click', () => showGalleryIndex(galleryIndex - 1));
    document.getElementById('auction-gallery-next')?.addEventListener('click', () => showGalleryIndex(galleryIndex + 1));
    document.getElementById('auction-gallery-zoom')?.addEventListener('click', () => openLightbox(galleryIndex));
    document.querySelectorAll('.auction-gallery__thumb').forEach(btn =>
      btn.addEventListener('click', () => showGalleryIndex(Number(btn.dataset.index))));
    mainEl.addEventListener('click', (e) => {
      if (e.target.closest('.auction-gallery__nav, .auction-gallery__zoom, video')) return;
      openLightbox(galleryIndex);
    });
    attachSwipe(mainEl, () => showGalleryIndex(galleryIndex + 1), () => showGalleryIndex(galleryIndex - 1));
  }

  function bidRowHtml(b) {
    return `
    <div class="auction-bid-row">
      <span>${escHtml(b.display_name)}</span>
      <span class="auction-bid-row__amount">${fmtMoney(b.amount)}</span>
      <span class="auction-bid-row__time">${escHtml(new Date(b.created_at).toLocaleString(window.I18n ? window.I18n.dateLocale : 'uk-UA'))}</span>
    </div>`;
  }

  let currentLot = null;
  let bidTimer = null;
  let pollTimer = null;

  function renderLotPrice() {
    document.getElementById('auction-current-price').textContent = fmtMoney(currentLot.current_price);
    document.getElementById('auction-bid-step').textContent = fmtMoney(currentLot.bid_step);
    const amountInput = document.getElementById('auction-bid-amount');
    if (amountInput && document.activeElement !== amountInput) {
      amountInput.min = Number(currentLot.current_price) + Number(currentLot.bid_step);
      amountInput.value = amountInput.min;
    }
  }

  function renderCountdown() {
    const el = document.getElementById('auction-time-left');
    if (!el || !currentLot) return;
    el.textContent = fmtCountdown(currentLot.ends_at);
    const isOver = new Date(currentLot.ends_at).getTime() <= Date.now() || currentLot.status !== 'active';
    const form = document.getElementById('auction-bid-form');
    if (form) form.querySelector('button[type="submit"]').disabled = isOver;
  }

  async function loadBids(sb, lotId) {
    const el = document.getElementById('auction-bids-list');
    const { data, error } = await sb
      .from('auction_bids')
      .select('display_name, amount, created_at')
      .eq('lot_id', lotId)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) { console.warn('auction.js: не вдалося завантажити ставки', error); return; }
    el.innerHTML = data.length
      ? data.map(bidRowHtml).join('')
      : `<p class="auction-hint">${escHtml(t('auction.no_bids'))}</p>`;

    const leaderEl = document.getElementById('auction-leader-name');
    if (leaderEl) leaderEl.textContent = data.length ? `${t('auction.leader')}: ${data[0].display_name}` : '';
  }

  async function refreshLotAndBids(sb, slug) {
    const { data: lot, error } = await sb.from('auction_lots').select('*').eq('slug', slug).single();
    if (error || !lot) return;
    currentLot = lot;
    renderLotPrice();
    renderCountdown();
    await loadBids(sb, lot.id);
  }

  function showBidMsg(msg, type) {
    const el = document.getElementById('auction-bid-msg');
    el.textContent = msg;
    el.className = 'auction-bid-msg' + (type ? ' auction-bid-msg--' + type : '');
  }

  const BID_ERROR_KEYS = {
    bid_too_low: 'auction.bid_too_low',
    lot_ended: 'auction.bid_ended',
    lot_not_active: 'auction.bid_not_active',
  };

  async function placeBid(sb, amount) {
    const submitBtn = document.querySelector('#auction-bid-form button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.dataset.originalText = submitBtn.dataset.originalText || submitBtn.textContent;
    submitBtn.textContent = t('auction.bid_sending');
    showBidMsg('', '');

    const { data, error } = await sb.rpc('place_bid', {
      p_lot_id: currentLot.id,
      p_bidder_id: getBidderId(),
      p_amount: amount,
    });

    submitBtn.disabled = false;
    submitBtn.textContent = submitBtn.dataset.originalText;

    if (error) {
      console.warn('auction.js: не вдалося поставити ставку', error);
      const key = BID_ERROR_KEYS[error.message] || 'auction.bid_error_generic';
      showBidMsg(t(key), 'error');
      if (error.message === 'unknown_bidder') localStorage.removeItem(BIDDER_KEY);
      return;
    }

    currentLot = data;
    renderLotPrice();
    renderCountdown();
    showBidMsg(t('auction.bid_success'), 'success');
    await loadBids(sb, currentLot.id);
  }

  function subscribeRealtime(sb, lotId, slug) {
    let usingRealtime = false;
    const channel = sb
      .channel('auction-lot-' + lotId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'auction_bids', filter: `lot_id=eq.${lotId}` },
        () => refreshLotAndBids(sb, slug))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'auction_lots', filter: `id=eq.${lotId}` },
        () => refreshLotAndBids(sb, slug))
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') usingRealtime = true;
      });

    // Fallback: якщо Realtime за 4с не підключився (або відпав), тримаємо polling.
    setTimeout(() => {
      if (!usingRealtime && !pollTimer) {
        pollTimer = setInterval(() => refreshLotAndBids(sb, slug), 5000);
      }
    }, 4000);

    return channel;
  }

  async function initLot() {
    const root = document.getElementById('auction-lot');
    const sb = getClient();
    const slug = getLotSlug();
    if (!sb || !slug) { root.innerHTML = `<p class="auction-hint">${escHtml(t('auction.not_found'))}</p>`; return; }

    const { data: lot, error } = await sb.from('auction_lots').select('*').eq('slug', slug).single();
    if (error || !lot) {
      root.innerHTML = `<p class="auction-hint">${escHtml(t('auction.not_found'))}</p>`;
      return;
    }
    currentLot = lot;

    root.innerHTML = `
      <h1 class="auction-lot__title">${escHtml(lot.title)}</h1>

      <div class="auction-lot__stats">
        <div><span>${escHtml(t('auction.starting_price'))}</span><strong>${fmtMoney(lot.starting_price)}</strong></div>
        <div><span>${escHtml(t('auction.current_price'))}</span><strong id="auction-current-price">${fmtMoney(lot.current_price)}</strong><em id="auction-leader-name" class="auction-lot__leader"></em></div>
        <div><span>${escHtml(t('auction.bid_step'))}</span><strong id="auction-bid-step">${fmtMoney(lot.bid_step)}</strong></div>
        <div><span>${escHtml(t('auction.time_left'))}</span><strong id="auction-time-left">${escHtml(fmtCountdown(lot.ends_at))}</strong></div>
      </div>

      ${mediaGalleryHtml(lot.media)}
      ${lot.description ? `<p class="auction-lot__description">${escHtml(lot.description)}</p>` : ''}
      ${lot.condition_note ? `
        <div class="auction-lot__condition">
          <h2>${escHtml(t('auction.condition_title'))}</h2>
          <p>${escHtml(lot.condition_note)}</p>
        </div>` : ''}

      <form id="auction-bid-form" class="auction-bid-form">
        <label for="auction-bid-amount">${escHtml(t('auction.bid_amount_label'))}</label>
        <div class="auction-bid-form__row">
          <input type="number" id="auction-bid-amount" min="${Number(lot.current_price) + Number(lot.bid_step)}" step="1" value="${Number(lot.current_price) + Number(lot.bid_step)}" required>
          <button type="submit" class="btn btn-primary">${escHtml(t('auction.bid_submit'))}</button>
        </div>
        <p id="auction-bid-msg" class="auction-bid-msg" role="status"></p>
      </form>

      <div class="auction-lot__bids">
        <h2>${escHtml(t('auction.bids_history'))}</h2>
        <div id="auction-bids-list"></div>
      </div>`;

    document.getElementById('auction-bid-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const amount = Number(document.getElementById('auction-bid-amount').value);
      if (!amount) return;
      ensureRegistered(() => placeBid(sb, amount));
    });

    setupGallery();
    renderCountdown();
    bidTimer = setInterval(renderCountdown, 1000);
    await loadBids(sb, lot.id);
    subscribeRealtime(sb, lot.id, slug);
  }

  function init() {
    if (document.getElementById('auction-list')) initList();
    if (document.getElementById('auction-lot')) initLot();
  }

  if (window.I18n) {
    init();
  } else {
    document.addEventListener('i18n:ready', init);
  }
})();
