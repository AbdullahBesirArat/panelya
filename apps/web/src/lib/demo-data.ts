export const navigationItems = [
  { key: "superadmin", label: "Platform Yönetimi" },
  { key: "security", label: "Güvenlik" },
  { key: "dashboard", label: "Genel Bakış" },
  { key: "products", label: "Ürünler" },
  { key: "orders", label: "Siparişler" },
  { key: "returns", label: "İade ve Değişim" },
  { key: "customers", label: "Müşteriler" },
  { key: "content", label: "Vitrin" },
  { key: "theme", label: "Tema" },
  { key: "integrations", label: "Entegrasyonlar" },
  { key: "coupons", label: "Kuponlar" },
  { key: "analytics", label: "Raporlar" },
  { key: "team", label: "Ekip" },
  { key: "settings", label: "Ayarlar" },
  { key: "shipments", label: "Kargo ve Fulfillment" },
  { key: "invoices", label: "Fatura ve Vergi" },
  { key: "imports", label: "Toplu Aktarım" },
  { key: "carts", label: "Sepetler" },
  { key: "reviews", label: "Değerlendirmeler" },
  { key: "notifications", label: "Bildirimler" },
  { key: "size-guides", label: "Beden Rehberleri" },
  { key: "gift-wrap", label: "Hediye Paketleri" },
  { key: "subscription", label: "Abonelik ve Plan" },
  { key: "domains", label: "Alan Adlari" },
] as const;

export const sectionKeys = navigationItems.map((item) => item.key);

export const sectionMeta: Record<string, {
  kicker: string;
  title: string;
  description: string;
  image: string;
}> = {
  security: {
    kicker: "Hesap Güvenliği",
    title: "Oturumlar ve doğrulama yöntemleri",
    description: "İki adımlı doğrulama, passkey, kurtarma kodları ve aktif cihazlarınızı tek yerden yönetin.",
    image: "https://images.unsplash.com/photo-1563013544-824ae1b704d3?auto=format&fit=crop&w=900&q=80",
  },
  imports: {
    kicker: "Katalog Operasyonu",
    title: "Güvenli toplu aktarım",
    description: "CSV/XLSX önizleme, satır doğrulama, asenkron uygulama ve güvenli dışa aktarma işlerini yönet.",
    image: "https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=900&q=80",
  },
  shipments: {
    kicker: "Fulfillment",
    title: "Kargo ve gönderiler",
    description: "Partial shipment, etiket, takip, teslimat ve iade gönderilerini provider bağımsız yönet.",
    image: "https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?auto=format&fit=crop&w=900&q=80",
  },
  invoices: {
    kicker: "Finans Operasyonu",
    title: "Fatura ve vergi",
    description: "Değişmez sipariş snapshot’ları, vergi dağılımları, manual fatura ve yetkili belge erişimini yönet.",
    image: "https://images.unsplash.com/photo-1554224155-8d04cb21cd6c?auto=format&fit=crop&w=900&q=80",
  },
  superadmin: {
    kicker: "Platform Yonetimi",
    title: "Tum dukkanlarin merkezi",
    description: "Kayitli dukkanlari, sahiplerini, siparis hacmini ve operasyon durumunu tek ekrandan izle.",
    image: "https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=900&q=80",
  },
  dashboard: {
    kicker: "Türkiye E-Ticaret Operasyonu",
    title: "Bugünün operasyon nabzı",
    description: "Sipariş, stok, ödeme ve gelir akışlarını mağaza bazında tek ekrandan takip et.",
    image: "https://images.unsplash.com/photo-1551434678-e076c223a692?auto=format&fit=crop&w=900&q=80",
  },
  products: {
    kicker: "Katalog",
    title: "Ürün ve stok yönetimi",
    description: "Kategoriler, beden-renk varyantları, fiyatlar ve stok seviyeleri aynı akışta ilerler.",
    image: "https://images.unsplash.com/photo-1523381294911-8d3cead13475?auto=format&fit=crop&w=900&q=80",
  },
  orders: {
    kicker: "Sipariş",
    title: "Sipariş akışları",
    description: "Ödeme, hazırlık, kargo ve teslimat durumlarını mağaza bazında takip et.",
    image: "https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?auto=format&fit=crop&w=900&q=80",
  },
  customers: {
    kicker: "Müşteri İlişkileri",
    title: "Müşteri görünümü",
    description: "Sipariş geçmişi, iletişim bilgileri ve toplam harcamayı tek akışta izle.",
    image: "https://images.unsplash.com/photo-1554224155-6726b3ff858f?auto=format&fit=crop&w=900&q=80",
  },
  content: {
    kicker: "Vitrin",
    title: "Vitrin ve kampanya yönetimi",
    description: "Her mağaza kendi ana sayfa slaytlarını ve promosyon akışlarını yönetir.",
    image: "https://images.unsplash.com/photo-1523381210434-271e8be1f52b?auto=format&fit=crop&w=900&q=80",
  },
  returns: {
    kicker: "Satış Sonrası",
    title: "İade, değişim ve refund",
    description: "Müşteri taleplerini, fiziksel kabulü, stok geri girişini ve para iadelerini izlenebilir biçimde yönet.",
    image: "https://images.unsplash.com/photo-1586880244406-556ebe35f282?auto=format&fit=crop&w=900&q=80",
  },
  coupons: {
    kicker: "Promosyon",
    title: "Kupon ve indirim kurallari",
    description: "Kupon kapsamlarini, limitlerini, kampanya birlestirme kurallarini ve kullanimlarini yonet.",
    image: "https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?auto=format&fit=crop&w=900&q=80",
  },
  analytics: {
    kicker: "Raporlama",
    title: "Gelir ve performans",
    description: "Sipariş, ciro ve tekrar satın alma metriklerini canlı veriden oku.",
    image: "https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=900&q=80",
  },
  team: {
    kicker: "Ekip",
    title: "Yetkiler ve davetler",
    description: "Mağaza ekip üyelerini, rolleri ve bekleyen davetleri tek ekrandan yönet.",
    image: "https://images.unsplash.com/photo-1522071820081-009f0129c71c?auto=format&fit=crop&w=900&q=80",
  },
  settings: {
    kicker: "Yönetim",
    title: "Mağaza ayarları",
    description: "Plan, abonelik, ekip ve vitrin bağlantı bilgilerini tek merkezden güncel tut.",
    image: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=900&q=80",
  },
  reviews: {
    kicker: "Sosyal Kanıt",
    title: "Değerlendirme ve Q&A moderasyonu",
    description: "Doğrulanmış alışveriş yorumlarını, puanları ve ürün sorularını moderasyondan geçirip yayınla.",
    image: "https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?auto=format&fit=crop&w=900&q=80",
  },
  notifications: {
    kicker: "İletişim",
    title: "Bildirim ve izin yönetimi",
    description: "Stok/fiyat/favori bildirimlerinin kuyruğunu, teslimatını, izinleri ve engellenen alıcıları izle ve yönet.",
    image: "https://images.unsplash.com/photo-1526379095098-d400fd0bf935?auto=format&fit=crop&w=900&q=80",
  },
  "size-guides": {
    kicker: "Katalog",
    title: "Beden rehberleri",
    description: "Kategoriye varsayılan veya ürüne özel beden ölçü tablolarını oluştur, düzenle ve yayınla.",
    image: "https://images.unsplash.com/photo-1489987707025-afc232f7ea0f?auto=format&fit=crop&w=900&q=80",
  },
  theme: {
    kicker: "Magaza Gorunumu",
    title: "Tema ve sürümler",
    description: "Mağazanın görünümünü taslakta düzenleyin, önizleyin, yayınlayın ve gerektiğinde eski sürüme dönün.",
    image: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=900&q=80",
  },
  integrations: {
    kicker: "Entegrasyon",
    title: "API anahtarlari ve webhooklar",
    description: "Dis sistemleri Panelya API'sine baglayin, olaylari imzali webhooklarla gonderin ve teslimatlari izleyin.",
    image: "https://images.unsplash.com/photo-1518770660439-4636190af475?auto=format&fit=crop&w=900&q=80",
  },
  domains: {
    kicker: "Altyapi",
    title: "Alan adlari",
    description: "Kendi alan adinizi ekleyin, DNS ile sahipligini dogrulayin ve magazanizi kendi adresinizde yayinlayin.",
    image: "https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=900&q=80",
  },
  subscription: {
    kicker: "Faturalandirma",
    title: "Abonelik ve plan",
    description: "Planinizi, kullanim limitlerinizi, faturalarinizi ve abonelik durumunuzu tek yerden yonetin.",
    image: "https://images.unsplash.com/photo-1554224155-6726b3ff858f?auto=format&fit=crop&w=900&q=80",
  },
  "gift-wrap": {
    kicker: "Checkout",
    title: "Hediye paketleri",
    description: "Checkout'ta sunulan hediye paketi seçeneklerini ve sunucu tarafındaki ücretlerini yönet.",
    image: "https://images.unsplash.com/photo-1513885535751-8b9238bd345a?auto=format&fit=crop&w=900&q=80",
  },
};
