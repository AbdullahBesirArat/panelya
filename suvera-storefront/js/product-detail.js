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
    selectedVariantId: null,
    variants: [],
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
    return window.SuveraAPI && window.SuveraAPI.assetUrl ? window.SuveraAPI.assetUrl(path) : path;
  }

  function imageMarkup(src, alt, fallbackClass) {
    return src
      ? '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(alt) + '" loading="lazy" decoding="async"/>'
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
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const variantColors = [...new Set(variants.map(function (variant) { return variant.color; }).filter(Boolean))];
    const colors = variantColors.length ? variantColors : (Array.isArray(product.colors) && product.colors.length ? product.colors : ['#e9dfd0']);
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
        renderSizes(product);
        updateSelectedVariant();
      });
    });
  }

  function renderSizes(product) {
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const variantSizes = variants
      .filter(function (variant) { return !currentProduct.selectedColor || variant.color === currentProduct.selectedColor; })
      .map(function (variant) { return variant.size; })
      .filter(Boolean);
    const sizes = [...new Set(variantSizes)].length ? [...new Set(variantSizes)] : (Array.isArray(product.sizes) && product.sizes.length ? product.sizes : ['Standart']);
    if (!sizes.includes(currentProduct.selectedSize)) currentProduct.selectedSize = sizes[0];
    const currentVariant = variants.find(function (variant) {
      return variant.color === currentProduct.selectedColor && variant.size === currentProduct.selectedSize;
    });
    if (currentVariant && Number(currentVariant.stock || 0) <= 0) {
      const availableVariant = variants.find(function (variant) {
        return variant.color === currentProduct.selectedColor && Number(variant.stock || 0) > 0;
      });
      if (availableVariant) currentProduct.selectedSize = availableVariant.size;
    }

    const wrap = document.getElementById('detailSizes');
    const label = document.getElementById('detailSizeLabel');
    if (!wrap) return;

    wrap.innerHTML = sizes.map(function (size, index) {
      const active = size === currentProduct.selectedSize;
      const variant = variants.find(function (item) {
        return item.color === currentProduct.selectedColor && item.size === size;
      });
      const disabled = variant && Number(variant.stock || 0) <= 0;
      return '<button class="size-btn' + (active ? ' active' : '') + '" type="button" data-size="' + escapeHtml(size) + '"' + (disabled ? ' disabled' : '') + '>' + escapeHtml(size) + '</button>';
    }).join('');

    if (label) label.textContent = currentProduct.selectedSize;

    wrap.querySelectorAll('.size-btn').forEach(function (button) {
      button.addEventListener('click', function () {
        wrap.querySelectorAll('.size-btn').forEach(function (item) { item.classList.remove('active'); });
        button.classList.add('active');
        currentProduct.selectedSize = button.dataset.size || '';
        if (label) label.textContent = currentProduct.selectedSize;
        updateSelectedVariant();
      });
    });
    updateSelectedVariant();
  }

  function updateSelectedVariant() {
    const variant = (currentProduct.variants || []).find(function (item) {
      return item.color === currentProduct.selectedColor && item.size === currentProduct.selectedSize;
    });
    currentProduct.selectedVariantId = variant ? variant.id : null;

    const stockNode = document.getElementById('detailStockText');
    const badge = document.getElementById('stockBadge');
    if (variant && stockNode && badge) {
      const stock = Number(variant.stock || 0);
      stockNode.innerHTML = '<strong>Stok durumu</strong> ' + (stock > 0 ? stock + ' adet hazır' : 'Tükendi');
      badge.textContent = stock > 0 ? 'Stokta' : 'Tükendi';
    }
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
    currentProduct.variants = Array.isArray(product.variants) ? product.variants : [];

    document.title = currentProduct.name + ' – Suvera';
    document.getElementById('detailProductTitle').textContent = currentProduct.name;
    document.getElementById('detailCategory').textContent = product.category_name || 'Suvera Seçkisi';
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

    const favButton = document.getElementById('favToggle');
    if (favButton) {
      favButton.dataset.productId = String(currentProduct.id || '');
      favButton.dataset.productName = currentProduct.name;
      favButton.dataset.productPrice = String(currentProduct.price || 0);
      favButton.dataset.productImage = currentProduct.image || '';
      favButton.dataset.productEmoji = currentProduct.emoji || '';
      favButton.dataset.productUrl = currentProduct.id ? ('urun.html?id=' + encodeURIComponent(currentProduct.id)) : 'urun.html';
      if (window.Suvera && window.Suvera.syncFavoriteButton) {
        window.Suvera.syncFavoriteButton(favButton, {
          id: currentProduct.id,
          name: currentProduct.name,
          price: currentProduct.price,
          image: currentProduct.image,
          emoji: currentProduct.emoji,
        });
      }
    }

    if (window.SuveraSEO) {
      const pagePath = 'urun.html?id=' + encodeURIComponent(currentProduct.id || '');
      window.SuveraSEO.applyPageMeta({
        title: currentProduct.name + ' | Suvera',
        description: shortText,
        path: pagePath,
        image: currentProduct.image || window.SuveraSEO.defaultImage,
        type: 'product',
      });
      window.SuveraSEO.applyBaseSchemas({
        path: pagePath,
        name: currentProduct.name + ' | Suvera',
        description: shortText,
      });
      window.SuveraSEO.applyJsonLd('suvera-product-schema', {
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: currentProduct.name,
        image: currentProduct.image ? [window.SuveraSEO.toAbsolute(currentProduct.image)] : [window.SuveraSEO.defaultImage],
        description: shortText,
        sku: 'MV-' + String(product.id || 0).padStart(5, '0'),
        brand: {
          '@type': 'Brand',
          name: 'Suvera'
        },
        offers: {
          '@type': 'Offer',
          priceCurrency: 'TRY',
          price: finalPrice,
          availability: stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
          url: window.SuveraSEO.toAbsolute(pagePath)
        }
      });
    }
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
    if (!window.SuveraAPI) return;

    try {
      const params = product.category_id ? '?category_id=' + product.category_id + '&status=active&limit=8' : '?status=active&limit=8';
      const items = await window.SuveraAPI.products.list(params);
      const related = (items || [])
        .filter(function (item) { return String(item.id) !== String(product.id); })
        .slice(0, 4);
      renderRelated(related);
    } catch (err) {
      renderRelated([]);
    }
  }

  function bindWishlist() {
    const button = document.getElementById('favToggle');
    if (!button) return;

    button.addEventListener('click', function () {
      if (!window.Suvera || !window.Suvera.toggleFavorite) return;
      const result = window.Suvera.toggleFavorite({
        id: currentProduct.id,
        name: currentProduct.name,
        price: currentProduct.price,
        image: currentProduct.image,
        emoji: currentProduct.emoji,
        url: currentProduct.id ? ('urun.html?id=' + encodeURIComponent(currentProduct.id)) : 'urun.html',
      });
      if (window.showToast) {
        window.showToast(
          result.active ? 'Favorilere eklendi' : 'Favorilerden kaldirildi',
          result.active ? 'green' : 'dark'
        );
      }
    });
  }

  async function loadProduct() {
    bindWishlist();

    if (!window.SuveraAPI) return;
    const params = new URLSearchParams(location.search);
    let id = params.get('id');

    try {
      if (!id) {
        const items = await window.SuveraAPI.products.list('?status=active&limit=24');
        if (!items || !items.length) throw new Error('Suvera urunleri hazirlaniyor.');
        id = items[0].id;
        params.set('id', id);
        history.replaceState({}, '', 'urun.html?' + params.toString());
      }
      const product = await window.SuveraAPI.products.get(id);
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
    if (!window.Suvera) return;
    const selectedVariant = (currentProduct.variants || []).find(function (item) {
      return String(item.id) === String(currentProduct.selectedVariantId);
    });
    if (selectedVariant && Number(selectedVariant.stock || 0) <= 0) {
      if (window.showToast) window.showToast('Bu renk/beden tükendi', 'red');
      return;
    }

    window.Suvera.addToCart(currentProduct.name, currentProduct.price, currentProduct.emoji, {
      id: currentProduct.id,
      product_id: currentProduct.id,
      image: currentProduct.image,
      variant_id: currentProduct.selectedVariantId,
      color: currentProduct.selectedColor,
      size: currentProduct.selectedSize,
      variant: [currentProduct.selectedColor, currentProduct.selectedSize].filter(Boolean).join(' / '),
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
