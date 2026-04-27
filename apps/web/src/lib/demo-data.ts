export const navigationItems = [
  { key: "dashboard", label: "Genel Bakış" },
  { key: "products", label: "Ürünler" },
  { key: "orders", label: "Siparişler" },
  { key: "customers", label: "Müşteriler" },
  { key: "content", label: "Vitrin" },
  { key: "analytics", label: "Raporlar" },
  { key: "settings", label: "Ayarlar" },
] as const;

export const sectionKeys = navigationItems.map((item) => item.key);

export const sectionMeta: Record<string, {
  kicker: string;
  title: string;
  description: string;
  image: string;
}> = {
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
  analytics: {
    kicker: "Raporlama",
    title: "Gelir ve performans",
    description: "Sipariş, ciro ve tekrar satın alma metriklerini canlı veriden oku.",
    image: "https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=900&q=80",
  },
  settings: {
    kicker: "Yönetim",
    title: "Mağaza ayarları",
    description: "Plan, abonelik, ekip ve vitrin bağlantı bilgilerini tek merkezden güncel tut.",
    image: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=900&q=80",
  },
};
