(function () {
  'use strict';

  const CART_KEY = 'suveraCart';
  let checkoutShipping = 0;

  function loadCart() {
    try {
      return JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    } catch (_) {
      return [];
    }
  }

  function saveCart(cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    updateCartDots(cart);
  }

  function updateCartDots(cart) {
    const total = cart.reduce((sum, item) => sum + Number(item.qty || 0), 0);
    document.querySelectorAll('.cart-dot, #cartCount').forEach((el) => {
      el.textContent = total || '0';
    });
  }

  function money(value) {
    return Number(value || 0).toLocaleString('tr-TR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + ' TL';
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    }[char]));
  }

  function cartSubtotal(cart) {
    return cart.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.qty || 1), 0);
  }

  function itemVisual(item, className) {
    if (item.image) {
      const src = window.SuveraAPI ? window.SuveraAPI.assetUrl(item.image) : item.image;
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(item.name)}" style="width:100%;height:100%;object-fit:cover;"/>`;
    }
    return escapeHtml(item.emoji || '👗');
  }

  function renderCartPage() {
    const container = document.getElementById('cartItems');
    if (!container) return;

    const cart = loadCart();
    const subtotal = cartSubtotal(cart);
    const pageCount = document.querySelector('.page-count');

    if (pageCount) {
      const qty = cart.reduce((sum, item) => sum + Number(item.qty || 1), 0);
      pageCount.textContent = `(${qty} Ürün)`;
    }

    if (!cart.length) {
      container.innerHTML = '<p style="padding:40px 0;text-align:center;color:#aaa;font-size:20px">Sepetiniz boş.</p>';
    } else {
      container.innerHTML = cart.map((item, index) => {
        const qty = Number(item.qty || 1);
        const price = Number(item.price || 0);
        return `
          <div class="cart-item" data-index="${index}">
            <div class="cart-item-img">${itemVisual(item)}</div>
            <div class="cart-item-body">
              <p class="cart-item-brand">Suvera</p>
              <h3 class="cart-item-name">${escapeHtml(item.name || 'Ürün')}</h3>
              <p class="cart-item-variant">${escapeHtml(item.variant || item.size || 'Standart')}</p>
              <p class="cart-item-unit">Birim Fiyatı: ${money(price)}</p>
              <div class="qty-row">
                <button class="qty-btn" onclick="changeQty(${index},-1)">−</button>
                <span class="qty-num">${qty}</span>
                <button class="qty-btn" onclick="changeQty(${index},1)">+</button>
                <button class="del-btn" onclick="removeCartItem(${index})">🗑</button>
              </div>
            </div>
            <div class="cart-item-price">
              <strong>${money(price * qty)}</strong>
              <small>Toplam</small>
            </div>
          </div>`;
      }).join('');
    }

    const subtotalEl = document.getElementById('subtotal');
    const totalEl = document.getElementById('total');
    if (subtotalEl) subtotalEl.textContent = money(subtotal);
    if (totalEl) totalEl.textContent = money(subtotal);
    updateCartDots(cart);
  }

  function renderCheckoutPage() {
    const summary = document.querySelector('.checkout-summary');
    if (!summary) return;

    const cart = loadCart();
    const subtotal = cartSubtotal(cart);
    const items = cart.length ? cart.map((item) => {
      const qty = Number(item.qty || 1);
      const price = Number(item.price || 0);
      return `
        <div class="order-item">
          <div class="order-item-img">
            ${itemVisual(item)}
            <span class="order-qty-badge">${qty}</span>
          </div>
          <div class="order-item-info">
            <h5>${escapeHtml(item.name || 'Ürün')}</h5>
            <p>${escapeHtml(item.variant || item.size || 'Standart')}</p>
          </div>
          <span class="order-item-price">${money(price * qty)}</span>
        </div>`;
    }).join('') : '<p style="padding:20px 0;color:#888">Sepetiniz boş.</p>';

    summary.querySelectorAll('.order-item').forEach((el) => el.remove());
    const coupon = summary.querySelector('.coupon-row');
    if (coupon) coupon.insertAdjacentHTML('beforebegin', items);

    updateCheckoutTotals(subtotal);
    updateCartDots(cart);
  }

  function updateCheckoutTotals(subtotal = cartSubtotal(loadCart())) {
    const total = subtotal + checkoutShipping;
    const summaryRows = document.querySelectorAll('.checkout-summary .summary-row');
    const productTotal = summaryRows[0]?.querySelector('strong');
    const shippingCost = document.getElementById('shippingCost');
    const grandTotal = document.getElementById('grandTotal');
    const payAmountBtn = document.getElementById('payAmountBtn');

    if (productTotal) productTotal.textContent = money(subtotal);
    if (shippingCost) {
      shippingCost.textContent = checkoutShipping ? money(checkoutShipping) : 'Ücretsiz';
      shippingCost.style.color = checkoutShipping ? 'var(--black)' : '#4a7c59';
    }
    if (grandTotal) grandTotal.textContent = money(total);
    if (payAmountBtn) payAmountBtn.textContent = money(total) + ' ÖDE';
  }

  window.changeQty = function (indexOrBtn, delta) {
    const cart = loadCart();
    let index = Number(indexOrBtn);
    if (!Number.isInteger(index)) {
      const row = indexOrBtn.closest('.cart-item');
      index = Number(row?.dataset.index || 0);
    }
    if (!cart[index]) return;
    cart[index].qty = Math.max(1, Number(cart[index].qty || 1) + delta);
    saveCart(cart);
    renderCartPage();
  };

  window.removeCartItem = function (index) {
    const cart = loadCart();
    cart.splice(index, 1);
    saveCart(cart);
    renderCartPage();
  };

  window.clearCart = function () {
    if (!confirm('Sepeti temizlemek istediğinize emin misiniz?')) return;
    saveCart([]);
    renderCartPage();
  };

  window.selectCargo = function (el) {
    document.querySelectorAll('.cargo-opt').forEach((opt) => {
      opt.classList.remove('act');
      opt.querySelector('input').checked = false;
    });
    el.classList.add('act');
    el.querySelector('input').checked = true;
    checkoutShipping = el.querySelector('.cargo-price')?.classList.contains('free') ? 0 : 155;
    updateCheckoutTotals();
  };

  document.addEventListener('DOMContentLoaded', () => {
    renderCartPage();
    renderCheckoutPage();
  });

  window.SuveraCartUI = {
    loadCart,
    saveCart,
    renderCartPage,
    renderCheckoutPage,
    cartSubtotal,
  };
})();
