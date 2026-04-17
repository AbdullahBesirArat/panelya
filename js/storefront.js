(function () {
  'use strict';

  function money(value) {
    return Number(value || 0).toLocaleString('tr-TR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + ' TL';
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function (char) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
      }[char];
    });
  }

  function colorDots(colors) {
    const list = Array.isArray(colors) && colors.length ? colors : ['#d8d3c8'];
    return list.slice(0, 4).map(function (color, index) {
      return '<div class="color-dot ' + (index === 0 ? 'active' : '') + '" style="background:' + escapeHtml(color) + '"></div>';
    }).join('');
  }

  function badge(product) {
    if (product.sale_price) return '<span class="badge badge-sale">Indirim</span>';
    if (String(product.tags || '').toLowerCase().includes('yeni')) return '<span class="badge badge-new">Yeni</span>';
    return '';
  }

  function productCard(product) {
    const price = Number(product.sale_price || product.price || 0);
    const oldPrice = product.sale_price ? Number(product.price || 0) : null;
    const emoji = product.emoji || '👗';
    const image = Array.isArray(product.images) && product.images.length ? window.MaveranAPI.assetUrl(product.images[0]) : '';
    const id = encodeURIComponent(product.id);

    return `
      <div class="prod-card"
        data-product-id="${id}"
        data-product-name="${escapeHtml(product.name)}"
        data-product-price="${price}"
        data-product-price-label="${escapeHtml(money(price))}"
        data-product-emoji="${escapeHtml(emoji)}"
        data-product-image="${escapeHtml(image)}"
        onclick="location.href='urun.html?id=${id}'">
        <div class="prod-img">
          <div class="prod-img-bg" style="background:linear-gradient(150deg,#d8d3c8,#c5bfb2)"></div>
          ${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(product.name)}" style="position:relative;z-index:1;width:100%;height:100%;object-fit:cover;"/>` : `<span style="position:relative;z-index:1">${escapeHtml(emoji)}</span>`}
          <div class="prod-badges">${badge(product)}</div>
          <div class="prod-hover-actions">
            <button class="quick-add" onclick="event.stopPropagation();addApiProductToCart('${id}')">Hizli Ekle</button>
            <button class="quick-fav" onclick="event.stopPropagation()">♡</button>
            <button class="quick-view" onclick="event.stopPropagation()" title="Hizli Bak">Gor</button>
          </div>
        </div>
        <div class="prod-info">
          <h4>${escapeHtml(product.name)}</h4>
          <div class="prod-colors">${colorDots(product.colors)}</div>
          <div class="prod-price">
            <span class="p-new">${money(price)}</span>
            ${oldPrice ? '<span class="p-old">' + money(oldPrice) + '</span>' : ''}
          </div>
        </div>
      </div>`;
  }

  async function renderProducts(target, limit) {
    if (!window.MaveranAPI || !target) return;

    try {
      const products = await window.MaveranAPI.products.list('?status=active&limit=' + limit);
      if (!products.length) return;
      target.innerHTML = products.map(productCard).join('');
    } catch (err) {
      console.warn('Storefront API urunleri alinamadi, statik urunler kullaniliyor:', err.message);
    }
  }

  window.addApiProductToCart = async function (id) {
    if (!window.MaveranAPI || !window.SUVERA) return;

    try {
      const product = await window.MaveranAPI.products.get(id);
      const price = Number(product.sale_price || product.price || 0);
      const image = Array.isArray(product.images) && product.images.length ? window.MaveranAPI.assetUrl(product.images[0]) : '';
      window.SUVERA.addToCart(product.name, price, product.emoji || '👗', {
        id: product.id,
        product_id: product.id,
        image,
      });
    } catch (err) {
      console.warn('Urun sepete eklenemedi:', err.message);
    }
  };

  document.addEventListener('DOMContentLoaded', function () {
    renderProducts(document.getElementById('homeProductsGrid'), 8);
    renderProducts(document.getElementById('prodsGrid'), 24);
  });
})();
