/* ═══════════════════════════════════════════════════
   SUVERA – Shared JavaScript v2
   Çalıştırma: <script src="shared.js"></script> </body> öncesinde
═══════════════════════════════════════════════════ */

(function() {
  'use strict';

  // ── CART STATE ──────────────────────────────────
  window.SUVERA = window.SUVERA || {};
  const cart = JSON.parse(localStorage.getItem('suveraCart') || '[]');
  const defaultSettings = {
    siteName: 'SUVERA – Modern Tesettür Giyim',
    announcementText: '✦ Yeni sezon geldi — tüm siparişlerde ücretsiz kargo 600 TL ve üzeri ✦',
    freeShippingLimit: 600,
    features: {
      announcement: true,
      newBadge: true,
      favorites: true,
      whatsapp: true,
      maintenance: false,
    },
  };
  const siteSettings = window.SuveraStore && window.SuveraStore.loadSettings
    ? window.SuveraStore.loadSettings(defaultSettings)
    : defaultSettings;

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, function(char) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;',
      }[char];
    });
  }

  function updateCartCount() {
    const total = cart.reduce((s, i) => s + i.qty, 0);
    document.querySelectorAll('.cart-dot, #cartCount').forEach(el => {
      el.textContent = total || '0';
    });
  }

  window.SUVERA.addToCart = function(name, price, emoji, meta = {}) {
    const existing = cart.find(i => i.name === name);
    if (existing) existing.qty++;
    else cart.push({ name, price, emoji: emoji || '🧕', qty: 1, ...meta });
    localStorage.setItem('suveraCart', JSON.stringify(cart));
    updateCartCount();
    showToast('Sepete eklendi ✓', 'green');
  };

  // ── TOAST ───────────────────────────────────────
  let toastTimer;
  window.SUVERA.toast =
  window.showToast = function(msg, type = 'dark') {
    let el = document.getElementById('suveraToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'suveraToast';
      el.className = 'suvera-toast';
      document.body.appendChild(el);
    }
    const icons = { green: '✓', red: '✕', dark: 'ℹ' };
    el.textContent = '';
    const icon = document.createElement('span');
    icon.className = 'suvera-toast-icon';
    icon.textContent = icons[type] || 'ℹ';
    el.appendChild(icon);
    el.appendChild(document.createTextNode(String(msg)));
    el.className = `suvera-toast toast-${type}`;
    // force reflow
    el.offsetWidth;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
  };

  // ── ANNOUNCE + NAV SCROLL ────────────────────────
  function initNavScroll() {
    const ann = document.querySelector('.announce');
    const nav = document.getElementById('mainNav') || document.querySelector('nav');
    if (!nav) return;
    const ANN_H = ann ? ann.offsetHeight : 0;

    function update() {
      if (window.scrollY >= ANN_H) {
        nav.classList.add('scrolled');
        if (ann) ann.classList.add('hidden');
      } else {
        nav.classList.remove('scrolled');
        if (ann) ann.classList.remove('hidden');
      }
    }
    window.addEventListener('scroll', update, { passive: true });
    update();
  }

  // ── MEGA MENU ───────────────────────────────────
  function buildNav() {
    const navWrap = document.querySelector('.nav-menu-wrap');
    if (!navWrap) return; // already built via HTML
    // Nav is built in HTML — just ensure hover works on touch
  }

  // Close mega on outside click / escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      // close modals, drawers, etc.
      document.querySelectorAll('.quick-view-modal.open, .mobile-nav.open').forEach(el => {
        el.classList.remove('open');
        document.body.style.overflow = '';
      });
      closeFilterDrawer();
    }
  });

  // ── MOBILE NAV DRAWER ───────────────────────────
  function initMobileNav() {
    // Inject drawer HTML if not present
    if (document.querySelector('.mobile-nav')) return;

    const drawerHTML = `
    <div class="mobile-nav" id="mobileNav">
      <div class="mobile-overlay" onclick="closeMobileNav()"></div>
      <div class="mobile-drawer">
        <div class="mobile-drawer-head">
          <span class="mobile-drawer-logo">SUVERA</span>
          <button class="mobile-drawer-close" onclick="closeMobileNav()">×</button>
        </div>
        <nav class="mobile-nav-items">
          <a href="index.html" class="mobile-nav-item">Ana Sayfa</a>
          <div class="mobile-nav-item" onclick="toggleMobileSub('mobGiyim')">
            Giyim <span>›</span>
          </div>
          <div class="mobile-nav-sub" id="mobGiyim">
            <a href="urunler.html">Tümü</a>
            <a href="urunler.html">Elbise</a>
            <a href="urunler.html">Bluz & Gömlek</a>
            <a href="urunler.html">Pantolon & Etek</a>
            <a href="urunler.html">Takım & Kombin</a>
          </div>
          <div class="mobile-nav-item" onclick="toggleMobileSub('mobDis')">
            Dış Giyim <span>›</span>
          </div>
          <div class="mobile-nav-sub" id="mobDis">
            <a href="urunler.html">Kaban & Mont</a>
            <a href="urunler.html">Trençkot</a>
            <a href="urunler.html">Ceket & Blazer</a>
          </div>
          <div class="mobile-nav-item" onclick="toggleMobileSub('mobAbaya')">
            Abaya & Ferace <span>›</span>
          </div>
          <div class="mobile-nav-sub" id="mobAbaya">
            <a href="urunler.html">Abaya</a>
            <a href="urunler.html">Ferace</a>
            <a href="urunler.html">Kuşaklı Modeller</a>
          </div>
          <a href="urunler.html" class="mobile-nav-item">Eşarp & Aksesuar</a>
          <a href="urunler.html" class="mobile-nav-item">Koleksiyonlar</a>
          <a href="urunler.html" class="mobile-nav-item outlet" style="color:#c44">Outlet</a>
        </nav>
        <div class="mobile-nav-footer">
          <a href="giris.html">👤 &nbsp; Hesabım</a>
          <a href="sepet.html">🛍️ &nbsp; Sepetim</a>
        </div>
      </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', drawerHTML);
  }

  window.openMobileNav = function() {
    document.getElementById('mobileNav')?.classList.add('open');
    document.body.style.overflow = 'hidden';
  };
  window.closeMobileNav = function() {
    document.getElementById('mobileNav')?.classList.remove('open');
    document.body.style.overflow = '';
  };
  window.toggleMobileSub = function(id) {
    const sub = document.getElementById(id);
    if (!sub) return;
    sub.classList.toggle('open');
  };

  // ── HAMBURGER ───────────────────────────────────
  function initHamburger() {
    const btn = document.querySelector('.hamburger');
    if (!btn) return;
    btn.addEventListener('click', () => {
      const isOpen = btn.classList.toggle('open');
      if (isOpen) openMobileNav();
      else closeMobileNav();
    });
  }

  // ── SCROLL REVEAL ───────────────────────────────
  function initScrollReveal() {
    const targets = document.querySelectorAll('.reveal, .stagger-children');
    if (!targets.length) return;

    const obs = new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          e.target.classList.add('show');
          // optional: unobserve after reveal
          // obs.unobserve(e.target);
        }
      });
    }, { threshold: 0.07, rootMargin: '0px 0px -40px 0px' });

    targets.forEach(el => obs.observe(el));
  }

  // ── PRODUCT CARD HEARTS ─────────────────────────
  function initWishlistBtns() {
    document.addEventListener('click', e => {
      const btn = e.target.closest('.prod-wish, .quick-fav');
      if (!btn) return;
      e.stopPropagation();
      const isActive = btn.classList.toggle('active');
      btn.textContent = isActive ? '❤️' : '🤍';
      showToast(isActive ? 'Favorilere eklendi ❤️' : 'Favorilerden çıkarıldı', isActive ? 'green' : 'dark');
    });
  }

  // ── QUICK VIEW MODAL ────────────────────────────
  function initQuickView() {
    document.addEventListener('click', e => {
      const btn = e.target.closest('.quick-view');
      if (!btn) return;
      e.stopPropagation();
      const card  = btn.closest('.prod-card');
      const productId = card?.dataset.productId || '';
      const name  = card?.dataset.productName || card?.querySelector('h4')?.textContent || 'Ürün';
      const price = card?.dataset.productPriceLabel || card?.querySelector('.p-new')?.textContent || '';
      const emoji = card?.dataset.productEmoji || card?.querySelector('.prod-emoji, [style*="z-index:1"]')?.textContent || '🧕';
      const image = card?.dataset.productImage || '';

      let modal = document.getElementById('quickViewModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'quickViewModal';
        modal.className = 'quick-view-modal';
        modal.innerHTML = `
          <div class="qv-box" role="dialog">
            <div class="qv-img" id="qvImg"></div>
            <div class="qv-info">
              <button class="qv-close" onclick="document.getElementById('quickViewModal').classList.remove('open');document.body.style.overflow=''">×</button>
              <p style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#888;margin-bottom:12px;">HIZLI ÖNIZLEME</p>
              <h2 id="qvName" style="font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:400;margin-bottom:10px;"></h2>
              <p id="qvPrice" style="font-size:20px;font-weight:600;color:#3d6b38;margin-bottom:24px;"></p>
              <div style="display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap;" id="qvSizes"></div>
              <a href="urun.html" id="qvLink" class="btn-primary" style="display:block;text-align:center;">Ürün Sayfasına Git →</a>
              <button id="qvAddBtn"
                style="width:100%;background:#3d6b38;color:#fff;border:none;padding:13px;font-family:'Jost',sans-serif;font-size:11px;letter-spacing:2px;text-transform:uppercase;cursor:pointer;margin-top:10px;transition:background .2s;"
                onmouseover="this.style.background='#2a4827'" onmouseout="this.style.background='#3d6b38'">Sepete Ekle</button>
            </div>
          </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', e => { if (e.target === modal) { modal.classList.remove('open'); document.body.style.overflow = ''; } });
      }

      const qvImg = document.getElementById('qvImg');
      qvImg.innerHTML = image
        ? '<img src="' + escapeHtml(image) + '" alt="' + escapeHtml(name) + '" style="width:100%;height:100%;object-fit:cover;display:block"/>'
        : escapeHtml(emoji);
      document.getElementById('qvName').textContent = name;
      document.getElementById('qvPrice').textContent = price;
      document.getElementById('qvLink').href = productId ? ('urun.html?id=' + productId) : 'urun.html';
      const sizes = ['XS','S','M','L','XL','XXL'];
      document.getElementById('qvSizes').innerHTML = sizes.map(s =>
        `<button onclick="this.style.background=this.style.background?'':'#1a1a1a';this.style.color=this.style.color?'':'#fff'"
          style="padding:8px 14px;border:1px solid #e8e2d9;background:#fff;font-family:'Jost',sans-serif;font-size:12px;cursor:pointer;transition:all .2s">${s}</button>`
      ).join('');
      document.getElementById('qvAddBtn').onclick = function () {
        if (productId && window.addApiProductToCart) {
          window.addApiProductToCart(productId);
        } else if (window.SUVERA) {
          window.SUVERA.addToCart(name, Number(card?.dataset.productPrice || 0), emoji);
        }
      };

      modal.classList.add('open');
      document.body.style.overflow = 'hidden';
    });
  }

  function applySiteSettings() {
    document.title = siteSettings.siteName || defaultSettings.siteName;

    const announce = document.querySelector('.announce');
    const announcementEnabled = !(siteSettings.features && siteSettings.features.announcement === false);
    if (announce) {
      announce.textContent = siteSettings.announcementText || defaultSettings.announcementText;
      announce.style.display = announcementEnabled ? '' : 'none';
    }
    document.documentElement.style.setProperty('--announcement-offset', announcementEnabled ? '38px' : '0px');

    if (siteSettings.features && siteSettings.features.maintenance) {
      let banner = document.getElementById('maintenanceBanner');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'maintenanceBanner';
        banner.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:9999;background:#1a1a1a;color:#fff;padding:10px 14px;font-size:12px;border-radius:6px;';
        document.body.appendChild(banner);
      }
      banner.textContent = 'Bakım modu açık. Sitede güncelleme yapılıyor.';
    }
  }

  // ── FILTER DRAWER (mobile) ──────────────────────
  window.openFilterDrawer = function() {
    document.getElementById('filterDrawer')?.classList.add('open');
    document.getElementById('filterDrawerOverlay')?.classList.add('open');
    document.body.style.overflow = 'hidden';
  };
  window.closeFilterDrawer = function() {
    document.getElementById('filterDrawer')?.classList.remove('open');
    document.getElementById('filterDrawerOverlay')?.classList.remove('open');
    document.body.style.overflow = '';
  };

  // ── STICKY BUY BAR (ürün detay, mobile) ─────────
  function initStickyBuy() {
    const bar = document.querySelector('.sticky-buy-bar');
    const addBtn = document.querySelector('.btn-cart');
    if (!bar || !addBtn) return;

    const obs = new IntersectionObserver(entries => {
      bar.classList.toggle('show', !entries[0].isIntersecting);
    }, { threshold: 0 });
    obs.observe(addBtn);
  }

  // ── NAV SEARCH ──────────────────────────────────
  function initNavSearch() {
    const icon = document.querySelector('.nav-search-icon');
    const box  = document.querySelector('.nav-search-box');
    if (!icon || !box) return;
    icon.addEventListener('click', () => {
      box.classList.toggle('open');
      if (box.classList.contains('open')) {
        box.querySelector('input')?.focus();
      }
    });
    box.querySelector('input')?.addEventListener('keydown', e => {
      if (e.key === 'Escape') box.classList.remove('open');
    });
  }

  // ── PAGE TRANSITION ─────────────────────────────
  function initPageTransitions() {
    let overlay = document.getElementById('pageTransitionOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'pageTransitionOverlay';
      overlay.className = 'page-transition-overlay';
      document.body.appendChild(overlay);
    }

    document.addEventListener('click', e => {
      const link = e.target.closest('a[href]');
      if (!link) return;
      const href = link.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto') || href.startsWith('tel') || link.target === '_blank') return;
      if (href.startsWith('http')) return;

      e.preventDefault();
      overlay.classList.add('fade-out');
      setTimeout(() => { window.location.href = href; }, 220);
    });
  }

  // ── INIT ALL ────────────────────────────────────
  function init() {
    applySiteSettings();
    updateCartCount();
    initNavScroll();
    buildNav();
    initMobileNav();
    initHamburger();
    initScrollReveal();
    initWishlistBtns();
    initQuickView();
    initNavSearch();
    initStickyBuy();
    // page transitions — subtle, opt-in
    // initPageTransitions(); // uncomment to enable
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
