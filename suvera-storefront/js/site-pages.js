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
      return ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char];
    });
  }

  function assetUrl(path) {
    return window.SuveraAPI && window.SuveraAPI.assetUrl ? window.SuveraAPI.assetUrl(path) : path;
  }

  function productMatches(product, query) {
    const haystack = [
      product.name,
      product.category_name,
      product.tags,
      product.description,
    ].join(' ').toLocaleLowerCase('tr-TR');

    return haystack.includes(query.toLocaleLowerCase('tr-TR'));
  }

  function orderStatusLabel(status) {
    const labels = {
      payment_pending: 'Odeme bekleniyor',
      paid: 'Odeme alindi',
      payment_failed: 'Odeme basarisiz',
      payment_cancelled: 'Odeme iptal edildi',
      preparing: 'Hazirlaniyor',
      shipped: 'Kargoya verildi',
      delivered: 'Teslim edildi',
      cancelled: 'Iptal edildi',
    };
    return labels[status] || 'Islemde';
  }

  function normalizeOrder(raw) {
    if (!raw) return null;
    const items = Array.isArray(raw.items) ? raw.items.map(function (item) {
      return {
        id: item.product_id || '',
        name: item.name || 'Urun',
        qty: Number(item.qty || item.quantity || 1),
        quantity: Number(item.qty || item.quantity || 1),
        price: Number(item.price || item.unit_price || 0),
        unit_price: Number(item.price || item.unit_price || 0),
        variant: item.variant || item.size || 'Standart',
      };
    }) : [];

    return {
      id: raw.id || raw.order_code || '',
      orderCode: raw.orderCode || raw.order_code || raw.id || '',
      status: raw.status || 'new',
      provider: raw.provider || raw.payment_provider || '',
      paymentMethod: raw.paymentMethod || raw.payment_method || '',
      total: Number(raw.total || 0),
      shipping_fee: Number(raw.shipping_fee || raw.shippingFee || 0),
      shipping_company: raw.shipping_company || '',
      tracking_number: raw.tracking_number || '',
      tracking_url: raw.tracking_url || '',
      shipped_at: raw.shipped_at || '',
      created_at: raw.created_at || '',
      updated_at: raw.updated_at || '',
      customer: raw.customer || {
        name: raw.customer_name || raw.customer || '',
        email: raw.email || '',
        phone: raw.phone || '',
        address: raw.address || '',
      },
      items: items,
    };
  }

  function isIbanOrder(order) {
    const method = String(order && (order.paymentMethod || order.payment_method) || '').toLowerCase();
    const provider = String(order && order.provider || '').toLowerCase();
    return method === 'iban' || provider === 'manual';
  }

  function ibanInfoHtml(orderCode) {
    const info = window.SUVERA_IBAN_INFO || {};
    const accountName = info.accountName || 'Suvera';
    const bankName = info.bankName || '';
    const iban = info.iban || '';

    if (!iban) {
      return '<div class="page-warning-banner" style="margin-top:16px;"><strong>IBAN bilgileri yapılandırılmadı.</strong><br/>Lütfen ödeme için Suvera destek ekibiyle iletişime geçin. Sipariş kodunuz: <strong>' +
        escapeHtml(orderCode || '-') + '</strong></div>';
    }

    return '<div class="page-info-banner" style="margin-top:16px;"><strong>IBAN / havale bilgileri</strong><br/>' +
      (bankName ? 'Banka: <strong>' + escapeHtml(bankName) + '</strong><br/>' : '') +
      'Alıcı: <strong>' + escapeHtml(accountName) + '</strong><br/>' +
      'IBAN: <strong>' + escapeHtml(iban) + '</strong><br/>' +
      'Açıklama: <strong>' + escapeHtml(orderCode || '-') + '</strong></div>';
  }

  function orderStatusNote(order) {
    const status = String(order && order.status || '').toLowerCase();
    if (isIbanOrder(order)) {
      return 'IBAN / havale siparişiniz alındı. Ödeme açıklamasına sipariş kodunu ekleyin; ödeme onaylanana kadar durum Panelya’da ödeme bekliyor olarak kalır.';
    }
    if (status === 'payment_failed') {
      return 'Kart ödemeniz tamamlanamadı. Siparişi yeniden deneyebilir veya destek ekibimizle iletişime geçebilirsiniz.';
    }
    return 'Sipariş durumu Panelya backend verisinden okunuyor. Kargo numarası oluştuğunda bu alana otomatik yansır.';
  }

  async function fetchOrder(orderCode) {
    if (!window.SuveraAPI || !orderCode) return null;
    try {
      const order = await window.SuveraAPI.orders.lookup(orderCode);
      return normalizeOrder(order);
    } catch (err) {
      return null;
    }
  }

  async function fetchOrders(orderCodes) {
    const uniqueCodes = Array.from(new Set((orderCodes || []).filter(Boolean)));
    const results = await Promise.all(uniqueCodes.map(fetchOrder));
    return results.filter(Boolean);
  }

  function getState() {
    return window.Suvera || {};
  }

  function renderOrderItems(items) {
    return (items || []).map(function (item) {
      return '<tr><td><strong>' + escapeHtml(item.name || 'Urun') + '</strong><br/><span>' +
        escapeHtml(item.variant || item.size || 'Standart') + '</span></td><td>' +
        Number(item.qty || item.quantity || 1) + '</td><td>' + money(Number(item.price || item.unit_price || 0)) +
        '</td></tr>';
    }).join('');
  }

  function paymentReturnState(params) {
    const raw = String(
      params.get('payment') ||
      params.get('paymentStatus') ||
      params.get('status') ||
      ''
    ).toLowerCase();

    if (['success', 'successful', 'paid', 'ok'].includes(raw)) {
      return {
        status: 'paid',
        note: 'Odemeniz onaylandi. Siparisiniz hazirlama sirasina alindi ve gelismeleri bu sayfadan takip edebilirsiniz.',
      };
    }

    if (['failed', 'failure', 'error'].includes(raw)) {
      return {
        status: 'payment_failed',
        note: 'Odeme tamamlanamadi. Kart bilgilerinizi kontrol ederek siparisi tekrar deneyebilir veya destek ekibimizle iletisime gecebilirsiniz.',
      };
    }

    if (['cancel', 'cancelled'].includes(raw)) {
      return {
        status: 'payment_cancelled',
        note: 'Odeme islemi tamamlanmadan sonlandirildi. Hazir oldugunuzda siparisinizi yeniden baslatabilirsiniz.',
      };
    }

    return null;
  }

  async function renderThankYou() {
    const root = document.getElementById('thankYouPage');
    if (!root) return;

    const params = new URLSearchParams(location.search);
    const state = getState();
    const lastOrder = state.getLastOrder ? state.getLastOrder() : null;
    const history = state.loadOrderHistory ? state.loadOrderHistory() : [];
    const orderCode = params.get('order');
    const localOrder = history.find(function (item) {
      return String(item.orderCode || item.id || '') === String(orderCode || '');
    }) || lastOrder;

    const summary = document.getElementById('thankYouSummary');
    const codeNode = document.getElementById('thankYouOrderCode');
    const nameNode = document.getElementById('thankYouCustomerName');
    const totalNode = document.getElementById('thankYouTotal');
    const statusNode = document.getElementById('thankYouStatus');
    const noteNode = document.getElementById('thankYouProviderNote');
    const paymentState = paymentReturnState(params);

    const backendOrder = await fetchOrder(orderCode || (localOrder && (localOrder.orderCode || localOrder.id)));
    const order = backendOrder || normalizeOrder(localOrder);

    if (!order) {
      summary.innerHTML = '<div class="page-empty">Son siparis ozeti bulunamadi. Sepet veya hesabim sayfasindan son islemlerinizi kontrol edebilirsiniz.</div>';
      return;
    }

    if (paymentState && state.recordOrder) {
      state.recordOrder({
        ...order,
        status: paymentState.status,
      });
    }

    const effectiveOrder = paymentState
      ? { ...order, status: paymentState.status }
      : order;

    codeNode.textContent = effectiveOrder.orderCode || effectiveOrder.id || '-';
    nameNode.textContent = effectiveOrder.customer && effectiveOrder.customer.name ? effectiveOrder.customer.name : 'Suvera musterisi';
    totalNode.textContent = money(effectiveOrder.total || 0);
    statusNode.textContent = orderStatusLabel(effectiveOrder.status);

    if (paymentState) {
      noteNode.textContent = paymentState.note;
    } else if (isIbanOrder(effectiveOrder)) {
      noteNode.innerHTML = 'Siparişiniz oluşturuldu. IBAN / havale ödemesi onaylanana kadar durum <strong>ödeme bekleniyor</strong> olarak kalır.';
    } else {
      noteNode.textContent = 'Odeme saglayicisi tarafinda islem tamamlandiginda durum bu sayfadan ve hesabim alanindan takip edilebilir.';
    }

    summary.innerHTML = '<div class="page-table-wrap"><table class="page-table"><thead><tr><th>Urun</th><th>Adet</th><th>Tutar</th></tr></thead><tbody>' +
      renderOrderItems(effectiveOrder.items || []) +
      '</tbody></table></div>' +
      (isIbanOrder(effectiveOrder) ? ibanInfoHtml(effectiveOrder.orderCode || effectiveOrder.id) : '') +
      ((effectiveOrder.tracking_number || effectiveOrder.tracking_url)
        ? '<div class="page-info-banner" style="margin-top:16px;">Kargo: <strong>' + escapeHtml(effectiveOrder.shipping_company || 'Hazirlaniyor') + '</strong>' +
          (effectiveOrder.tracking_number ? ' • Takip No: <strong>' + escapeHtml(effectiveOrder.tracking_number) + '</strong>' : '') +
          (effectiveOrder.tracking_url ? ' • <a href="' + escapeHtml(effectiveOrder.tracking_url) + '">Takip Linki</a>' : '') +
          '</div>'
        : '');
  }

  async function renderAccount() {
    const root = document.getElementById('accountPage');
    if (!root) return;

    const state = getState();
    const profile = state.loadProfile ? state.loadProfile() : {};
    const localOrders = state.loadOrderHistory ? state.loadOrderHistory() : [];
    const backendOrders = await fetchOrders(localOrders.map(function (order) {
      return order.orderCode || order.id;
    }));
    const orders = backendOrders.length ? backendOrders : localOrders.map(normalizeOrder).filter(Boolean);
    const favorites = state.loadFavorites ? state.loadFavorites() : [];

    const latestOrder = orders[0] || {};
    document.getElementById('accountName').textContent = profile.name || latestOrder.customer && latestOrder.customer.name || 'Suvera Uyesi';
    document.getElementById('accountEmail').textContent = profile.email || latestOrder.customer && latestOrder.customer.email || 'E-posta eklendiginde burada gorunur';
    document.getElementById('accountPhone').textContent = profile.phone || latestOrder.customer && latestOrder.customer.phone || 'Telefon bilgisi eklenmedi';

    document.getElementById('accountStats').innerHTML =
      '<div class="page-stat">Toplam siparis: ' + orders.length + '</div>' +
      '<div class="page-stat">Favori urun: ' + favorites.length + '</div>' +
      '<div class="page-stat">Son durum: ' + escapeHtml(orderStatusLabel(latestOrder.status)) + '</div>';

    const ordersNode = document.getElementById('accountOrders');
    if (!orders.length) {
      ordersNode.innerHTML = '<div class="page-empty">Hesabinizda gorunecek ilk siparis, checkout sonrasi otomatik olarak burada listelenir.</div>';
    } else {
      ordersNode.innerHTML = orders.map(function (order) {
        return '<div class="page-order-card"><strong>' + escapeHtml(order.orderCode || order.id || 'Siparis') + '</strong><p>' +
          escapeHtml(order.customer && order.customer.name || 'Musteri bilgisi yok') + '</p><p>Durum: ' +
          escapeHtml(orderStatusLabel(order.status)) + '</p><p>Toplam: ' + money(order.total || 0) +
          '</p><div class="page-inline-actions"><a class="page-btn-secondary" href="siparis-takip.html?order=' +
          encodeURIComponent(order.orderCode || order.id || '') + '">Takip Et</a></div></div>';
      }).join('');
    }

    const favoritesNode = document.getElementById('accountFavorites');
    if (!favorites.length) {
      favoritesNode.innerHTML = '<div class="page-empty">Henuz favori eklemediniz. Urun detaylarindaki kalp butonuyla kayda baslayabilirsiniz.</div>';
    } else {
      favoritesNode.innerHTML = favorites.slice(0, 4).map(function (item) {
        const media = item.image
          ? '<img src="' + escapeHtml(assetUrl(item.image)) + '" alt="' + escapeHtml(item.name) + '" loading="lazy" decoding="async"/>'
          : escapeHtml(item.emoji || 'SU');
        return '<div class="page-favorite-card"><div class="page-favorite-media">' + media + '</div><h3>' +
          escapeHtml(item.name) + '</h3><p>' + money(item.price || 0) + '</p><a class="page-btn-secondary" href="' +
          escapeHtml(item.url || 'urun.html') + '">Incele</a></div>';
      }).join('');
    }
  }

  function renderFavorites() {
    const root = document.getElementById('favoritesPage');
    if (!root) return;

    const state = getState();
    const favorites = state.loadFavorites ? state.loadFavorites() : [];
    const grid = document.getElementById('favoritesGrid');
    const count = document.getElementById('favoritesCount');

    count.textContent = String(favorites.length);

    if (!favorites.length) {
      grid.innerHTML = '<div class="page-empty">Kayitli favoriniz henuz yok. Urun listesinde veya detay sayfasinda kalp ikonuna basarak bu alani doldurabilirsiniz.</div>';
      return;
    }

    grid.innerHTML = favorites.map(function (item) {
      const media = item.image
        ? '<img src="' + escapeHtml(assetUrl(item.image)) + '" alt="' + escapeHtml(item.name) + '" loading="lazy" decoding="async"/>'
        : escapeHtml(item.emoji || 'SU');
      return '<article class="page-favorite-card" data-favorite-id="' + escapeHtml(item.id || item.name) + '">' +
        '<div class="page-favorite-media">' + media + '</div>' +
        '<h3>' + escapeHtml(item.name) + '</h3>' +
        '<p>' + money(item.price || 0) + '</p>' +
        '<div class="page-inline-actions"><a class="page-btn-secondary" href="' + escapeHtml(item.url || 'urun.html') +
        '">Urunu Ac</a><button class="page-btn" type="button" data-remove-favorite="' + escapeHtml(item.id || item.name) +
        '">Kaldir</button></div></article>';
    }).join('');

    grid.querySelectorAll('[data-remove-favorite]').forEach(function (button) {
      button.addEventListener('click', function () {
        if (!state.toggleFavorite) return;
        state.toggleFavorite({ id: button.getAttribute('data-remove-favorite') });
        renderFavorites();
        if (state.refreshWishlistButtons) state.refreshWishlistButtons();
        if (state.toast) state.toast('Favori listesinden kaldirildi', 'dark');
      });
    });
  }

  async function renderSearch() {
    const root = document.getElementById('searchPage');
    if (!root) return;

    const params = new URLSearchParams(location.search);
    const query = (params.get('q') || '').trim();
    const input = document.getElementById('searchInput');
    const label = document.getElementById('searchQueryLabel');
    const resultsNode = document.getElementById('searchResultsGrid');
    const countNode = document.getElementById('searchResultCount');

    input.value = query;
    label.textContent = query || 'Tum secki';

    if (window.SuveraSEO) {
      window.SuveraSEO.applyPageMeta({
        title: query ? query + ' arama sonuclari | Suvera' : 'Arama | Suvera',
        description: query
          ? 'Suvera urunleri icinde "' + query + '" arama sonuclari.'
          : 'Suvera koleksiyonunda urun arayin ve filtreleyin.',
        path: 'arama.html' + (query ? '?q=' + encodeURIComponent(query) : ''),
      });
      window.SuveraSEO.applyBaseSchemas({
        path: 'arama.html' + (query ? '?q=' + encodeURIComponent(query) : ''),
        name: query ? query + ' arama sonuclari | Suvera' : 'Arama | Suvera',
        description: query
          ? 'Suvera urunleri icinde "' + query + '" arama sonuclari.'
          : 'Suvera koleksiyonunda urun arayin ve filtreleyin.',
      });
    }

    if (!window.SuveraAPI) {
      resultsNode.innerHTML = '<div class="page-empty">Arama servisi su anda hazir degil. Lutfen daha sonra tekrar deneyin.</div>';
      countNode.textContent = '0';
      return;
    }

    try {
      const items = await window.SuveraAPI.products.list('?status=active&limit=64');
      const matches = (items || []).filter(function (item) {
        return !query || productMatches(item, query);
      });

      countNode.textContent = String(matches.length);

      if (!matches.length) {
        resultsNode.innerHTML = '<div class="page-empty">Aradiginiz ifade icin sonuca ulasilamadi. Daha genel bir kelimeyle tekrar deneyebilirsiniz.</div>';
        return;
      }

      resultsNode.innerHTML = matches.map(function (item) {
        const image = Array.isArray(item.images) && item.images.length ? assetUrl(item.images[0]) : '';
        const media = image
          ? '<img src="' + escapeHtml(image) + '" alt="' + escapeHtml(item.name) + '" loading="lazy" decoding="async"/>'
          : escapeHtml(item.emoji || 'SU');
        const finalPrice = Number(item.sale_price || item.price || 0);
        return '<article class="page-result-card"><div class="page-result-media">' + media + '</div><span class="page-badge good">' +
          escapeHtml(item.category_name || 'Secki') + '</span><h3>' + escapeHtml(item.name) + '</h3><p>' +
          escapeHtml(item.tags || 'Suvera katalog urunu') + '</p><div class="page-inline-actions"><a class="page-btn-secondary" href="urun.html?id=' +
          encodeURIComponent(item.id) + '">Incele</a><button class="page-btn" type="button" data-search-add="' +
          escapeHtml(item.id) + '">Sepete Ekle</button><span class="page-badge warn">' + money(finalPrice) +
          '</span></div></article>';
      }).join('');

      resultsNode.querySelectorAll('[data-search-add]').forEach(function (button) {
        button.addEventListener('click', function () {
          if (window.addApiProductToCart) window.addApiProductToCart(button.getAttribute('data-search-add'));
        });
      });
    } catch (err) {
      resultsNode.innerHTML = '<div class="page-empty">Arama sonuclari yuklenemedi. Lutfen kisa sure sonra tekrar deneyin.</div>';
      countNode.textContent = '0';
    }
  }

  async function renderTracking() {
    const root = document.getElementById('trackingPage');
    if (!root) return;

    const state = getState();
    const history = state.loadOrderHistory ? state.loadOrderHistory() : [];
    const params = new URLSearchParams(location.search);
    const initialCode = params.get('order') || '';
    const input = document.getElementById('trackingOrderInput');
    const result = document.getElementById('trackingResult');

    async function paint(orderCode) {
      if (!orderCode) {
        result.innerHTML = '<div class="page-empty">Siparis kodunuzu yazarak durum takibini burada gorebilirsiniz.</div>';
        return;
      }

      const backendOrder = await fetchOrder(orderCode);
      const localOrder = history.find(function (item) {
        return String(item.orderCode || item.id || '').toLocaleLowerCase('tr-TR') === orderCode.toLocaleLowerCase('tr-TR');
      });
      const match = backendOrder || normalizeOrder(localOrder);

      if (!match) {
        result.innerHTML = '<div class="page-warning-banner">Bu tarayicida eslesen bir siparis bulunamadi. Farkli bir cihaz kullaniyorsaniz iletisim ekibimizden destek alabilirsiniz.</div>';
        return;
      }

      result.innerHTML = '<div class="page-kv-grid"><div class="page-kv"><small>Siparis</small><strong>' +
        escapeHtml(match.orderCode || match.id || '-') + '</strong></div><div class="page-kv"><small>Durum</small><strong>' +
        escapeHtml(orderStatusLabel(match.status)) + '</strong></div><div class="page-kv"><small>Musteri</small><strong>' +
        escapeHtml(match.customer && match.customer.name || '-') + '</strong></div><div class="page-kv"><small>Toplam</small><strong>' +
        money(match.total || 0) + '</strong></div></div><div class="page-info-banner" style="margin-top:16px;">' +
        (match.tracking_number
          ? 'Kargo: <strong>' + escapeHtml(match.shipping_company || 'Hazirlaniyor') + '</strong> • Takip No: <strong>' + escapeHtml(match.tracking_number) + '</strong>' +
            (match.tracking_url ? ' • <a href="' + escapeHtml(match.tracking_url) + '">Takip Linki</a>' : '')
          : escapeHtml(orderStatusNote(match))) +
        '</div>' +
        (isIbanOrder(match) ? ibanInfoHtml(match.orderCode || match.id) : '');
    }

    input.value = initialCode;
    await paint(initialCode);

    document.getElementById('trackingForm').addEventListener('submit', async function (event) {
      event.preventDefault();
      await paint(input.value.trim());
    });
  }

  function bindSupportForms() {
    [
      ['contactForm', 'Mesajiniz kaydedildi. Suvera destek ekibi en kisa surede donus yapacak.'],
      ['returnRequestForm', 'Iade veya degisim talebiniz not edildi. Siparis kodunuzla birlikte destek ekibi sizi yonlendirecek.'],
      ['passwordResetForm', 'Sifre sifirlama baglantisi hazir durumda. Canli entegrasyonda e-posta servisine baglanacak.'],
    ].forEach(function (entry) {
      const form = document.getElementById(entry[0]);
      if (!form) return;
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        if (window.showToast) window.showToast(entry[1], 'green');
      });
    });

    const searchForm = document.getElementById('searchForm');
    if (searchForm) {
      searchForm.addEventListener('submit', function (event) {
        event.preventDefault();
        const query = document.getElementById('searchInput').value.trim();
        location.href = 'arama.html' + (query ? '?q=' + encodeURIComponent(query) : '');
      });
    }
  }

  async function init() {
    await renderThankYou();
    await renderAccount();
    renderFavorites();
    await renderTracking();
    renderSearch();
    bindSupportForms();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
