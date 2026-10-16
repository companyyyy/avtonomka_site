/**
 * order-form.js - модальна форма швидкої заявки на товар (без оплати онлайн).
 *
 * Надсилає заявку через window.Orders (assets/js/cart.js - має бути підключений
 * раніше): у Supabase (розділ «Замовлення» адмінки, джерело «Швидка заявка»)
 * і запасну копію в Google Таблиці (scripts/order_form_apps_script.gs).
 *
 * Тригер - елемент з атрибутом data-order-form-trigger, напр.:
 *    <button data-order-form-trigger data-product="Назва товару">Замовити</button>
 * Якщо data-product не вказано, а на сторінці є #product-title - назва
 * товару підтягнеться звідти автоматично.
 */

(function () {
  'use strict';

  /* Сторінки в /product/ та /catalog/ лежать на рівень глибше кореня сайту */
  function getBase() {
    const path = window.location.pathname;
    const depth = path.split('/').length - 2;
    return depth >= 1 && (path.includes('/catalog/') || path.includes('/product/')) ? '../' : '';
  }
  const BASE = getBase();

  function t(key, vars) {
    return window.I18n ? window.I18n.t(key, vars) : key;
  }

  /* Built lazily inside buildModal() (only called on the first "Замовити"
     click, well after i18n has loaded) rather than as a top-level const, so
     t() has real translations by the time this runs instead of the module
     evaluating it eagerly before window.I18n exists. */
  function buildModalHtml() {
    return `
    <div id="order-form-overlay" class="order-form-overlay hidden">
      <div class="order-form-modal" role="dialog" aria-modal="true" aria-labelledby="order-form-title">
        <button type="button" class="order-form-close" aria-label="${t('order_form.close_aria')}">&times;</button>
        <h3 id="order-form-title">${t('order_form.title')}</h3>
        <p class="order-form-product" id="order-form-product-label"></p>

        <form id="order-form">
          <div class="form-group">
            <label for="order-name">${t('order_form.name_label')}</label>
            <input type="text" id="order-name" name="name" required autocomplete="name">
          </div>
          <div class="form-group">
            <label for="order-phone">${t('order_form.phone_label')}</label>
            <input type="tel" id="order-phone" name="phone" required autocomplete="tel" placeholder="+380 XX XXX XX XX">
          </div>
          <input type="hidden" id="order-product" name="product">
          <div class="form-group">
            <label for="order-comment">${t('order_form.comment_label')}</label>
            <textarea id="order-comment" name="comment" rows="3" placeholder="${t('order_form.comment_placeholder')}"></textarea>
          </div>
          <div class="form-group form-group--consent">
            <label class="consent-label">
              <input type="checkbox" id="order-consent" name="consent" required>
              <span>${t('order_form.consent_html', { base: BASE })}</span>
            </label>
          </div>
          <button type="submit" class="btn btn-primary btn-block" id="order-form-submit">${t('order_form.submit')}</button>
        </form>

        <div id="order-form-success" class="order-form-state hidden">${t('order_form.success_html')}</div>
        <div id="order-form-error" class="order-form-state order-form-state--error hidden">${t('order_form.error_html')}</div>
      </div>
    </div>`;
  }

  let overlay, form, productLabel, productInput, submitBtn, successBlock, errorBlock;

  function buildModal() {
    document.body.insertAdjacentHTML('beforeend', buildModalHtml());
    overlay      = document.getElementById('order-form-overlay');
    form         = document.getElementById('order-form');
    productLabel = document.getElementById('order-form-product-label');
    productInput = document.getElementById('order-product');
    submitBtn    = document.getElementById('order-form-submit');
    successBlock = document.getElementById('order-form-success');
    errorBlock   = document.getElementById('order-form-error');

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
    overlay.querySelector('.order-form-close').addEventListener('click', close);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) close();
    });
    form.addEventListener('submit', onSubmit);
  }

  function open(productTitle) {
    if (!overlay) buildModal();

    form.reset();
    form.classList.remove('hidden');
    successBlock.classList.add('hidden');
    errorBlock.classList.add('hidden');
    submitBtn.disabled = false;
    submitBtn.textContent = t('order_form.submit');

    const title = productTitle || '';
    productInput.value = title;
    productLabel.textContent = title ? t('order_form.product_label', { title }) : '';
    productLabel.classList.toggle('hidden', !title);

    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    document.getElementById('order-name')?.focus();
  }

  function close() {
    if (!overlay) return;
    overlay.classList.add('hidden');
    document.body.style.overflow = '';
  }

  // Ключ заявки живе до успішного надсилання: повтор після помилки не створить дубль.
  let orderKey = null;

  function onSubmit(e) {
    e.preventDefault();

    submitBtn.disabled = true;
    submitBtn.textContent = t('order_form.submitting');

    const data = new URLSearchParams({
      name:    form.name.value.trim(),
      phone:   form.phone.value.trim(),
      product: form.product.value.trim(),
      comment: form.comment.value.trim(),
      source:  'Сайт'
    });

    /* Товар зі сторінки товару (кнопка «В кошик» має id, ціну й артикул),
       якщо заявка саме на нього. */
    const title = form.product.value.trim();
    const btn = document.querySelector('[data-add-to-cart][data-id]');
    const fromPage = btn && (!title || btn.getAttribute('data-title') === title);
    orderKey = orderKey || window.Orders.newKey();
    const order = {
      client_key: orderKey,
      source:     'Швидка заявка',
      name:       form.name.value.trim(),
      phone:      form.phone.value.trim(),
      comment:    form.comment.value.trim(),
      items: [{
        product_id: fromPage ? btn.getAttribute('data-id') : '',
        title:      title || (fromPage ? btn.getAttribute('data-title') : '') || 'Без товару',
        sku:        fromPage ? btn.getAttribute('data-sku') || '' : '',
        qty:        1,
        price:      fromPage ? btn.getAttribute('data-price') : ''
      }]
    };

    /* Supabase (розділ «Замовлення» адмінки) + запасна копія в Google
       Таблиці - window.Orders з assets/js/cart.js. */
    window.Orders.submit(order, data)
      .then(function (res) {
        orderKey = null;
        if (res.number) {
          const num = document.createElement('p');
          num.className = 'order-number';
          const label = t('order_form.order_number', { number: res.number });
          // Старий закешований файл перекладів без цього ключа
          num.textContent = label === 'order_form.order_number' ? 'Номер заявки: №' + res.number : label;
          successBlock.append(num);
        }
        showSuccess();
      })
      .catch(function (err) {
        console.error('order-form.js: помилка надсилання', err);
        showError();
      });
  }

  function showSuccess() {
    form.classList.add('hidden');
    successBlock.classList.remove('hidden');
  }

  function showError() {
    submitBtn.disabled = false;
    submitBtn.textContent = t('order_form.submit');
    errorBlock.classList.remove('hidden');
  }

  function wireTriggers() {
    document.querySelectorAll('[data-order-form-trigger]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        const explicit = btn.getAttribute('data-product');
        const fallback = document.getElementById('product-title');
        const title = explicit || (fallback ? fallback.textContent.trim() : '');
        open(title);
      });
    });
  }

  window.OrderForm = { open: open, close: close };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireTriggers);
  } else {
    wireTriggers();
  }
})();
