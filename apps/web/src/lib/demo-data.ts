export const navigationItems = [
  { key: "dashboard", label: "Dashboard" },
  { key: "products", label: "Products" },
  { key: "orders", label: "Orders" },
  { key: "customers", label: "Customers" },
  { key: "analytics", label: "Analytics" },
  { key: "settings", label: "Settings" },
] as const;

export const sectionKeys = navigationItems.map((item) => item.key);

export const sectionMeta: Record<string, {
  kicker: string;
  title: string;
  description: string;
  image: string;
}> = {
  dashboard: {
    kicker: "Operations",
    title: "Bugunun operasyon nabzi",
    description: "Siparis, stok ve gelir akislarini tenant bazinda takip et.",
    image: "https://images.unsplash.com/photo-1551434678-e076c223a692?auto=format&fit=crop&w=900&q=80",
  },
  products: {
    kicker: "Catalog",
    title: "Urun ve stok yonetimi",
    description: "Kategoriler, stok seviyeleri ve katalog kayitlari ayni akista ilerler.",
    image: "https://images.unsplash.com/photo-1523381294911-8d3cead13475?auto=format&fit=crop&w=900&q=80",
  },
  orders: {
    kicker: "Orders",
    title: "Siparis akislari",
    description: "Odeme, isleme ve kargo durumlarini tenant bazinda takip et.",
    image: "https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?auto=format&fit=crop&w=900&q=80",
  },
  customers: {
    kicker: "CRM",
    title: "Musteri gorunumu",
    description: "Siparis gecmisi ve toplam harcamayi tek akista izle.",
    image: "https://images.unsplash.com/photo-1556745757-8d76bdb6984b?auto=format&fit=crop&w=900&q=80",
  },
  analytics: {
    kicker: "Analytics",
    title: "Gelir ve performans",
    description: "Siparis, gelir ve tekrar satin alma metriklerini canli veriden oku.",
    image: "https://images.unsplash.com/photo-1551288049-bebda4e38f71?auto=format&fit=crop&w=900&q=80",
  },
  settings: {
    kicker: "Settings",
    title: "Workspace ayarlari",
    description: "Plan, abonelik ve ekip durumunu tek merkezden guncel tut.",
    image: "https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=900&q=80",
  },
};
