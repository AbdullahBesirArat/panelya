(function () {
  'use strict';

  let currentProduct = {
    id: null,
    name: 'Ürün',
    price: 0,
    emoji: '👗',
    image: '',
    selectedColor: '',
    selectedSize: '',
    images: [],
    categoryId: null,
  };

  function money(value) {
    return Number(value || 0).toLocaleString('tr-TR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }) + ' TL';
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function (char) {
      return ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char];
    });
  }

  function plainDescription(html) {
    return String(html || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+\n/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function measurementLines(text) {
    return text
      .split('\n')
      .map(function (line) { return line.trim(); })
      .filter(function (line) { return /\bbeden\b|cm|göğüs|gogus|bel|omuz|kol|uzunluk/i.test(line); });
  }

  function articleLines(text) {
    return text
      .split('\n')
      .map(function (line) { return line.trim(); })
      .filter(Boolean)
      .slice(0, 4);
  }

  function imageUrl(path) {
    return window.MaveranAPI && window.MaveranAPI.assetUrl ? window.MaveranAPI.assetUrl(path) : path;
  }

  function imageMarkup(src, alt, fallbackClass) {
    return src
      ? '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt) + '"/>'
      : '<div class="' + fallbackClass + '">' + escapeHtml(currentProduct.emoji) + '</div>';
  }

  function setActiveThumb(index) {
    const thumbs = document.querySelectorAll('.thumb-btn');
    thumbs.forEach(function (thumb, i) {
      thumb.classList.toggle('active', i === index);
    });

    const media = currentProduct.images[index] || currentProduct.images[0] || '';
    const mainMedia = document.getElementById('detailMainMedia');
    const counter = document.getElementById('galleryCounter');

    if (mainMedia) {
      mainMedia.innerHTML = imageMarkup(media, currentProduct.name, 'main-fallback');
    }
    if (counter) {
      counter.textContent = (index + 1) + ' / ' + Math.max(currentProduct.images.length, 1);
    }
  }

  function renderGallery(product) {
    const images = Array.isArray(product.images) && product.images.length
      ? product.images.map(imageUrl)
      : [];

    currentProduct.images = images;
    currentProduct.image = images[0] || '';

    const thumbs = document.getElementById('detailThumbs');
    if (!thumbs) return;

    if (!images.length) {
      thumbs.innerHTML = '<button class="thumb-btn active" type="button"><div class="thumb-fallback">' + escapeHtml(currentProduct.emoji) + '</div></button>';
      setActiveThumb(0);
      return;
    }

    thumbs.innerHTML = images.map(function (src, index) {
      return '<button class="thumb-btn' + (index === 0 ? ' active' : '') + '" type="button" data-index="' + index + '">' +
        imageMarkup(src, product.name + ' görsel ' + (index + 1), 'thumb-fallback') +
        '</button>';
    }).join('');

    thumbs.querySelectorAll('.thumb-btn').forEach(function (button) {
      button.addEventListener('click', function () {
        setActiveThumb(Number(button.dataset.index || 0));
      });
    });

    setActiveThumb(0);
  }

  function renderSwatches(product) {
    const colors = Array.isArray(product.colors) && product.colors.length ? product.colors : ['#e9dfd0'];
    currentProduct.selectedColor = colors[0];

    const wrap = document.getElementById('detailColors');
    const label = document.getElementById('detailColorLabel');
    if (!wrap) return;

    wrap.innerHTML = colors.map(function (color, index) {
      return '<button class="swatch' + (index === 0 ? ' active' : '') + '" type="button" style="background:' + escapeHtml(color) + '" data-color="' + escapeHtml(color) + '"></button>';
    }).join('');

    if (label) label.textContent = colors[0];

    wrap.querySelectorAll('.swatch').forEach(function (button) {
      button.addEventListener('click', function () {
        wrap.querySelectorAll('.swatch').forEach(function (item) { item.classList.remove('active'); });
        button.classList.add('active');
        currentProduct.selectedColor = button.dataset.color || '';
        if (label) label.textContent = currentProduct.selectedColor;
      });
    });
  }

  function renderSizes(product) {
    const sizes = Array.isArray(product.sizes) && product.sizes.length ? product.sizes : ['Standart'];
    currentProduct.selectedSize = sizes[0];

    const wrap = document.getElementById('detailSizes');
    const label = document.getElementById('detailSizeLabel');
    if (!wrap) return;

    wrap.innerHTML = sizes.map(function (size, index) {
      return '<button class="size-btn' + (index === 0 ? ' active' : '') + '" type="button" data-size="' + escapeHtml(size) + '">' + escapeHtml(size) + '</button>';
    }).join('');

    if (label) label.textContent = sizes[0];

    wrap.querySelectorAll('.size-btn').forEach(function (button) {
      button.addEventListener('click', function () {
        wrap.querySelectorAll('.size-btn').forEach(function (item) { item.classList.remove('active'); });
        button.classList.add('active');
        currentProduct.selectedSize = button.dataset.size || '';
        if (label) label.textContent = currentProduct.selectedSize;
      });
    });
  }

  function renderInfo(product) {
    const finalPrice = Number(product.sale_price || product.price || 0);
    const oldPrice = product.sale_price ? Number(product.price || 0) : 0;
    const text = plainDescription(product.description);
    const measure = measurementLines(text);
    const story = articleLines(text);
    const details = product.details && typeof product.details === 'object' ? product.details : {};
    const storyText = details.story || story.join(' ') || 'Bu ürün, sade çizgiyi yumuşak kumaş hissiyle bir araya getirir.';
    const shortText = details.short_description || story[0] || 'Rahat kalıp, dengeli duruş ve sezon boyunca sık kullanılacak bir parça.';
    const deliveryText = details.delivery_note || 'Siparişler 1-3 iş günü içinde hazırlanır. Kargo çıktığında takip numarası hesabınıza ve sipariş ekranına işlenir.\nKullanılmamış ürünlerde değişim ve iade desteği için bizimle iletişime geçebilirsiniz.';
    const customMeasurements = details.measurements
      ? details.measurements.split('\n').map(function (line) { return line.trim(); }).filter(Boolean)
      : [];
    const measurementData = customMeasurements.length ? customMeasurements : measure;
    const stock = Number(product.stock || 0);

    currentProduct.id = product.id;
    currentProduct.name = product.name || 'Ürün';
    currentProduct.price = finalPrice;
    currentProduct.emoji = product.emoji || '👗';
    currentProduct.categoryId = product.category_id || null;

    document.title = currentProduct.name + ' – SUVERA';
    document.getElementById('detailProductTitle').textContent = currentProduct.name;
    document.getElementById('detailCategory').textContent = (product.category_name || 'SUVERA SEÇKİSİ').toUpperCase();
    document.getElementById('detailPriceNew').textContent = money(finalPrice);
    document.getElementById('detailPriceNew').classList.toggle('price-sale', !!product.sale_price);
    document.getElementById('detailSku').textContent = 'SKU: MV-' + String(product.id || 0).padStart(5, '0');

    const oldPriceNode = document.getElementById('detailPriceOld');
    oldPriceNode.style.display = oldPrice ? '' : 'none';
    oldPriceNode.textContent = oldPrice ? money(oldPrice) : '';

    document.getElementById('detailStockText').innerHTML = '<strong>Stok durumu</strong> ' + (stock > 0 ? stock + ' adet hazır' : 'Tükendi');
    document.getElementById('stockBadge').textContent = stock > 0 ? 'Stokta' : 'Tükendi';

    const meta = [];
    if (product.tags) meta.push(product.tags.split(',')[0]);
    if (product.category_name) meta.push(product.category_name);
    meta.push(stock > 0 ? 'Hızlı Kargo' : 'Tekrar Geliyor');
    document.getElementById('detailMeta').innerHTML = meta.map(function (item) {
      return '<span class="meta-chip">' + escapeHtml(item) + '</span>';
    }).join('');

    document.getElementById('detailShortDesc').textContent = shortText;
    document.getElementById('detailDescriptionBody').innerHTML = story.length
      ? story.map(function (line) { return '<p>' + escapeHtml(line) + '</p>'; }).join('')
      : '<p>Ürün açıklaması hazırlanıyor.</p>';

    document.getElementById('detailDescriptionBody').innerHTML = (details.story || story.length)
      ? (details.story ? details.story.split('\n').filter(Boolean).map(function (line) { return '<p>' + escapeHtml(line.trim()) + '</p>'; }).join('') : story.map(function (line) { return '<p>' + escapeHtml(line) + '</p>'; }).join(''))
      : '<p>Ürün açıklaması hazırlanıyor.</p>';

    document.getElementById('detailMeasurementBody').innerHTML = measurementData.length
      ? '<table>' + measurementData.map(function (line) { return '<tr><td>' + escapeHtml(line) + '</td></tr>'; }).join('') + '</table>'
      : '<p>Ölçü bilgisi hazırlanıyor.</p>';

    document.getElementById('detailStoryCopy').textContent = storyText;

    const measureList = document.getElementById('detailMeasureList');
    measureList.innerHTML = measurementData.slice(0, 5).map(function (line, index) {
      return '<div class="measure-row"><span>Detay ' + (index + 1) + '</span><strong>' + escapeHtml(line) + '</strong></div>';
    }).join('') || '<div class="measure-row"><span>Bilgi</span><strong>Ölçü tablosu eklenecek</strong></div>';

    const deliveryBodies = document.querySelectorAll('.info-body');
    if (deliveryBodies[2]) {
      deliveryBodies[2].innerHTML = deliveryText.split('\n').filter(Boolean).map(function (line) {
        return '<p>' + escapeHtml(line.trim()) + '</p>';
      }).join('');
    }

    const breadcrumb = document.getElementById('productBreadcrumb');
    breadcrumb.innerHTML = '<a href="index.html">Ana Sayfa</a><span>›</span><a href="urunler.html">Ürünler</a><span>›</span><a href="urunler.html">' +
      escapeHtml(product.category_name || 'Kategori') + '</a><span>›</span><span>' + escapeHtml(currentProduct.name) + '</span>';
  }

  function renderRelated(products) {
    const wrap = document.getElementById('relatedProducts');
    if (!wrap) return;

    if (!products.length) {
      wrap.innerHTML = '<div class="empty-state">Benzer ürünler bu kategoriye ürün eklendikçe burada görünür.</div>';
      return;
    }

    wrap.innerHTML = products.map(function (product) {
      const price = Number(product.sale_price || product.price || 0);
      const src = Array.isArray(product.images) && product.images.length ? imageUrl(product.images[0]) : '';
      return '<article class="related-card" onclick="location.href=\'urun.html?id=' + product.id + '\'">' +
        '<div class="related-media">' + imageMarkup(src, product.name, 'related-fallback') + '</div>' +
        '<div class="related-info"><p>' + escapeHtml(product.category_name || 'Seçki') + '</p><h3>' + escapeHtml(product.name) + '</h3><div class="related-price">' + money(price) + '</div></div>' +
      '</article>';
    }).join('');
  }

  async function loadRelated(product) {
    if (!window.MaveranAPI) return;

    try {
      const params = product.category_id ? '?category_id=' + product.category_id + '&status=active&limit=8' : '?status=active&limit=8';
      const items = await window.MaveranAPI.products.list(params);
      const related = (items || []).filter(function (item) { return String(item.id) !== String(product.id); }).slice(0, 4);
      renderRelated(related);
    } catch (err) {
      renderRelated([]);
    }
  }

  function bindWishlist() {
    const button = document.getElementById('favToggle');
    if (!button) return;

    button.addEventListener('click', function () {
      button.textContent = button.textContent === '♡' ? '♥' : '♡';
    });
  }

  async function loadProduct() {
    bindWishlist();

    if (!window.MaveranAPI) return;
    const params = new URLSearchParams(location.search);
    let id = params.get('id');

    try {
      if (!id) {
        const items = await window.MaveranAPI.products.list('?status=active&limit=1');
        if (!items || !items.length) throw new Error('Gösterilecek ürün bulunamadı.');
        id = items[0].id;
        params.set('id', id);
        history.replaceState({}, '', 'urun.html?' + params.toString());
      }
      const product = await window.MaveranAPI.products.get(id);
      renderInfo(product);
      renderGallery(product);
      renderSwatches(product);
      renderSizes(product);
      loadRelated(product);
    } catch (err) {
      document.getElementById('detailProductTitle').textContent = 'Ürün yüklenemedi';
      document.getElementById('detailShortDesc').textContent = err.message || 'Ürün bilgisi alınamadı.';
    }
  }

  window.addToCart = function () {
    if (!window.SUVERA) return;

    window.SUVERA.addToCart(currentProduct.name, currentProduct.price, currentProduct.emoji, {
      id: currentProduct.id,
      product_id: currentProduct.id,
      image: currentProduct.image,
      color: currentProduct.selectedColor,
      size: currentProduct.selectedSize,
    });
  };

  document.addEventListener('click', function (event) {
    const waBtn = event.target.closest('.wa-btn');
    if (!waBtn) return;
    const text = encodeURIComponent('Merhaba, ' + currentProduct.name + ' ürünü hakkında bilgi almak istiyorum.');
    window.open('https://wa.me/905555555555?text=' + text, '_blank');
  });

  document.addEventListener('DOMContentLoaded', loadProduct);
})();
