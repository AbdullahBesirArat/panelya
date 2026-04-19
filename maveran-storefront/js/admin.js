// ═══════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════
let ADMIN_CATEGORY_ROWS = [];
let ADMIN_API_READY = false;
let CURRENT_PRODUCT_IMAGES = [];
let PENDING_PRODUCT_FILES = [];
const DEFAULT_SITE_SETTINGS = {
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
let SITE_SETTINGS = window.SuveraStore ? window.SuveraStore.loadSettings(DEFAULT_SITE_SETTINGS) : DEFAULT_SITE_SETTINGS;

let DATA = JSON.parse(localStorage.getItem('suveraAdmin') || 'null') || {
  products: [
    {id:1, name:'Oversize Uzun Rahat Elbise', category:'Elbise', price:999.90, salePrice:749.90, stock:24, status:'active', colors:['#6b5044','#8b9b6c','#7c7c7c'], sizes:['S','M','L'], tags:'yeni sezon', desc:'', emoji:'🧕', createdAt:'2025-03-01'},
    {id:2, name:'Krep Dokulu Abaya', category:'Abaya & Ferace', price:1249.90, salePrice:null, stock:12, status:'active', colors:['#111','#1a2a4c'], sizes:['S/M','M/L'], tags:'yeni', desc:'', emoji:'👘', createdAt:'2025-03-05'},
    {id:3, name:'Palazzo Keten Takım', category:'Takım & Kombin', price:1099.90, salePrice:null, stock:8, status:'active', colors:['#c4ac78','#8b9b6c'], sizes:['S','M','L','XL'], tags:'', desc:'', emoji:'🥻', createdAt:'2025-03-08'},
    {id:4, name:'İpek Modal Eşarp', category:'Eşarp & Aksesuar', price:449.90, salePrice:349.90, stock:3, status:'active', colors:['#e0d4c4','#b8a8a0','#8ca898'], sizes:[], tags:'indirim', desc:'', emoji:'🧣', createdAt:'2025-02-20'},
    {id:5, name:'Uzun Trençkot', category:'Dış Giyim', price:1999.90, salePrice:1399.90, stock:0, status:'out', colors:['#c0a882','#6b6060'], sizes:['S','M','L'], tags:'', desc:'', emoji:'🧥', createdAt:'2025-02-15'},
    {id:6, name:'Viskon Şifon Bluz', category:'Elbise', price:699.90, salePrice:null, stock:31, status:'active', colors:['#c4a8b8'], sizes:['S','M','L','XL'], tags:'', desc:'', emoji:'🧕', createdAt:'2025-03-10'},
    {id:7, name:'Bağlama Yaka Bluz Ekru', category:'Elbise', price:2499.90, salePrice:1799.90, stock:5, status:'draft', colors:['#f0ece0','#111','#8b9b6c'], sizes:['S/M','M/L'], tags:'indirim', desc:'Bağlama yaka detaylı, %100 pamuk.', emoji:'🧕', createdAt:'2025-03-15'},
    {id:8, name:'Kuşaklı Maxi Abaya', category:'Abaya & Ferace', price:1549.90, salePrice:null, stock:15, status:'active', colors:['#c0a870','#111'], sizes:['S/M','M/L'], tags:'', desc:'', emoji:'👘', createdAt:'2025-03-12'},
  ],
  categories: ['Elbise','Abaya & Ferace','Takım & Kombin','Eşarp & Aksesuar','Dış Giyim','Bluz & Gömlek'],
  orders: [
    {id:'#1001', date:'2025-03-23', customer:'Ayşe Kaya', email:'ayse@mail.com', phone:'05xx xxx xx xx', items:'Oversize Elbise x2', total:1499.80, status:'new', address:'İstanbul'},
    {id:'#1002', date:'2025-03-22', customer:'Fatma Yılmaz', email:'fatma@mail.com', phone:'05xx xxx xx xx', items:'Krep Abaya x1', total:1249.90, status:'processing', address:'Ankara'},
    {id:'#1003', date:'2025-03-22', customer:'Zeynep Demir', email:'zeynep@mail.com', phone:'05xx xxx xx xx', items:'Modal Eşarp x3', total:1049.70, status:'shipped', address:'İzmir'},
    {id:'#1004', date:'2025-03-21', customer:'Halime Öztürk', email:'halime@mail.com', phone:'05xx xxx xx xx', items:'Palazzo Takım x1, Eşarp x1', total:1449.80, status:'delivered', address:'Bursa'},
    {id:'#1005', date:'2025-03-20', customer:'Merve Çelik', email:'merve@mail.com', phone:'05xx xxx xx xx', items:'Bağlama Bluz x1', total:1799.90, status:'delivered', address:'İstanbul'},
    {id:'#1006', date:'2025-03-19', customer:'Sümeyye Arslan', email:'s@mail.com', phone:'05xx xxx xx xx', items:'Uzun Trençkot x1', total:1399.90, status:'cancelled', address:'Antalya'},
  ],
  customers: [],
  campaigns: [
    {id:1, name:'Bayrama Özel', type:'Yüzde İndirim (%)', value:20, end:'2025-04-10', active:true},
    {id:2, name:'3 Al 2 Öde', type:'3 Al 2 Öde', value:0, end:'2025-04-01', active:true},
  ],
  sliderItems: [
    {id:1, tag:'2025 İlkbahar – Yaz Koleksiyonu', title:'Örtünmek bir zarafet,', sub:'bir kimlik.', btn:'Koleksiyonu Keşfet', active:true},
    {id:2, tag:'Eşarp ve Bere Kategorisinde', title:'3 AL 2 ÖDE', sub:'', btn:'Alışverişe Başla', active:true},
    {id:3, tag:'Bayrama Özel', title:'%20 – %30 İNDİRİM', sub:'Seçili ürünlerde', btn:'Alışverişe Başla', active:true},
    {id:4, tag:'Özel Koleksiyon', title:'Zensational Collection', sub:'Sakinliği ve zerafeti bir arada', btn:'Koleksiyonu Gör', active:false},
  ]
};

DATA = window.SuveraStore ? window.SuveraStore.loadAdmin(DATA) : DATA;

function saveData() {
  if (window.SuveraStore) window.SuveraStore.saveAdmin(DATA);
  else localStorage.setItem('suveraAdmin', JSON.stringify(DATA));
}
let nextId = Math.max(...DATA.products.map(p=>p.id), 0) + 1;

function slugify(value) {
  return String(value || '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's')
    .replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function mapApiProduct(p) {
  return {
    id: Number(p.id),
    name: p.name,
    category: p.category_name || DATA.categories[0] || 'Genel',
    categoryId: p.category_id,
    price: Number(p.price || 0),
    salePrice: p.sale_price == null ? null : Number(p.sale_price),
    stock: Number(p.stock || 0),
    status: p.status || 'draft',
    colors: Array.isArray(p.colors) ? p.colors : [],
    sizes: Array.isArray(p.sizes) ? p.sizes : [],
    images: Array.isArray(p.images) ? p.images : [],
    details: p.details && typeof p.details === 'object' ? p.details : {},
    tags: p.tags || '',
    desc: p.description || '',
    emoji: p.emoji || '👗',
    createdAt: String(p.created_at || '').slice(0, 10),
  };
}

function mapApiOrder(o) {
  return {
    apiId: o.id,
    id: o.order_code || `#${o.id}`,
    date: String(o.created_at || '').slice(0, 10),
    customer: o.customer || 'Web Müşterisi',
    email: o.email || '',
    phone: o.phone || '',
    items: o.items || 'Sipariş kalemi yok',
    total: Number(o.total || 0),
    status: o.status || 'new',
    address: o.address || '',
    shippingCompany: o.shipping_company || '',
    trackingNumber: o.tracking_number || '',
    trackingUrl: o.tracking_url || '',
    shippedAt: o.shipped_at ? String(o.shipped_at).slice(0, 10) : '',
  };
}

function mapApiCustomer(c) {
  return {
    name: c.name || 'Müşteri',
    email: c.email || '',
    phone: c.phone || '',
    orders: Number(c.orders || 0),
    total: Number(c.total || 0),
    date: String(c.created_at || '').slice(0, 10),
  };
}

function mapApiSlide(s) {
  return {
    id: Number(s.id),
    tag: s.tag || '',
    title: s.title || '',
    sub: s.sub || '',
    btn: s.btn || 'Keşfet',
    imageUrl: s.image_url || '',
    active: Boolean(s.active),
    sortOrder: Number(s.sort_order || 0),
  };
}

function slidePayload(slide, index) {
  return {
    tag: slide.tag || '',
    title: slide.title || '',
    sub: slide.sub || '',
    btn: slide.btn || 'Keşfet',
    image_url: slide.imageUrl || '',
    active: Boolean(slide.active),
    sort_order: slide.sortOrder ?? index ?? 0,
  };
}

function mapApiCampaign(c) {
  return {
    id: Number(c.id),
    name: c.name || '',
    type: c.type || '',
    value: Number(c.value || 0),
    end: c.end_date ? String(c.end_date).slice(0, 10) : '—',
    endDate: c.end_date ? String(c.end_date).slice(0, 10) : '',
    active: Boolean(c.active),
  };
}

function campaignPayload(campaign) {
  return {
    name: campaign.name,
    type: campaign.type,
    value: Number(campaign.value || 0),
    end_date: campaign.endDate || (campaign.end && campaign.end !== '—' ? campaign.end : null),
    active: Boolean(campaign.active),
  };
}

function productPayloadFromForm(product) {
  const category = ADMIN_CATEGORY_ROWS.find(c => c.name === product.category);
  return {
    name: product.name,
    category_id: category ? category.id : null,
    price: product.price,
    sale_price: product.salePrice,
    stock: product.stock,
    status: product.status,
    colors: product.colors,
    sizes: product.sizes,
    images: product.images || [],
    details: product.details || {},
    tags: product.tags,
    description: product.desc,
    emoji: product.emoji,
  };
}

async function refreshAdminData() {
  if (!window.MaveranAPI) return false;

  try {
    const [categories, products, orders, customers, slides, campaigns] = await Promise.all([
      window.MaveranAPI.categories.list(),
      window.MaveranAPI.products.list('?limit=500'),
      window.MaveranAPI.orders.list('?limit=500'),
      window.MaveranAPI.customers.list('?limit=500'),
      window.MaveranAPI.slider.adminList(),
      window.MaveranAPI.campaigns.adminList(),
    ]);

    ADMIN_CATEGORY_ROWS = categories;
    DATA.categories = categories.map(c => c.name);
    DATA.products = products.map(mapApiProduct);
    DATA.orders = orders.map(mapApiOrder);
    DATA.customers = customers.map(mapApiCustomer);
    DATA.sliderItems = slides.map(mapApiSlide);
    DATA.campaigns = campaigns.map(mapApiCampaign);
    ADMIN_API_READY = true;
    saveData();
    return true;
  } catch (err) {
    ADMIN_API_READY = false;
    console.warn('Admin API verisi alınamadı, localStorage kullanılacak:', err.message);
    return false;
  }
}

function syncProductCategoryFilter() {
  const sel = document.getElementById('prodCatFilter');
  if (!sel) return;
  const current = sel.value;
  sel.textContent = '';
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'Tüm Kategoriler';
  sel.appendChild(allOption);
  DATA.categories.forEach((category) => {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    sel.appendChild(option);
  });
  sel.value = current;
}

// ═══════════════════════════════════════════════
//  AUTH
// ═══════════════════════════════════════════════
async function doLogin() {
  const u = document.getElementById('loginUser').value;
  const p = document.getElementById('loginPass').value;

  if (!window.MaveranAPI) {
    document.getElementById('loginErr').style.display = 'block';
    return;
  }

  try {
    await window.MaveranAPI.login(u, p);
    await refreshAdminData();
    document.getElementById('loginScreen').style.display = 'none';
    initApp();
    toast('API bağlantısı aktif', 'success');
  } catch (err) {
    console.warn('API girişi başarısız:', err.message);
    document.getElementById('loginErr').style.display = 'block';
  }
}
document.getElementById('loginPass').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });

function doLogout() {
  if (window.MaveranAPI) window.MaveranAPI.logout();
  ADMIN_API_READY = false;
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('loginPass').value = '';
}

// ═══════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════
const pageTitles = {
  dashboard:'Dashboard', products:'Ürün Yönetimi', categories:'Kategori Yönetimi',
  orders:'Sipariş Yönetimi', customers:'Müşteriler',
  slider:'Slider Yönetimi', campaigns:'Kampanyalar', settings:'Ayarlar'
};
const topbarActions = {
  products:  {label:'+ Ürün Ekle',      fn: 'openProductModal()'},
  orders:    {label:'Siparişleri Yenile', fn: "toast('Siparişler yenilendi','success')"},
  campaigns: {label:'+ Kampanya Ekle',   fn: "document.getElementById('campName').focus()"},
  slider:    {label:'+ Slayt Ekle',      fn: 'addSliderItem()'},
  dashboard: {label:'Veriyi Yenile',       fn: 'refreshDashboardData()'},
};

function showPage(name, el) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  if(el) el.classList.add('active');
  document.getElementById('topbarTitle').textContent = pageTitles[name] || name;
  const act = topbarActions[name] || {label:'', fn:''};
  const btn = document.getElementById('topbarAction');
  btn.textContent = act.label;
  btn.style.display = act.label ? '' : 'none';
  window._topbarFn = act.fn;
  // render page-specific content
  if(name === 'products')   renderProducts();
  if(name === 'categories') renderCategories();
  if(name === 'orders')     renderOrders();
  if(name === 'customers')  renderCustomers();
  if(name === 'slider')     renderSlider();
  if(name === 'campaigns')  renderCampaigns();
  if(name === 'dashboard')  renderDashboard();
  if(name === 'settings')   fillSettingsForm();
}

function topbarActionFn() { eval(window._topbarFn || ''); }

async function refreshDashboardData() {
  if (window.MaveranAPI) await refreshAdminData();
  renderDashboard();
  renderProducts();
  renderOrders();
  renderCategories();
  renderCustomers();
  toast('Yönetim verileri yenilendi','success');
}

function fillSettingsForm() {
  document.getElementById('siteNameInput').value = SITE_SETTINGS.siteName || DEFAULT_SITE_SETTINGS.siteName;
  document.getElementById('announcementInput').value = SITE_SETTINGS.announcementText || DEFAULT_SITE_SETTINGS.announcementText;
  document.getElementById('freeShippingInput').value = SITE_SETTINGS.freeShippingLimit || DEFAULT_SITE_SETTINGS.freeShippingLimit;
  document.getElementById('featureAnnouncement').checked = SITE_SETTINGS.features?.announcement !== false;
  document.getElementById('featureNewBadge').checked = SITE_SETTINGS.features?.newBadge !== false;
  document.getElementById('featureFavorites').checked = SITE_SETTINGS.features?.favorites !== false;
  document.getElementById('featureWhatsapp').checked = SITE_SETTINGS.features?.whatsapp !== false;
  document.getElementById('featureMaintenance').checked = !!SITE_SETTINGS.features?.maintenance;
}

function persistSettings() {
  if (window.SuveraStore) window.SuveraStore.saveSettings(SITE_SETTINGS);
}

function saveSiteSettings() {
  SITE_SETTINGS.siteName = document.getElementById('siteNameInput').value.trim() || DEFAULT_SITE_SETTINGS.siteName;
  SITE_SETTINGS.announcementText = document.getElementById('announcementInput').value.trim() || DEFAULT_SITE_SETTINGS.announcementText;
  SITE_SETTINGS.freeShippingLimit = Number(document.getElementById('freeShippingInput').value || DEFAULT_SITE_SETTINGS.freeShippingLimit);
  persistSettings();
  toast('Site ayarları kaydedildi. Sayfayı yenileyince görünür.','success');
}

function saveFeatureSettings() {
  SITE_SETTINGS.features = {
    announcement: document.getElementById('featureAnnouncement').checked,
    newBadge: document.getElementById('featureNewBadge').checked,
    favorites: document.getElementById('featureFavorites').checked,
    whatsapp: document.getElementById('featureWhatsapp').checked,
    maintenance: document.getElementById('featureMaintenance').checked,
  };
  persistSettings();
  toast('Özellik ayarları kaydedildi. Sayfayı yenileyince görünür.','success');
}

function changeAdminPassword() {
  document.getElementById('currentAdminPass').value = '';
  document.getElementById('newAdminPass').value = '';
  toast('Admin şifresi artık sunucuda bcrypt hash ile yönetilir','error');
}

// ═══════════════════════════════════════════════
//  DASHBOARD
// ═══════════════════════════════════════════════
function renderDashboard() {
  const totalRev = DATA.orders.filter(o=>!['cancelled','payment_pending'].includes(o.status)).reduce((s,o)=>s+o.total,0);
  document.getElementById('statRevenue').textContent = '₺' + totalRev.toLocaleString('tr-TR',{minimumFractionDigits:2});
  document.getElementById('statOrders').textContent = DATA.orders.length;
  document.getElementById('statProducts').textContent = DATA.products.filter(p=>p.status==='active').length;

  // chart
  const days = ['Pzt','Sal','Çar','Per','Cum','Cmt','Paz'];
  const vals = [4200, 6800, 5100, 9200, 7800, 11400, 8600];
  const max = Math.max(...vals);
  const chart = document.getElementById('salesChart');
  chart.innerHTML = days.map((d,i) => `
    <div class="chart-bar-col">
      <div class="chart-bar-val">₺${(vals[i]/1000).toFixed(1)}k</div>
      <div class="chart-bar" style="height:${(vals[i]/max*100)}px" title="${d}: ₺${vals[i].toLocaleString('tr-TR')}"></div>
      <div class="chart-bar-label">${d}</div>
    </div>`).join('');

  // recent orders
  const tbody = document.getElementById('recentOrdersTbody');
  tbody.innerHTML = DATA.orders.slice(0,5).map(o => `
    <tr>
      <td><b>${escapeHtml(o.id)}</b></td>
      <td>${escapeHtml(o.customer)}</td>
      <td><b>₺${o.total.toLocaleString('tr-TR',{minimumFractionDigits:2})}</b></td>
      <td>${statusBadge(o.status)}</td>
    </tr>`).join('');

  // low stock
  const low = DATA.products.filter(p=>p.stock < 10).sort((a,b)=>a.stock-b.stock);
  document.getElementById('lowStockTbody').innerHTML = low.length ? low.map(p=>`
    <tr>
      <td><div class="td-name">${escapeHtml(p.emoji)} ${escapeHtml(p.name)}</div></td>
      <td>${escapeHtml(p.category)}</td>
      <td><b style="color:${p.stock===0?'var(--red)':'var(--yellow)'}">${p.stock}</b></td>
      <td>${p.stock===0 ? '<span class="badge badge-red">Stok Yok</span>' : '<span class="badge badge-yellow">Kritik Stok</span>'}</td>
    </tr>`).join('') : '<tr><td colspan="4" class="empty">✅ Tüm ürünlerin stoğu yeterli</td></tr>';
}

// ═══════════════════════════════════════════════
//  PRODUCTS
// ═══════════════════════════════════════════════
function renderProducts() {
  const q      = (document.getElementById('prodSearch')?.value||'').toLowerCase();
  const cat    = document.getElementById('prodCatFilter')?.value || '';
  const status = document.getElementById('prodStatusFilter')?.value || '';

  // fill category filter
  const catSel = document.getElementById('prodCatFilter');
  if(catSel && catSel.options.length <= 1) {
    syncProductCategoryFilter();
  }

  let list = DATA.products.filter(p =>
    (!q || p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)) &&
    (!cat || p.category === cat) &&
    (!status || p.status === status)
  );

  document.getElementById('prodCount').textContent = `Ürünler (${list.length})`;

  document.getElementById('productsTbody').innerHTML = list.length ? list.map(p => `
    <tr>
      <td><div class="td-img">${p.images && p.images[0] ? `<img src="${safeAttr(window.MaveranAPI ? window.MaveranAPI.assetUrl(p.images[0]) : p.images[0])}" style="width:100%;height:100%;object-fit:cover;border-radius:4px;"/>` : escapeHtml(p.emoji||'👗')}</div></td>
      <td>
        <div class="td-name">${escapeHtml(p.name)}</div>
        <div class="td-sub">${escapeHtml(p.sizes.join(', ')||'—')} &nbsp;·&nbsp; ${escapeHtml(p.tags||'—')}</div>
      </td>
      <td><span class="badge badge-gray">${escapeHtml(p.category)}</span></td>
      <td>₺${p.price.toLocaleString('tr-TR',{minimumFractionDigits:2})}</td>
      <td>${p.salePrice ? '<b style="color:var(--red)">₺'+p.salePrice.toLocaleString('tr-TR',{minimumFractionDigits:2})+'</b>' : '<span style="color:#ccc">—</span>'}</td>
      <td><b style="color:${p.stock===0?'var(--red)':p.stock<10?'var(--yellow)':'inherit'}">${p.stock}</b></td>
      <td>${statusProdBadge(p.status)}</td>
      <td>
        <button class="act-btn" onclick="editProduct(${p.id})" title="Düzenle">✏️</button>
        <button class="act-btn" onclick="toggleProdStatus(${p.id})" title="Aktif/Pasif">${p.status==='active'?'⏸':'▶'}</button>
        <button class="act-btn del" onclick="deleteProduct(${p.id})" title="Sil">🗑️</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="8"><div class="empty"><div class="empty-icon">🔍</div><p>Ürün bulunamadı</p></div></td></tr>`;
}

function statusProdBadge(s) {
  const map = {active:'<span class="badge badge-green">Aktif</span>', draft:'<span class="badge badge-gray">Taslak</span>', out:'<span class="badge badge-red">Stok Yok</span>'};
  return map[s]||s;
}

function openProductModal(id) {
  document.getElementById('productModalTitle').textContent = id ? 'Ürünü Düzenle' : 'Ürün Ekle';
  document.getElementById('editProductId').value = id || '';
  // fill category select
  const sel = document.getElementById('pCategory');
  sel.textContent = '';
  DATA.categories.forEach((category) => {
    const option = document.createElement('option');
    option.value = category;
    option.textContent = category;
    sel.appendChild(option);
  });
  // reset
  if(!id) {
    ['pName','pPrice','pSalePrice','pStock','pDesc','pTags','pShortDesc','pStory','pMeasurements','pDeliveryNote'].forEach(f=>document.getElementById(f).value='');
    document.getElementById('pStatus').value = 'active';
    document.querySelectorAll('#sizeSelector input').forEach(c=>{ c.checked = ['S','M','L'].includes(c.value); });
    document.querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('selected'));
    CURRENT_PRODUCT_IMAGES = [];
    PENDING_PRODUCT_FILES = [];
    document.getElementById('imgInput').value = '';
    document.getElementById('imgPreview').innerHTML = '';
  } else {
    const p = DATA.products.find(x=>x.id===id);
    document.getElementById('pName').value = p.name;
    document.getElementById('pCategory').value = p.category;
    document.getElementById('pPrice').value = p.price;
    document.getElementById('pSalePrice').value = p.salePrice||'';
    document.getElementById('pStock').value = p.stock;
    document.getElementById('pStatus').value = p.status;
    document.getElementById('pDesc').value = p.desc||'';
    document.getElementById('pTags').value = p.tags||'';
    document.getElementById('pShortDesc').value = p.details?.short_description || '';
    document.getElementById('pStory').value = p.details?.story || '';
    document.getElementById('pMeasurements').value = p.details?.measurements || '';
    document.getElementById('pDeliveryNote').value = p.details?.delivery_note || '';
    CURRENT_PRODUCT_IMAGES = [...(p.images || [])];
    PENDING_PRODUCT_FILES = [];
    document.getElementById('imgInput').value = '';
    document.querySelectorAll('#sizeSelector input').forEach(c=>{ c.checked = p.sizes.includes(c.value); });
    document.querySelectorAll('.color-swatch').forEach(s=>{ s.classList.toggle('selected', p.colors.includes(s.dataset.color)); });
    renderImagePreview(p.emoji || '👗');
  }
  document.getElementById('productModal').classList.add('open');
}

function editProduct(id) { openProductModal(id); }

async function saveProduct() {
  const name = document.getElementById('pName').value.trim();
  const cat  = document.getElementById('pCategory').value;
  const price = parseFloat(document.getElementById('pPrice').value);
  if(!name || !price) { toast('Ürün adı ve fiyat zorunludur','error'); return; }
  const sizes  = [...document.querySelectorAll('#sizeSelector input:checked')].map(c=>c.value);
  const colors = [...document.querySelectorAll('.color-swatch.selected')].map(s=>s.dataset.color);
  const editId = parseInt(document.getElementById('editProductId').value)||null;

  let images = [...CURRENT_PRODUCT_IMAGES];
  if (PENDING_PRODUCT_FILES.length && ADMIN_API_READY && window.MaveranAPI) {
    try {
      toast('Görseller yükleniyor...', 'success');
      const upload = await window.MaveranAPI.upload.images(PENDING_PRODUCT_FILES);
      images = images.concat((upload.files || []).map(file => file.url));
      CURRENT_PRODUCT_IMAGES = images;
      PENDING_PRODUCT_FILES = [];
    } catch (err) {
      toast(err.message || 'Görsel yükleme başarısız','error');
      return;
    }
  }

  const product = {
    id: editId || nextId++,
    name, category:cat, price,
    salePrice: parseFloat(document.getElementById('pSalePrice').value)||null,
    stock: parseInt(document.getElementById('pStock').value)||0,
    status: document.getElementById('pStatus').value,
    desc: document.getElementById('pDesc').value,
    details: {
      short_description: document.getElementById('pShortDesc').value.trim(),
      story: document.getElementById('pStory').value.trim(),
      measurements: document.getElementById('pMeasurements').value.trim(),
      delivery_note: document.getElementById('pDeliveryNote').value.trim(),
    },
    tags: document.getElementById('pTags').value,
    sizes, colors,
    images,
    emoji: ['🧕','👘','🥻','🧥','🧣','👗','💍'][Math.floor(Math.random()*7)],
    createdAt: new Date().toISOString().split('T')[0]
  };

  if (ADMIN_API_READY && window.MaveranAPI) {
    try {
      const payload = productPayloadFromForm(product);
      const saved = editId
        ? await window.MaveranAPI.products.update(editId, payload)
        : await window.MaveranAPI.products.create(payload);
      const mapped = mapApiProduct(saved);
      if (editId) {
        const idx = DATA.products.findIndex(p=>p.id===editId);
        if (idx >= 0) DATA.products[idx] = mapped;
      } else {
        DATA.products.unshift(mapped);
      }
      saveData(); closeModal('productModal'); renderProducts();
      document.getElementById('statProducts').textContent = DATA.products.filter(p=>p.status==='active').length;
      toast(editId ? 'Ürün API üzerinden güncellendi ✓' : 'Ürün API üzerinden eklendi ✓','success');
      return;
    } catch (err) {
      toast(err.message || 'API ürün kaydı başarısız','error');
      return;
    }
  }

  if(editId) {
    const idx = DATA.products.findIndex(p=>p.id===editId);
    DATA.products[idx] = {...DATA.products[idx], ...product};
    toast('Ürün güncellendi ✓','success');
  } else {
    DATA.products.unshift(product);
    toast('Ürün eklendi ✓','success');
  }
  saveData(); closeModal('productModal'); renderProducts();
  document.getElementById('statProducts').textContent = DATA.products.filter(p=>p.status==='active').length;
}

async function deleteProduct(id) {
  if(!confirm('Bu ürünü silmek istediğinize emin misiniz?')) return;
  if (ADMIN_API_READY && window.MaveranAPI) {
    try {
      await window.MaveranAPI.products.remove(id);
    } catch (err) {
      toast(err.message || 'API ürün silme başarısız','error');
      return;
    }
  }
  DATA.products = DATA.products.filter(p=>p.id!==id);
  saveData(); renderProducts(); toast('Ürün silindi','error');
}

async function toggleProdStatus(id) {
  const p = DATA.products.find(x=>x.id===id);
  p.status = p.status==='active' ? 'draft' : 'active';

  if (ADMIN_API_READY && window.MaveranAPI) {
    try {
      const saved = await window.MaveranAPI.products.update(id, productPayloadFromForm(p));
      Object.assign(p, mapApiProduct(saved));
    } catch (err) {
      toast(err.message || 'API durum güncelleme başarısız','error');
      return;
    }
  }

  saveData(); renderProducts();
  toast(p.status==='active' ? 'Ürün aktif edildi' : 'Ürün pasife alındı','success');
}

function toggleColor(el) { el.classList.toggle('selected'); }

function addCustomColor() {
  const hex = prompt('Renk kodu girin (örn: #ff0000):');
  if(!hex || !/^#[0-9a-fA-F]{3,6}$/.test(hex)) return;
  const el = document.createElement('div');
  el.className='color-swatch selected'; el.style.background=hex; el.dataset.color=hex;
  el.innerHTML='<span class="ck">✓</span>';
  el.onclick=()=>el.classList.toggle('selected');
  document.getElementById('colorPicker').insertBefore(el, document.querySelector('.color-add'));
}

function renderImagePreview(fallbackEmoji='👗') {
  const preview = document.getElementById('imgPreview');
  const existing = CURRENT_PRODUCT_IMAGES.map((url, index) => `
    <div class="img-preview-item">
      <img src="${safeAttr(window.MaveranAPI ? window.MaveranAPI.assetUrl(url) : url)}" style="width:100%;height:100%;object-fit:cover;border-radius:4px;"/>
      <button class="rm" onclick="removeExistingImage(${index})">×</button>
    </div>
  `).join('');

  preview.innerHTML = existing || `<div class="img-preview-item">${escapeHtml(fallbackEmoji)}<button class="rm" onclick="this.parentElement.remove()">×</button></div>`;

  PENDING_PRODUCT_FILES.forEach((file, index) => {
    const reader = new FileReader();
    reader.onload = e => {
      const div = document.createElement('div'); div.className='img-preview-item';
      div.innerHTML = `<img src="${safeAttr(e.target.result)}" style="width:100%;height:100%;object-fit:cover;border-radius:4px;"/><button class="rm" onclick="removePendingImage(${index})">×</button>`;
      preview.appendChild(div);
    };
    reader.readAsDataURL(file);
  });
}

function previewImages(input) {
  PENDING_PRODUCT_FILES = Array.from(input.files || []);
  renderImagePreview();
}

function removeExistingImage(index) {
  CURRENT_PRODUCT_IMAGES.splice(index, 1);
  renderImagePreview();
}

function removePendingImage(index) {
  PENDING_PRODUCT_FILES.splice(index, 1);
  const input = document.getElementById('imgInput');
  if (input) input.value = '';
  renderImagePreview();
}

function exportCSV() {
  const rows = [['ID','Ad','Kategori','Fiyat','İndirimli','Stok','Durum']];
  DATA.products.forEach(p => rows.push([p.id,p.name,p.category,p.price,p.salePrice||'',p.stock,p.status]));
  const csv = rows.map(r=>r.join(',')).join('\n');
  const a = document.createElement('a'); a.href='data:text/csv;charset=utf-8,\uFEFF'+encodeURI(csv);
  a.download='suvera-urunler.csv'; a.click();
  toast('CSV indirildi','success');
}

// ═══════════════════════════════════════════════
//  CATEGORIES
// ═══════════════════════════════════════════════
function renderCategories() {
  document.getElementById('categoriesTbody').innerHTML = DATA.categories.map((c,i)=>`
    <tr>
      <td><b>${escapeHtml(c)}</b></td>
      <td style="color:var(--mid)">${escapeHtml(slugify(c))}</td>
      <td>${DATA.products.filter(p=>p.category===c).length} ürün</td>
      <td>
        <button class="act-btn del" onclick="deleteCategory(${i})">🗑️</button>
      </td>
    </tr>`).join('');
}

async function addCategory() {
  const name = document.getElementById('newCatName').value.trim();
  if(!name) { toast('Kategori adı girin','error'); return; }
  if(DATA.categories.includes(name)) { toast('Bu kategori zaten var','error'); return; }

  if (ADMIN_API_READY && window.MaveranAPI) {
    try {
      const created = await window.MaveranAPI.categories.create({ name, slug: slugify(name) });
      ADMIN_CATEGORY_ROWS.push(created);
    } catch (err) {
      toast(err.message || 'API kategori kaydı başarısız','error');
      return;
    }
  }

  DATA.categories.push(name);
  document.getElementById('newCatName').value='';
  syncProductCategoryFilter();
  saveData(); renderCategories(); toast('Kategori eklendi ✓','success');
}

async function deleteCategory(i) {
  if(!confirm('Bu kategoriyi silmek istediğinize emin misiniz?')) return;
  const name = DATA.categories[i];

  if (ADMIN_API_READY && window.MaveranAPI) {
    const row = ADMIN_CATEGORY_ROWS.find(c => c.name === name);
    try {
      if (row) await window.MaveranAPI.categories.remove(row.id);
      ADMIN_CATEGORY_ROWS = ADMIN_CATEGORY_ROWS.filter(c => c.name !== name);
    } catch (err) {
      toast(err.message || 'API kategori silme başarısız','error');
      return;
    }
  }

  DATA.categories.splice(i,1);
  syncProductCategoryFilter();
  saveData(); renderCategories(); toast('Kategori silindi','error');
}

// ═══════════════════════════════════════════════
//  ORDERS
// ═══════════════════════════════════════════════
function statusBadge(s) {
  const map = {
    new:'<span class="badge badge-blue">Yeni</span>',
    payment_pending:'<span class="badge badge-yellow">Ödeme Bekliyor</span>',
    paid:'<span class="badge badge-green">Ödendi</span>',
    processing:'<span class="badge badge-yellow">Hazırlanıyor</span>',
    shipped:'<span class="badge badge-blue">Kargoda</span>',
    delivered:'<span class="badge badge-green">Teslim Edildi</span>',
    cancelled:'<span class="badge badge-red">İptal</span>'
  };
  return map[s]||s;
}

function renderOrders() {
  const q   = (document.getElementById('orderSearch')?.value||'').toLowerCase();
  const st  = document.getElementById('orderStatusFilter')?.value||'';
  let list = DATA.orders.filter(o=>
    (!q || o.id.toLowerCase().includes(q) || o.customer.toLowerCase().includes(q)) &&
    (!st || o.status===st)
  );
  document.getElementById('orderCount').textContent = `Siparişler (${list.length})`;
  document.getElementById('newOrderBadge').textContent = DATA.orders.filter(o=>o.status==='new').length;
  document.getElementById('ordersTbody').innerHTML = list.map(o=>`
    <tr>
      <td><b>${escapeHtml(o.id)}</b></td>
      <td style="color:var(--mid)">${escapeHtml(o.date)}</td>
      <td>${escapeHtml(o.customer)}</td>
      <td style="font-size:12.5px;color:var(--mid)">${escapeHtml(o.items)}</td>
      <td><b>₺${o.total.toLocaleString('tr-TR',{minimumFractionDigits:2})}</b></td>
      <td>${statusBadge(o.status)}</td>
      <td>
        <button class="act-btn" onclick="viewOrder('${safeAttr(o.id)}')" title="Detay">👁️</button>
        <button class="act-btn" onclick="changeOrderStatus('${safeAttr(o.id)}')" title="Durumu değiştir">🔄</button>
      </td>
    </tr>`).join('');
}

function viewOrder(id) {
  const o = DATA.orders.find(x=>x.id===id);
  const trackingLink = o.trackingUrl
    ? `<a href="${safeAttr(o.trackingUrl)}" target="_blank" rel="noopener" style="color:var(--accent);font-size:13px;">Takip linkini aç</a>`
    : '<span style="font-size:13px;color:var(--mid)">Takip linki yok</span>';
  document.getElementById('orderModalTitle').textContent = 'Sipariş ' + o.id;
  document.getElementById('orderModalBody').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">
      <div><p style="font-size:11.5px;color:var(--mid);">MÜŞTERİ</p><p style="font-weight:600;margin-top:4px;">${escapeHtml(o.customer)}</p><p style="font-size:13px;color:var(--mid)">${escapeHtml(o.email)}</p><p style="font-size:13px;color:var(--mid)">${escapeHtml(o.phone)}</p></div>
      <div><p style="font-size:11.5px;color:var(--mid);">TESLİMAT ADRESİ</p><p style="font-weight:500;margin-top:4px;">${escapeHtml(o.address)}</p></div>
    </div>
    <div style="background:var(--bg);border-radius:var(--radius);padding:14px;margin-bottom:16px;">
      <p style="font-size:11.5px;color:var(--mid);margin-bottom:8px;">ÜRÜNLER</p>
      <p style="font-size:14px;">${escapeHtml(o.items)}</p>
      <p style="font-size:18px;font-weight:700;margin-top:10px;">Toplam: ₺${o.total.toLocaleString('tr-TR',{minimumFractionDigits:2})}</p>
    </div>
    <div style="background:var(--bg);border-radius:var(--radius);padding:14px;margin-bottom:16px;">
      <p style="font-size:11.5px;color:var(--mid);margin-bottom:8px;">KARGO BİLGİLERİ</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
        <input class="form-control" id="shipCompany" placeholder="Kargo firması" value="${safeAttr(o.shippingCompany || '')}">
        <input class="form-control" id="shipTracking" placeholder="Takip numarası" value="${safeAttr(o.trackingNumber || '')}">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
        <input class="form-control" id="shipUrl" placeholder="Takip linki" value="${safeAttr(o.trackingUrl || '')}">
        <input class="form-control" id="shipDate" type="date" value="${safeAttr(o.shippedAt || '')}">
      </div>
      <div style="display:flex;gap:10px;align-items:center;justify-content:space-between;">
        ${trackingLink}
        <button class="tb-btn" onclick="updateOrderShipping('${safeAttr(o.id)}')">Kargoyu Kaydet</button>
      </div>
    </div>
    <div>
      <p style="font-size:11.5px;color:var(--mid);margin-bottom:8px;">DURUM GÜNCELLE</p>
      <select class="form-control" id="orderStatusSel" style="max-width:260px;">
        <option value="new" ${o.status==='new'?'selected':''}>🔵 Yeni</option>
        <option value="payment_pending" ${o.status==='payment_pending'?'selected':''}>🟡 Ödeme Bekliyor</option>
        <option value="paid" ${o.status==='paid'?'selected':''}>🟢 Ödendi</option>
        <option value="processing" ${o.status==='processing'?'selected':''}>🟡 Hazırlanıyor</option>
        <option value="shipped" ${o.status==='shipped'?'selected':''}>📦 Kargoda</option>
        <option value="delivered" ${o.status==='delivered'?'selected':''}>✅ Teslim Edildi</option>
        <option value="cancelled" ${o.status==='cancelled'?'selected':''}>❌ İptal</option>
      </select>
      <button class="tb-btn primary" style="margin-top:10px;" onclick="updateOrderStatus('${safeAttr(o.id)}')">Güncelle</button>
    </div>`;
  document.getElementById('orderModal').classList.add('open');
}

async function updateOrderStatus(id) {
  const o = DATA.orders.find(x=>x.id===id);
  o.status = document.getElementById('orderStatusSel').value;
  if (ADMIN_API_READY && window.MaveranAPI) {
    try {
      await window.MaveranAPI.orders.updateStatus(o.apiId, o.status);
    } catch (err) {
      toast(err.message || 'API sipariş güncelleme başarısız','error');
      return;
    }
  }
  saveData(); closeModal('orderModal'); renderOrders();
  toast('Sipariş durumu güncellendi ✓','success');
}

async function updateOrderShipping(id) {
  const o = DATA.orders.find(x=>x.id===id);
  const payload = {
    shipping_company: document.getElementById('shipCompany').value.trim(),
    tracking_number: document.getElementById('shipTracking').value.trim(),
    tracking_url: document.getElementById('shipUrl').value.trim(),
    shipped_at: document.getElementById('shipDate').value,
  };

  o.shippingCompany = payload.shipping_company;
  o.trackingNumber = payload.tracking_number;
  o.trackingUrl = payload.tracking_url;
  o.shippedAt = payload.shipped_at;

  if (ADMIN_API_READY && window.MaveranAPI) {
    try {
      const updated = await window.MaveranAPI.orders.updateShipping(o.apiId, payload);
      o.status = updated.status || o.status;
      o.shippingCompany = updated.shipping_company || o.shippingCompany;
      o.trackingNumber = updated.tracking_number || o.trackingNumber;
      o.trackingUrl = updated.tracking_url || o.trackingUrl;
      o.shippedAt = updated.shipped_at ? String(updated.shipped_at).slice(0, 10) : o.shippedAt;
    } catch (err) {
      toast(err.message || 'API kargo güncelleme başarısız','error');
      return;
    }
  } else if (payload.tracking_number && ['new','paid','processing'].includes(o.status)) {
    o.status = 'shipped';
  }

  saveData();
  renderOrders();
  viewOrder(id);
  toast('Kargo bilgileri güncellendi ✓','success');
}

async function changeOrderStatus(id) {
  const steps = ['new','paid','processing','shipped','delivered'];
  const o = DATA.orders.find(x=>x.id===id);
  const i = o.status === 'payment_pending' ? 0 : steps.indexOf(o.status);
  if(i < steps.length-1) {
    o.status=steps[i+1];
    if (ADMIN_API_READY && window.MaveranAPI) {
      try {
        await window.MaveranAPI.orders.updateStatus(o.apiId, o.status);
      } catch (err) {
        toast(err.message || 'API sipariş güncelleme başarısız','error');
        return;
      }
    }
    saveData(); renderOrders(); toast('Durum güncellendi ✓','success');
  }
}

// ═══════════════════════════════════════════════
//  CUSTOMERS
// ═══════════════════════════════════════════════
const DUMMY_CUSTOMERS = [
  {name:'Ayşe Kaya',email:'ayse@mail.com',phone:'0533 xxx xx x1',orders:4,total:5842.30,date:'2024-12-01'},
  {name:'Fatma Yılmaz',email:'fatma@mail.com',phone:'0542 xxx xx x2',orders:2,total:2499.80,date:'2025-01-15'},
  {name:'Zeynep Demir',email:'zeynep@mail.com',phone:'0551 xxx xx x3',orders:7,total:9124.60,date:'2024-11-20'},
  {name:'Halime Öztürk',email:'halime@mail.com',phone:'0505 xxx xx x4',orders:1,total:1449.80,date:'2025-02-28'},
  {name:'Merve Çelik',email:'merve@mail.com',phone:'0532 xxx xx x5',orders:3,total:4299.70,date:'2025-01-05'},
  {name:'Sümeyye Arslan',email:'s@mail.com',phone:'0544 xxx xx x6',orders:1,total:1399.90,date:'2025-03-10'},
];
function renderCustomers() {
  const customers = DATA.customers && DATA.customers.length ? DATA.customers : DUMMY_CUSTOMERS;
  document.getElementById('customersTbody').innerHTML = customers.map(c=>`
    <tr>
      <td><b>${escapeHtml(c.name)}</b></td>
      <td style="color:var(--mid)">${escapeHtml(c.email)}</td>
      <td style="color:var(--mid)">${escapeHtml(c.phone)}</td>
      <td>${c.orders}</td>
      <td><b>₺${c.total.toLocaleString('tr-TR',{minimumFractionDigits:2})}</b></td>
      <td style="color:var(--mid);font-size:12.5px;">${escapeHtml(c.date)}</td>
    </tr>`).join('');
}

// ═══════════════════════════════════════════════
//  SLIDER
// ═══════════════════════════════════════════════
function renderSlider() {
  document.getElementById('sliderItems').innerHTML = DATA.sliderItems.map((s,i)=>`
    <div style="display:grid;grid-template-columns:auto 1fr auto auto;gap:12px;align-items:center;padding:14px;border:1px solid var(--border);border-radius:var(--radius);background:${s.active?'#fff':'#f9fafb'}">
      <span style="font-size:18px;cursor:grab;color:#ccc">⠿</span>
      <div>
        <div style="font-weight:500;font-size:13.5px">${escapeHtml(s.title)}</div>
        <div style="font-size:12px;color:var(--mid)">${escapeHtml(s.tag)} · Buton: "${escapeHtml(s.btn)}"</div>
      </div>
      <label class="toggle" style="flex-shrink:0"><input type="checkbox" ${s.active?'checked':''} onchange="toggleSlideActive(${i}, this.checked)"/><span class="toggle-slider"></span></label>
      <button class="act-btn del" onclick="deleteSlide(${i})">🗑️</button>
    </div>`).join('');
}

async function addSliderItem() {
  const title = prompt('Slayt başlığı:');
  if(!title) return;
  const tag = prompt('Üst etiket metni:') || '';
  const btn = prompt('Buton metni:') || 'Keşfet';
  const slide = {id:Date.now(),tag,title,sub:'',btn,active:true,sortOrder:DATA.sliderItems.length};

  if (ADMIN_API_READY && window.MaveranAPI) {
    try {
      const saved = await window.MaveranAPI.slider.create(slidePayload(slide, DATA.sliderItems.length));
      DATA.sliderItems.push(mapApiSlide(saved));
      saveData(); renderSlider(); toast('Slayt API üzerinden eklendi ✓','success');
      return;
    } catch (err) {
      toast(err.message || 'API slayt kaydı başarısız','error');
      return;
    }
  }

  DATA.sliderItems.push(slide);
  saveData(); renderSlider(); toast('Slayt eklendi ✓','success');
}

async function toggleSlideActive(index, active) {
  const slide = DATA.sliderItems[index];
  if (!slide) return;
  slide.active = active;

  if (ADMIN_API_READY && window.MaveranAPI) {
    try {
      const saved = await window.MaveranAPI.slider.update(slide.id, slidePayload(slide, index));
      DATA.sliderItems[index] = mapApiSlide(saved);
    } catch (err) {
      slide.active = !active;
      toast(err.message || 'API slayt güncelleme başarısız','error');
      renderSlider();
      return;
    }
  }

  saveData(); renderSlider();
  toast(active ? 'Slayt aktif edildi' : 'Slayt pasife alındı','success');
}

async function deleteSlide(index) {
  const slide = DATA.sliderItems[index];
  if (!slide || !confirm('Bu slaytı silmek istediğinize emin misiniz?')) return;

  if (ADMIN_API_READY && window.MaveranAPI) {
    try {
      await window.MaveranAPI.slider.remove(slide.id);
    } catch (err) {
      toast(err.message || 'API slayt silme başarısız','error');
      return;
    }
  }

  DATA.sliderItems.splice(index, 1);
  saveData(); renderSlider(); toast('Slayt silindi','error');
}

// ═══════════════════════════════════════════════
//  CAMPAIGNS
// ═══════════════════════════════════════════════
function renderCampaigns() {
  document.getElementById('campaignsTbody').innerHTML = DATA.campaigns.map((c,i)=>`
    <tr>
      <td><b>${escapeHtml(c.name)}</b></td>
      <td>${escapeHtml(c.type)}</td>
      <td>${c.value||'—'}</td>
      <td style="color:var(--mid)">${escapeHtml(c.end)}</td>
      <td>${c.active ? '<span class="badge badge-green">Aktif</span>' : '<span class="badge badge-gray">Pasif</span>'}</td>
      <td>
        <button class="act-btn" onclick="toggleCampaignActive(${i})" title="${c.active?'Pasife al':'Aktif et'}">${c.active?'⏸':'▶'}</button>
        <button class="act-btn del" onclick="deleteCampaign(${i})">🗑️</button>
      </td>
    </tr>`).join('');
}

async function addCampaign() {
  const name = document.getElementById('campName').value.trim();
  const end  = document.getElementById('campEnd').value;
  if(!name) { toast('Kampanya adı girin','error'); return; }
  const campaign = {
    id:Date.now(), name,
    type: document.getElementById('campType').value,
    value: parseFloat(document.getElementById('campVal').value)||0,
    end: end || '—',
    endDate: end || '',
    active:true
  };

  if (ADMIN_API_READY && window.MaveranAPI) {
    try {
      const saved = await window.MaveranAPI.campaigns.create(campaignPayload(campaign));
      DATA.campaigns.unshift(mapApiCampaign(saved));
      document.getElementById('campName').value='';
      document.getElementById('campVal').value='';
      document.getElementById('campEnd').value='';
      saveData(); renderCampaigns(); toast('Kampanya API üzerinden oluşturuldu ✓','success');
      return;
    } catch (err) {
      toast(err.message || 'API kampanya kaydı başarısız','error');
      return;
    }
  }

  DATA.campaigns.push(campaign);
  document.getElementById('campName').value='';
  document.getElementById('campVal').value='';
  document.getElementById('campEnd').value='';
  saveData(); renderCampaigns(); toast('Kampanya oluşturuldu ✓','success');
}

async function toggleCampaignActive(index) {
  const campaign = DATA.campaigns[index];
  if (!campaign) return;
  campaign.active = !campaign.active;

  if (ADMIN_API_READY && window.MaveranAPI) {
    try {
      const saved = await window.MaveranAPI.campaigns.update(campaign.id, campaignPayload(campaign));
      DATA.campaigns[index] = mapApiCampaign(saved);
    } catch (err) {
      campaign.active = !campaign.active;
      toast(err.message || 'API kampanya güncelleme başarısız','error');
      renderCampaigns();
      return;
    }
  }

  saveData(); renderCampaigns();
  toast(campaign.active ? 'Kampanya aktif edildi' : 'Kampanya pasife alındı','success');
}

async function deleteCampaign(index) {
  const campaign = DATA.campaigns[index];
  if (!campaign || !confirm('Bu kampanyayı silmek istediğinize emin misiniz?')) return;

  if (ADMIN_API_READY && window.MaveranAPI) {
    try {
      await window.MaveranAPI.campaigns.remove(campaign.id);
    } catch (err) {
      toast(err.message || 'API kampanya silme başarısız','error');
      return;
    }
  }

  DATA.campaigns.splice(index, 1);
  saveData(); renderCampaigns(); toast('Kampanya silindi','error');
}

// ═══════════════════════════════════════════════
//  UTILS
// ═══════════════════════════════════════════════
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// Close modal on overlay click
document.querySelectorAll('.modal-overlay').forEach(ov => {
  ov.addEventListener('click', e => { if(e.target===ov) ov.classList.remove('open'); });
});

let toastTimer;
function toast(msg, type='success') {
  const el = document.getElementById('toastEl');
  el.textContent = (type==='success'?'✓ ':'✗ ') + msg;
  el.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>{ el.classList.remove('show'); }, 3000);
}

// Date in topbar
document.getElementById('topbarDate').textContent =
  new Date().toLocaleDateString('tr-TR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});

// ═══════════════════════════════════════════════
//  INIT
// ═══════════════════════════════════════════════
function initApp() {
  renderDashboard();
  syncProductCategoryFilter();
  fillSettingsForm();
  window._topbarFn = topbarActions.dashboard.fn;
}
