"use client";

import type { FormEvent } from "react";
import Image from "next/image";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MetricGrid } from "@/components/page-kit";
import { Button } from "@/components/ui/button";
import {
  API_BASE,
  createBlogPost,
  createCampaign,
  createCollection,
  createSlide,
  deleteBlogPost,
  deleteCampaign,
  deleteCollection,
  deleteSlide,
  fetchBlogPosts,
  fetchCampaigns,
  fetchCollections,
  fetchCollectionProducts,
  fetchSlides,
  updateBlogPost,
  updateCampaign,
  updateCollection,
  updateCollectionProducts,
  updateSlide,
  type ApiBlogPost,
  type ApiCampaign,
  type ApiCollection,
  type ApiSlide,
  type CollectionProductMembership,
  uploadProductImages,
} from "@/lib/api";
import {
  ActivityPanel,
  DataCell,
  DataGrid,
  FieldLabel,
  InlineError,
  InlineHint,
  Panel,
  SectionError,
  SectionLoading,
  StatusPill,
  formatCount,
  formatDateTime,
} from "@/components/operations-shared";
import { useToastStore } from "@/store/toast";

const emptySlideForm = {
  tag: "",
  title: "",
  sub: "",
  btn: "Keşfet",
  imageUrl: "",
  sortOrder: "0",
  active: true,
};

const emptyCampaignForm = {
  name: "",
  type: "yüzde",
  value: "10",
  endDate: "",
  active: true,
};

const emptyCollectionForm = {
  title: "",
  slug: "",
  description: "",
  imageUrl: "",
  linkUrl: "",
  sortOrder: "0",
  active: true,
};

const emptyBlogForm = {
  title: "",
  slug: "",
  excerpt: "",
  content: "",
  imageUrl: "",
  sortOrder: "0",
  publishedAt: "",
  active: true,
};

type ContentTab = "slides" | "campaigns" | "collections" | "blog";

const contentTabs: Array<{ key: ContentTab; label: string; description: string }> = [
  { key: "slides", label: "Slaytlar", description: "Ana sayfa vitrini" },
  { key: "campaigns", label: "Kampanyalar", description: "Üst bant ve indirimler" },
  { key: "collections", label: "Koleksiyonlar", description: "Ürün grupları" },
  { key: "blog", label: "Blog", description: "SEO içerikleri" },
];

function assetUrl(url: string | null | undefined) {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  const assetBase = API_BASE.replace(/\/api\/?$/, "").replace(/\/$/, "");
  if (value.startsWith("/uploads/")) return `${assetBase}${value}`;
  if (value.startsWith("uploads/")) return `${assetBase}/${value}`;
  if (value.startsWith("/")) return `${assetBase}${value}`;
  return `${assetBase}/uploads/${value}`;
}

function collectionKey(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function collectionLink(form: typeof emptyCollectionForm) {
  const slug = collectionKey(form.slug || form.title);
  return slug ? `urunler?collection=${slug}` : "urunler";
}

export function ContentSection({
  organizationSlug,
  currentRole,
}: {
  organizationSlug: string;
  currentRole: string;
}) {
  const queryClient = useQueryClient();
  const pushToast = useToastStore((state) => state.pushToast);
  const [editingSlideId, setEditingSlideId] = useState<string | null>(null);
  const [editingCampaignId, setEditingCampaignId] = useState<string | null>(null);
  const [editingCollectionId, setEditingCollectionId] = useState<string | null>(null);
  const [editingBlogId, setEditingBlogId] = useState<string | null>(null);
  const [slideForm, setSlideForm] = useState(emptySlideForm);
  const [campaignForm, setCampaignForm] = useState(emptyCampaignForm);
  const [collectionForm, setCollectionForm] = useState(emptyCollectionForm);
  const [blogForm, setBlogForm] = useState(emptyBlogForm);
  const [activeContentTab, setActiveContentTab] = useState<ContentTab>("slides");
  const [collectionProductsModal, setCollectionProductsModal] = useState<{
    id: string;
    title: string;
    slug: string;
  } | null>(null);
  const [collectionProductOverrides, setCollectionProductOverrides] = useState<Map<number, boolean>>(new Map());
  const [collectionProductFilter, setCollectionProductFilter] = useState("");

  const slidesQuery = useQuery({
    queryKey: ["slides", organizationSlug],
    queryFn: fetchSlides,
    staleTime: 30_000,
  });

  const campaignsQuery = useQuery({
    queryKey: ["campaigns", organizationSlug],
    queryFn: fetchCampaigns,
    staleTime: 30_000,
  });

  const collectionsQuery = useQuery({
    queryKey: ["collections", organizationSlug],
    queryFn: fetchCollections,
    staleTime: 30_000,
  });

  const blogQuery = useQuery({
    queryKey: ["blog-posts", organizationSlug],
    queryFn: fetchBlogPosts,
    staleTime: 30_000,
  });

  const canManageContent = currentRole === "owner" || currentRole === "admin";
  const canDeleteContent = currentRole === "owner";

  const slideMutation = useMutation({
    mutationFn: createSlide,
    onSuccess: async () => {
      resetSlideForm();
      pushToast({
        title: "Slayt oluşturuldu",
        description: "Vitrin içeriği yayına hazır.",
        tone: "success",
      });
      await invalidateContent();
    },
  });

  const updateSlideMutation = useMutation({
    mutationFn: ({ id, payload }: {
      id: string;
      payload: Parameters<typeof updateSlide>[1];
    }) => updateSlide(id, payload),
    onSuccess: async () => {
      resetSlideForm();
      pushToast({
        title: "Slayt güncellendi",
        description: "Vitrin sırasına işlendi.",
        tone: "success",
      });
      await invalidateContent();
    },
  });

  const deleteSlideMutation = useMutation({
    mutationFn: deleteSlide,
    onSuccess: async () => {
      pushToast({
        title: "Slayt silindi",
        description: "Vitrinden kaldırıldı.",
        tone: "info",
      });
      await invalidateContent();
    },
  });

  const campaignMutation = useMutation({
    mutationFn: createCampaign,
    onSuccess: async () => {
      resetCampaignForm();
      pushToast({
        title: "Kampanya oluşturuldu",
        description: "Aktif kampanya listesi güncellendi.",
        tone: "success",
      });
      await invalidateContent();
    },
  });

  const updateCampaignMutation = useMutation({
    mutationFn: ({ id, payload }: {
      id: string;
      payload: Parameters<typeof updateCampaign>[1];
    }) => updateCampaign(id, payload),
    onSuccess: async () => {
      resetCampaignForm();
      pushToast({
        title: "Kampanya güncellendi",
        description: "Promosyon bilgisi yenilendi.",
        tone: "success",
      });
      await invalidateContent();
    },
  });

  const deleteCampaignMutation = useMutation({
    mutationFn: deleteCampaign,
    onSuccess: async () => {
      pushToast({
        title: "Kampanya silindi",
        description: "Promosyon listesi güncellendi.",
        tone: "info",
      });
      await invalidateContent();
    },
  });

  const collectionMutation = useMutation({
    mutationFn: createCollection,
    onSuccess: async () => {
      resetCollectionForm();
      pushToast({
        title: "Koleksiyon oluşturuldu",
        description: "Koleksiyon vitrinde kullanıma hazır.",
        tone: "success",
      });
      await invalidateContent();
    },
  });

  const updateCollectionMutation = useMutation({
    mutationFn: ({ id, payload }: {
      id: string;
      payload: Parameters<typeof updateCollection>[1];
    }) => updateCollection(id, payload),
    onSuccess: async () => {
      resetCollectionForm();
      pushToast({
        title: "Koleksiyon güncellendi",
        description: "Koleksiyon bilgileri yenilendi.",
        tone: "success",
      });
      await invalidateContent();
    },
  });

  const deleteCollectionMutation = useMutation({
    mutationFn: deleteCollection,
    onSuccess: async () => {
      pushToast({
        title: "Koleksiyon silindi",
        description: "Koleksiyon listesinden kaldırıldı.",
        tone: "info",
      });
      await invalidateContent();
    },
  });

  const collectionProductsQuery = useQuery({
    queryKey: ["collection-products", organizationSlug, collectionProductsModal?.id ?? null],
    queryFn: () => fetchCollectionProducts(collectionProductsModal!.id),
    enabled: !!collectionProductsModal,
    staleTime: 0,
  });

  const collectionProductsMutation = useMutation({
    mutationFn: ({ id, memberIds }: { id: string; memberIds: number[] }) =>
      updateCollectionProducts(id, memberIds),
    onSuccess: async (data) => {
      pushToast({
        title: "Koleksiyon ürünleri güncellendi",
        description: `${data.memberCount} ürün koleksiyonda, ${data.updated} ürün güncellendi.`,
        tone: "success",
      });
      await queryClient.invalidateQueries({ queryKey: ["products", organizationSlug] });
      setCollectionProductsModal(null);
    },
  });

  function openCollectionProductsModal(collection: ApiCollection) {
    setCollectionProductsModal({ id: String(collection.id), title: collection.title, slug: collection.slug });
    setCollectionProductOverrides(new Map());
    setCollectionProductFilter("");
  }

  const collectionProductSelectedIds = useMemo(() => {
    const list = collectionProductsQuery.data?.products ?? [];
    return list
      .filter((product) => {
        const override = collectionProductOverrides.get(Number(product.id));
        return override === undefined ? product.is_member : override;
      })
      .map((product) => Number(product.id));
  }, [collectionProductsQuery.data, collectionProductOverrides]);

  const blogMutation = useMutation({
    mutationFn: createBlogPost,
    onSuccess: async () => {
      resetBlogForm();
      pushToast({
        title: "Blog yazısı oluşturuldu",
        description: "Suvera blog akışı güncellendi.",
        tone: "success",
      });
      await invalidateContent();
    },
  });

  const updateBlogMutation = useMutation({
    mutationFn: ({ id, payload }: {
      id: string;
      payload: Parameters<typeof updateBlogPost>[1];
    }) => updateBlogPost(id, payload),
    onSuccess: async () => {
      resetBlogForm();
      pushToast({
        title: "Blog yazısı güncellendi",
        description: "Blog içeriği yenilendi.",
        tone: "success",
      });
      await invalidateContent();
    },
  });

  const deleteBlogMutation = useMutation({
    mutationFn: deleteBlogPost,
    onSuccess: async () => {
      pushToast({
        title: "Blog yazısı silindi",
        description: "Blog listesinden kaldırıldı.",
        tone: "info",
      });
      await invalidateContent();
    },
  });

  const uploadCollectionImageMutation = useMutation({
    mutationFn: uploadProductImages,
    onSuccess: (response) => {
      const uploaded = response.files[0]?.url || "";
      if (!uploaded) return;
      setCollectionForm((current) => ({ ...current, imageUrl: uploaded }));
      pushToast({
        title: "Koleksiyon görseli yüklendi",
        description: "Görsel koleksiyon formuna eklendi.",
        tone: "success",
      });
    },
  });

  const uploadBlogImageMutation = useMutation({
    mutationFn: uploadProductImages,
    onSuccess: (response) => {
      const uploaded = response.files[0]?.url || "";
      if (!uploaded) return;
      setBlogForm((current) => ({ ...current, imageUrl: uploaded }));
      pushToast({
        title: "Blog kapak görseli yüklendi",
        description: "Görsel blog yazısı formuna eklendi.",
        tone: "success",
      });
    },
  });

  if (slidesQuery.isLoading || campaignsQuery.isLoading || collectionsQuery.isLoading || blogQuery.isLoading) return <SectionLoading />;
  if (slidesQuery.isError || campaignsQuery.isError || collectionsQuery.isError || blogQuery.isError || !slidesQuery.data || !campaignsQuery.data || !collectionsQuery.data || !blogQuery.data) {
    return (
      <SectionError
        message="İçerik verisi yüklenemedi."
        onRetry={() => {
          void slidesQuery.refetch();
          void campaignsQuery.refetch();
          void collectionsQuery.refetch();
          void blogQuery.refetch();
        }}
      />
    );
  }

  const slides = slidesQuery.data;
  const campaigns = campaignsQuery.data;
  const collections = collectionsQuery.data;
  const blogPosts = blogQuery.data;
  const activeSlides = slides.filter((slide) => slide.active).length;
  const activeCampaigns = campaigns.filter((campaign) => campaign.active).length;
  const activeCollections = collections.filter((collection) => collection.active).length;
  const activeBlogPosts = blogPosts.filter((post) => post.active).length;
  const scheduledCampaigns = campaigns.filter((campaign) => campaign.active && campaign.end_date).length;

  async function invalidateContent() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["slides", organizationSlug] }),
      queryClient.invalidateQueries({ queryKey: ["campaigns", organizationSlug] }),
      queryClient.invalidateQueries({ queryKey: ["collections", organizationSlug] }),
      queryClient.invalidateQueries({ queryKey: ["blog-posts", organizationSlug] }),
      queryClient.invalidateQueries({ queryKey: ["summary", organizationSlug] }),
    ]);
  }

  function resetSlideForm() {
    setEditingSlideId(null);
    setSlideForm(emptySlideForm);
  }

  function resetCampaignForm() {
    setEditingCampaignId(null);
    setCampaignForm(emptyCampaignForm);
  }

  function resetCollectionForm() {
    setEditingCollectionId(null);
    setCollectionForm(emptyCollectionForm);
  }

  function resetBlogForm() {
    setEditingBlogId(null);
    setBlogForm(emptyBlogForm);
  }

  function startEditingSlide(slide: ApiSlide) {
    setEditingSlideId(slide.id);
    setSlideForm({
      tag: slide.tag || "",
      title: slide.title,
      sub: slide.sub || "",
      btn: slide.btn || "Keşfet",
      imageUrl: slide.image_url || "",
      sortOrder: String(slide.sort_order || 0),
      active: slide.active,
    });
  }

  function startEditingCampaign(campaign: ApiCampaign) {
    setEditingCampaignId(campaign.id);
    setCampaignForm({
      name: campaign.name,
      type: campaign.type,
      value: String(campaign.value || 0),
      endDate: campaign.end_date ? campaign.end_date.slice(0, 10) : "",
      active: campaign.active,
    });
  }

  function startEditingCollection(collection: ApiCollection) {
    setEditingCollectionId(collection.id);
    setCollectionForm({
      title: collection.title,
      slug: collection.slug,
      description: collection.description || "",
      imageUrl: collection.image_url || "",
      linkUrl: collection.link_url || "",
      sortOrder: String(collection.sort_order || 0),
      active: collection.active,
    });
  }

  function startEditingBlog(post: ApiBlogPost) {
    setEditingBlogId(post.id);
    setBlogForm({
      title: post.title,
      slug: post.slug,
      excerpt: post.excerpt || "",
      content: post.content || "",
      imageUrl: post.image_url || "",
      sortOrder: String(post.sort_order || 0),
      publishedAt: post.published_at ? post.published_at.slice(0, 10) : "",
      active: post.active,
    });
  }

  function submitSlide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const sortOrder = Number(slideForm.sortOrder || 0);
    if (!slideForm.title.trim() || !Number.isFinite(sortOrder) || sortOrder < 0) return;

    const payload = {
      tag: slideForm.tag.trim(),
      title: slideForm.title.trim(),
      sub: slideForm.sub.trim(),
      btn: slideForm.btn.trim() || "Keşfet",
      imageUrl: slideForm.imageUrl.trim(),
      sortOrder,
      active: slideForm.active,
    };

    if (editingSlideId) {
      updateSlideMutation.mutate({ id: editingSlideId, payload });
      return;
    }

    slideMutation.mutate(payload);
  }

  function submitCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = Number(campaignForm.value || 0);
    if (!campaignForm.name.trim() || !campaignForm.type.trim() || !Number.isFinite(value) || value < 0) return;

    const payload = {
      name: campaignForm.name.trim(),
      type: campaignForm.type.trim(),
      value,
      endDate: campaignForm.endDate || null,
      active: campaignForm.active,
    };

    if (editingCampaignId) {
      updateCampaignMutation.mutate({ id: editingCampaignId, payload });
      return;
    }

    campaignMutation.mutate(payload);
  }

  function submitCollection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const sortOrder = Number(collectionForm.sortOrder || 0);
    if (!collectionForm.title.trim() || !Number.isFinite(sortOrder) || sortOrder < 0) return;
    const slug = collectionForm.slug.trim() || collectionKey(collectionForm.title);

    const payload = {
      title: collectionForm.title.trim(),
      slug,
      description: collectionForm.description.trim(),
      imageUrl: collectionForm.imageUrl.trim(),
      linkUrl: collectionForm.linkUrl.trim() || collectionLink({ ...collectionForm, slug }),
      sortOrder,
      active: collectionForm.active,
    };

    if (editingCollectionId) {
      updateCollectionMutation.mutate({ id: editingCollectionId, payload });
      return;
    }

    collectionMutation.mutate(payload);
  }

  function submitBlog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const sortOrder = Number(blogForm.sortOrder || 0);
    if (!blogForm.title.trim() || !Number.isFinite(sortOrder) || sortOrder < 0) return;

    const payload = {
      title: blogForm.title.trim(),
      slug: blogForm.slug.trim(),
      excerpt: blogForm.excerpt.trim(),
      content: blogForm.content.trim(),
      imageUrl: blogForm.imageUrl.trim(),
      sortOrder,
      publishedAt: blogForm.publishedAt || null,
      active: blogForm.active,
    };

    if (editingBlogId) {
      updateBlogMutation.mutate({ id: editingBlogId, payload });
      return;
    }

    blogMutation.mutate(payload);
  }

  return (
    <>
      <MetricGrid
        metrics={[
          { label: "Aktif slayt", value: formatCount(activeSlides), tone: "mint" },
          { label: "Tüm slayt", value: formatCount(slides.length), tone: "leaf" },
          { label: "Aktif kampanya", value: formatCount(activeCampaigns), tone: "sun" },
          { label: "Blog", value: formatCount(activeBlogPosts), tone: "coral" },
        ]}
      />

      <div className="rounded-2xl border border-line bg-white p-2 shadow-sm">
        <div className="grid gap-2 md:grid-cols-4">
          {contentTabs.map((tab) => {
            const active = activeContentTab === tab.key;
            return (
              <button
                className={[
                  "focus-ring rounded-xl px-4 py-3 text-left transition",
                  active ? "bg-ink text-white shadow-sm" : "bg-zinc-50 text-zinc-600 hover:bg-zinc-100",
                ].join(" ")}
                key={tab.key}
                onClick={() => setActiveContentTab(tab.key)}
                type="button"
              >
                <span className="block text-sm font-semibold">{tab.label}</span>
                <span className={["mt-1 block text-xs", active ? "text-white/70" : "text-zinc-500"].join(" ")}>
                  {tab.description}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {activeContentTab === "slides" ? (
      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <Panel
          title="Vitrin slaytları"
          description="Mağaza ana sayfası için sıralı içerik"
          actions={slidesQuery.isFetching ? <StatusPill tone="leaf">Güncelleniyor</StatusPill> : null}
        >
          <DataGrid
            columns={["Sıra", "Başlık", "Etiket", "Buton", "Durum", "Aksiyon"]}
            emptyMessage="Bu mağaza için henüz slayt yok."
            rows={slides}
            renderRow={(slide) => (
              <tr key={slide.id}>
                <DataCell>{formatCount(slide.sort_order)}</DataCell>
                <DataCell>
                  <p className="font-semibold text-ink">{slide.title}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{slide.sub || "Alt metin yok"}</p>
                </DataCell>
                <DataCell>{slide.tag || "-"}</DataCell>
                <DataCell>{slide.btn || "-"}</DataCell>
                <DataCell>
                  <StatusPill tone={slide.active ? "mint" : "sun"}>
                    {slide.active ? "Aktif" : "Pasif"}
                  </StatusPill>
                </DataCell>
                <DataCell>
                  <div className="flex flex-wrap gap-2">
                    {canManageContent ? (
                      <Button onClick={() => startEditingSlide(slide)} size="sm" type="button" variant="outline">
                        Düzenle
                      </Button>
                    ) : null}
                    {canDeleteContent ? (
                      <Button
                        disabled={deleteSlideMutation.isPending && deleteSlideMutation.variables === slide.id}
                        onClick={() => deleteSlideMutation.mutate(slide.id)}
                        size="sm"
                        type="button"
                        variant="danger"
                      >
                        {deleteSlideMutation.isPending && deleteSlideMutation.variables === slide.id ? "Siliniyor" : "Sil"}
                      </Button>
                    ) : null}
                    {!canManageContent && !canDeleteContent ? <span className="text-xs text-zinc-400">Salt okunur</span> : null}
                  </div>
                </DataCell>
              </tr>
            )}
          />
        </Panel>

        <Panel
          title={editingSlideId ? "Slaytı güncelle" : "Yeni slayt"}
          description="Vitrin başlığı, buton ve görsel bağlantısı"
        >
          <form className="grid gap-3" onSubmit={submitSlide}>
            <FieldLabel htmlFor="slide-title">Başlık (ana sayfa vitrininde büyük yazı olarak görünür)</FieldLabel>
            <input
              className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
              id="slide-title"
              onChange={(event) => setSlideForm((current) => ({ ...current, title: event.target.value }))}
              placeholder="Yeni sezon vitrini"
              value={slideForm.title}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-zinc-700">Etiket (başlığın üstündeki küçük vurgu metni)</span>
                <input
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  onChange={(event) => setSlideForm((current) => ({ ...current, tag: event.target.value }))}
                  placeholder="Koleksiyon"
                  value={slideForm.tag}
                />
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-zinc-700">Buton (vitrindeki aksiyon düğmesinin yazısı)</span>
                <input
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  onChange={(event) => setSlideForm((current) => ({ ...current, btn: event.target.value }))}
              placeholder="Keşfet"
                  value={slideForm.btn}
                />
              </label>
            </div>
            <label className="grid gap-2">
              <span className="text-sm font-semibold text-zinc-700">Alt metin (başlığın altında görünen kısa açıklama)</span>
              <textarea
                className="focus-ring min-h-24 rounded-lg border border-line bg-white px-3 py-2 text-sm"
                onChange={(event) => setSlideForm((current) => ({ ...current, sub: event.target.value }))}
                placeholder="Vitrin mesajini yaz"
                value={slideForm.sub}
              />
            </label>
            <label className="grid gap-2">
              <span className="text-sm font-semibold text-zinc-700">Görsel URL (vitrin arka plan fotoğrafı)</span>
              <input
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                onChange={(event) => setSlideForm((current) => ({ ...current, imageUrl: event.target.value }))}
                placeholder="https://..."
                value={slideForm.imageUrl}
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-zinc-700">Sıra (slaytların gösterim sırası)</span>
                <input
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  inputMode="numeric"
                  onChange={(event) => setSlideForm((current) => ({ ...current, sortOrder: event.target.value }))}
                  value={slideForm.sortOrder}
                />
              </label>
              <label className="flex h-10 items-center gap-2 text-sm font-semibold text-zinc-700">
                <input
                  checked={slideForm.active}
                  className="h-4 w-4 rounded border-line"
                  onChange={(event) => setSlideForm((current) => ({ ...current, active: event.target.checked }))}
                  type="checkbox"
                />
                Aktif (kapalıysa sitede görünmez)
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!canManageContent || slideMutation.isPending || updateSlideMutation.isPending}
                type="submit"
                variant="mint"
              >
                {updateSlideMutation.isPending
                  ? "Güncelleniyor"
                  : slideMutation.isPending
                    ? "Oluşturuluyor"
                    : editingSlideId
                      ? "Slaytı güncelle"
                      : "Slayt oluştur"}
              </Button>
              {editingSlideId ? (
                <Button onClick={resetSlideForm} type="button" variant="outline">
                  Vazgec
                </Button>
              ) : null}
            </div>
            {!canManageContent ? <InlineHint>Bu alanda yazma yetkisi için sahip veya yönetici rolüne ihtiyaç var.</InlineHint> : null}
            {slideMutation.isError && <InlineError message={slideMutation.error.message} />}
            {updateSlideMutation.isError && <InlineError message={updateSlideMutation.error.message} />}
          </form>
        </Panel>
      </div>
      ) : null}

      {activeContentTab === "campaigns" ? (
      <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
        <Panel
          title="Kampanyalar"
          description="Aktif promosyon ve bitiş tarihleri"
          actions={campaignsQuery.isFetching ? <StatusPill tone="leaf">Güncelleniyor</StatusPill> : null}
        >
          <DataGrid
            columns={["Ad", "Tip", "Değer", "Bitiş", "Durum", "Aksiyon"]}
            emptyMessage="Bu mağaza için henüz kampanya yok."
            rows={campaigns}
            renderRow={(campaign) => (
              <tr key={campaign.id}>
                <DataCell>{campaign.name}</DataCell>
                <DataCell>{campaign.type}</DataCell>
                <DataCell>{formatCampaignValue(campaign)}</DataCell>
                <DataCell>{campaign.end_date ? formatDateTime(campaign.end_date) : "Süresiz"}</DataCell>
                <DataCell>
                  <StatusPill tone={campaign.active ? "mint" : "sun"}>
                    {campaign.active ? "Aktif" : "Pasif"}
                  </StatusPill>
                </DataCell>
                <DataCell>
                  <div className="flex flex-wrap gap-2">
                    {canManageContent ? (
                      <Button onClick={() => startEditingCampaign(campaign)} size="sm" type="button" variant="outline">
                        Düzenle
                      </Button>
                    ) : null}
                    {canDeleteContent ? (
                      <Button
                        disabled={deleteCampaignMutation.isPending && deleteCampaignMutation.variables === campaign.id}
                        onClick={() => deleteCampaignMutation.mutate(campaign.id)}
                        size="sm"
                        type="button"
                        variant="danger"
                      >
                        {deleteCampaignMutation.isPending && deleteCampaignMutation.variables === campaign.id ? "Siliniyor" : "Sil"}
                      </Button>
                    ) : null}
                    {!canManageContent && !canDeleteContent ? <span className="text-xs text-zinc-400">Salt okunur</span> : null}
                  </div>
                </DataCell>
              </tr>
            )}
          />
        </Panel>

        <div className="space-y-5">
          <Panel
            title={editingCampaignId ? "Kampanyayı güncelle" : "Yeni kampanya"}
            description="Vitrin ve mağaza promosyon akışı"
          >
            <form className="grid gap-3" onSubmit={submitCampaign}>
              <FieldLabel htmlFor="campaign-name">Kampanya adı (duyuru ve kampanya listesinde görünen isim)</FieldLabel>
              <input
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                id="campaign-name"
                onChange={(event) => setCampaignForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Bahar indirimi"
                value={campaignForm.name}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-zinc-700">Tip (yüzde, tutar veya kampanya türü)</span>
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    onChange={(event) => setCampaignForm((current) => ({ ...current, type: event.target.value }))}
                    placeholder="yüzde"
                    value={campaignForm.type}
                  />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-zinc-700">Değer (indirim oranı/tutarı gibi sayısal etki)</span>
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    inputMode="decimal"
                    onChange={(event) => setCampaignForm((current) => ({ ...current, value: event.target.value }))}
                    value={campaignForm.value}
                  />
                </label>
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-zinc-700">Bitiş tarihi (kampanyanın sitede sona ereceği gün)</span>
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    onChange={(event) => setCampaignForm((current) => ({ ...current, endDate: event.target.value }))}
                    type="date"
                    value={campaignForm.endDate}
                  />
                </label>
                <label className="flex h-10 items-center gap-2 text-sm font-semibold text-zinc-700">
                  <input
                    checked={campaignForm.active}
                    className="h-4 w-4 rounded border-line"
                    onChange={(event) => setCampaignForm((current) => ({ ...current, active: event.target.checked }))}
                    type="checkbox"
                  />
                  Aktif (kapalıysa kampanya sitede yayınlanmaz)
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!canManageContent || campaignMutation.isPending || updateCampaignMutation.isPending}
                  type="submit"
                  variant="mint"
                >
                  {updateCampaignMutation.isPending
                    ? "Güncelleniyor"
                    : campaignMutation.isPending
                      ? "Oluşturuluyor"
                      : editingCampaignId
                        ? "Kampanyayı güncelle"
                        : "Kampanya oluştur"}
                </Button>
                {editingCampaignId ? (
                  <Button onClick={resetCampaignForm} type="button" variant="outline">
                    Vazgec
                  </Button>
                ) : null}
              </div>
              {!canManageContent ? <InlineHint>Bu alanda yazma yetkisi için sahip veya yönetici rolüne ihtiyaç var.</InlineHint> : null}
              {campaignMutation.isError && <InlineError message={campaignMutation.error.message} />}
              {updateCampaignMutation.isError && <InlineError message={updateCampaignMutation.error.message} />}
            </form>
          </Panel>
        </div>
      </div>
      ) : null}

      {activeContentTab === "collections" ? (
      <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
          <Panel
            title={editingCollectionId ? "Koleksiyonu güncelle" : "Yeni koleksiyon"}
            description="Kampanya bandında ve ürün listeleme sayfasında görünen ürün grupları"
          >
            <form className="grid gap-3" onSubmit={submitCollection}>
              <FieldLabel htmlFor="collection-title">Koleksiyon adı (kampanya bandında ve koleksiyon sayfasında görünür)</FieldLabel>
              <input
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                id="collection-title"
                onChange={(event) => setCollectionForm((current) => ({ ...current, title: event.target.value }))}
                placeholder="Yeni Gelenler"
                value={collectionForm.title}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-zinc-700">Kısa ad (URL, ürün etiketi ve koleksiyon eşleşmesi için kullanılır)</span>
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    onChange={(event) => setCollectionForm((current) => ({ ...current, slug: event.target.value }))}
                    placeholder="yeni-gelenler"
                    value={collectionForm.slug}
                  />
                  <InlineHint>Ürünleri bu koleksiyona bağlamak için ürünün Etiketler alanına bu kısa adı yazın; örn: sepette-20.</InlineHint>
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-zinc-700">Sıra (koleksiyonların ekranda dizilişi)</span>
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    inputMode="numeric"
                    onChange={(event) => setCollectionForm((current) => ({ ...current, sortOrder: event.target.value }))}
                    value={collectionForm.sortOrder}
                  />
                </label>
              </div>
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-zinc-700">Açıklama (koleksiyon sayfasındaki tanıtım metni olarak görünür)</span>
                <textarea
                  className="focus-ring min-h-20 rounded-lg border border-line bg-white px-3 py-2 text-sm"
                  onChange={(event) => setCollectionForm((current) => ({ ...current, description: event.target.value }))}
                  placeholder="Koleksiyon açıklamasını yaz"
                  value={collectionForm.description}
                />
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-zinc-700">Link (boş kalırsa otomatik koleksiyon sayfasına gider)</span>
                <input
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  onChange={(event) => setCollectionForm((current) => ({ ...current, linkUrl: event.target.value }))}
                  placeholder="urunler?collection=yeni-gelenler"
                  value={collectionForm.linkUrl}
                />
                <InlineHint>Önerilen otomatik link: {collectionLink(collectionForm)}</InlineHint>
              </label>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <input
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  onChange={(event) => setCollectionForm((current) => ({ ...current, imageUrl: event.target.value }))}
                  placeholder="Koleksiyon görsel URL'si veya /uploads yolu"
                  value={collectionForm.imageUrl}
                />
                <label className="focus-ring inline-flex h-10 cursor-pointer items-center justify-center rounded-lg border border-line px-3 text-xs font-semibold text-ink">
                  <input
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(event) => {
                      const files = Array.from(event.target.files || []);
                      if (files.length > 0) {
                        uploadCollectionImageMutation.mutate(files.slice(0, 1));
                      }
                      event.currentTarget.value = "";
                    }}
                    type="file"
                  />
                  {uploadCollectionImageMutation.isPending ? "Yükleniyor" : "Görsel yükle"}
                </label>
              </div>
              {collectionForm.imageUrl ? (
                <Image
                  alt=""
                  className="h-24 w-full rounded-lg border border-line object-cover"
                  height={160}
                  src={assetUrl(collectionForm.imageUrl)}
                  unoptimized
                  width={640}
                />
              ) : null}
              <label className="flex h-10 items-center gap-2 text-sm font-semibold text-zinc-700">
                <input
                  checked={collectionForm.active}
                  className="h-4 w-4 rounded border-line"
                  onChange={(event) => setCollectionForm((current) => ({ ...current, active: event.target.checked }))}
                  type="checkbox"
                />
                Aktif (kapalıysa koleksiyon sitede görünmez)
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!canManageContent || collectionMutation.isPending || updateCollectionMutation.isPending || uploadCollectionImageMutation.isPending}
                  type="submit"
                  variant="mint"
                >
                  {updateCollectionMutation.isPending
                    ? "Güncelleniyor"
                    : collectionMutation.isPending
                      ? "Oluşturuluyor"
                      : editingCollectionId
                        ? "Koleksiyonu güncelle"
                        : "Koleksiyon oluştur"}
                </Button>
                {editingCollectionId ? (
                  <Button onClick={resetCollectionForm} type="button" variant="outline">
                    Vazgeç
                  </Button>
                ) : null}
              </div>
              {!canManageContent ? <InlineHint>Bu alanda yazma yetkisi için sahip veya yönetici rolüne ihtiyaç var.</InlineHint> : null}
              {collectionMutation.isError && <InlineError message={collectionMutation.error.message} />}
              {updateCollectionMutation.isError && <InlineError message={updateCollectionMutation.error.message} />}
              {uploadCollectionImageMutation.isError && <InlineError message={uploadCollectionImageMutation.error.message} />}
            </form>
          </Panel>

          <Panel
            title="Koleksiyonlar"
            description="Ürün sayfasındaki seçki ve koleksiyon menüsü"
            actions={collectionsQuery.isFetching ? <StatusPill tone="leaf">Güncelleniyor</StatusPill> : null}
          >
            <DataGrid
              columns={["Sıra", "Ad", "Link", "Durum", "Aksiyon"]}
              emptyMessage="Bu mağaza için henüz koleksiyon yok."
              rows={collections}
              renderRow={(collection) => (
                <tr key={collection.id}>
                  <DataCell>{formatCount(collection.sort_order)}</DataCell>
                  <DataCell>
                    <div className="flex items-center gap-3">
                      <div className="h-11 w-11 shrink-0 overflow-hidden rounded-md border border-line bg-zinc-100">
                        {collection.image_url ? (
                          <Image
                            alt=""
                            className="h-full w-full object-cover"
                            height={88}
                            src={assetUrl(collection.image_url)}
                            unoptimized
                            width={88}
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-xs font-bold text-zinc-400">
                            {collection.title.slice(0, 2).toLocaleUpperCase("tr-TR")}
                          </div>
                        )}
                      </div>
                      <div>
                        <p className="font-semibold text-ink">{collection.title}</p>
                        <p className="line-clamp-1 text-xs text-zinc-500">{collection.description || collection.slug}</p>
                      </div>
                    </div>
                  </DataCell>
                  <DataCell>{collection.link_url || "urunler"}</DataCell>
                  <DataCell>
                    <StatusPill tone={collection.active ? "mint" : "sun"}>
                      {collection.active ? "Aktif" : "Pasif"}
                    </StatusPill>
                  </DataCell>
                  <DataCell>
                    <div className="flex flex-wrap gap-2">
                      {canManageContent ? (
                        <Button onClick={() => startEditingCollection(collection)} size="sm" type="button" variant="outline">
                          Düzenle
                        </Button>
                      ) : null}
                      {canManageContent ? (
                        <Button onClick={() => openCollectionProductsModal(collection)} size="sm" type="button" variant="outline">
                          Ürünleri Yönet
                        </Button>
                      ) : null}
                      {canDeleteContent ? (
                        <Button
                          disabled={deleteCollectionMutation.isPending && deleteCollectionMutation.variables === collection.id}
                          onClick={() => deleteCollectionMutation.mutate(collection.id)}
                          size="sm"
                          type="button"
                          variant="danger"
                        >
                          {deleteCollectionMutation.isPending && deleteCollectionMutation.variables === collection.id ? "Siliniyor" : "Sil"}
                        </Button>
                      ) : null}
                      {!canManageContent && !canDeleteContent ? <span className="text-xs text-zinc-400">Salt okunur</span> : null}
                    </div>
                  </DataCell>
                </tr>
              )}
            />
          </Panel>

      </div>
      ) : null}

      {activeContentTab === "blog" ? (
      <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
          <Panel
            title={editingBlogId ? "Blog yazısını güncelle" : "Yeni blog yazısı"}
            description="SEO, müşteri güveni ve içerik pazarlaması için detaylı blog editörü"
          >
            <form className="grid gap-3" onSubmit={submitBlog}>
              <div className="grid gap-3 rounded-lg border border-line bg-zinc-50 p-3 sm:grid-cols-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">1. Kapak</p>
                  <p className="mt-1 text-sm font-semibold text-ink">Yatay, aydınlık görsel</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">2. SEO</p>
                  <p className="mt-1 text-sm font-semibold text-ink">Başlık, kısa ad, özet</p>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">3. İçerik</p>
                  <p className="mt-1 text-sm font-semibold text-ink">Rehber, bakım, kombin</p>
                </div>
              </div>
              <FieldLabel htmlFor="blog-title">Başlık (Google sonuçlarında, blog kartında ve yazı sayfasında görünür)</FieldLabel>
              <input
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                id="blog-title"
                onChange={(event) => setBlogForm((current) => ({ ...current, title: event.target.value }))}
                placeholder="Kumaş bakım notları"
                value={blogForm.title}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-zinc-700">Kısa ad (blog yazısının URL anahtarı)</span>
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    onChange={(event) => setBlogForm((current) => ({ ...current, slug: event.target.value }))}
                    placeholder="kumas-bakim-notlari"
                    value={blogForm.slug}
                  />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-zinc-700">Yayın tarihi (blog listesi ve detay sayfasında gösterilir)</span>
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    onChange={(event) => setBlogForm((current) => ({ ...current, publishedAt: event.target.value }))}
                    type="date"
                    value={blogForm.publishedAt}
                  />
                </label>
              </div>
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-zinc-700">SEO özeti (blog kartında ve meta açıklama olarak kullanılır)</span>
                <textarea
                  className="focus-ring min-h-20 rounded-lg border border-line bg-white px-3 py-2 text-sm"
                  onChange={(event) => setBlogForm((current) => ({ ...current, excerpt: event.target.value }))}
                  placeholder="Blog kartında görünecek kısa açıklama"
                  value={blogForm.excerpt}
                />
              </label>
              <div className="grid gap-3">
                <span className="text-sm font-semibold text-zinc-700">Kapak görseli (blog kartında ve tekil yazı hero alanında kullanılır)</span>
                <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    onChange={(event) => setBlogForm((current) => ({ ...current, imageUrl: event.target.value }))}
                    placeholder="/uploads/blog.webp"
                    value={blogForm.imageUrl}
                  />
                  <label className="focus-ring inline-flex h-10 cursor-pointer items-center justify-center rounded-lg border border-line px-3 text-xs font-semibold text-ink">
                    <input
                      accept="image/png,image/jpeg,image/webp"
                      className="hidden"
                      onChange={(event) => {
                        const files = Array.from(event.target.files || []);
                        if (files.length > 0) {
                          uploadBlogImageMutation.mutate(files.slice(0, 1));
                        }
                        event.currentTarget.value = "";
                      }}
                      type="file"
                    />
                    {uploadBlogImageMutation.isPending ? "Yükleniyor" : "Kapak görseli yükle"}
                  </label>
                </div>
                <InlineHint>Öneri: yatay 1600x900, ürün/konu net görünen aydınlık bir görsel kullan. Suvera detay sayfasında bu görsel üst kapak olur.</InlineHint>
                {blogForm.imageUrl ? (
                  <Image
                    alt=""
                    className="aspect-[16/9] w-full rounded-lg border border-line object-cover"
                    height={360}
                    src={assetUrl(blogForm.imageUrl)}
                    unoptimized
                    width={640}
                  />
                ) : null}
              </div>
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-zinc-700">Ana içerik (başlıklar, paragraflar ve listelerle detaylı rehber metni)</span>
                <textarea
                  className="focus-ring min-h-72 rounded-lg border border-line bg-white px-3 py-3 text-sm leading-6"
                  onChange={(event) => setBlogForm((current) => ({ ...current, content: event.target.value }))}
                  placeholder={"Örnek yapı:\n## Keten tunik nasıl kombinlenir?\nKısa giriş paragrafı...\n\n- Günlük kullanım için açık ton şal\n- Yaz aylarında nefes alan içlik\n\n## Bakım önerisi\nDüşük ısıda yıkama ve gölgede kurutma önerilir."}
                  value={blogForm.content}
                />
              </label>
              <InlineHint>Satır başında “##” ara başlık, “-” madde listesi olarak Suvera blog detayında profesyonel biçimde görünür.</InlineHint>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-zinc-700">Sıra (blog yazılarının dizilişi)</span>
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    inputMode="numeric"
                    onChange={(event) => setBlogForm((current) => ({ ...current, sortOrder: event.target.value }))}
                    value={blogForm.sortOrder}
                  />
                </label>
              </div>
              <label className="flex h-10 items-center gap-2 text-sm font-semibold text-zinc-700">
                <input
                  checked={blogForm.active}
                  className="h-4 w-4 rounded border-line"
                  onChange={(event) => setBlogForm((current) => ({ ...current, active: event.target.checked }))}
                  type="checkbox"
                />
                Aktif (kapalıysa blog yazısı sitede görünmez)
              </label>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!canManageContent || blogMutation.isPending || updateBlogMutation.isPending}
                  type="submit"
                  variant="mint"
                >
                  {updateBlogMutation.isPending
                    ? "Güncelleniyor"
                    : blogMutation.isPending
                      ? "Oluşturuluyor"
                      : editingBlogId
                        ? "Blog yazısını güncelle"
                        : "Blog yazısı oluştur"}
                </Button>
                {editingBlogId ? (
                  <Button onClick={resetBlogForm} type="button" variant="outline">
                    Vazgeç
                  </Button>
                ) : null}
              </div>
              {!canManageContent ? <InlineHint>Bu alanda yazma yetkisi için sahip veya yönetici rolüne ihtiyaç var.</InlineHint> : null}
              {blogMutation.isError && <InlineError message={blogMutation.error.message} />}
              {updateBlogMutation.isError && <InlineError message={updateBlogMutation.error.message} />}
              {uploadBlogImageMutation.isError && <InlineError message={uploadBlogImageMutation.error.message} />}
            </form>
          </Panel>

          <Panel
            title="Blog yazıları"
            description="Suvera içerik merkezi"
            actions={blogQuery.isFetching ? <StatusPill tone="leaf">Güncelleniyor</StatusPill> : null}
          >
            <DataGrid
              columns={["Sıra", "Başlık", "Yayın", "Durum", "Aksiyon"]}
              emptyMessage="Bu mağaza için henüz blog yazısı yok."
              rows={blogPosts}
              renderRow={(post) => (
                <tr key={post.id}>
                  <DataCell>{formatCount(post.sort_order)}</DataCell>
                  <DataCell>
                    <div className="flex items-center gap-3">
                      <div className="h-11 w-11 shrink-0 overflow-hidden rounded-md border border-line bg-zinc-100">
                        {post.image_url ? (
                          <Image
                            alt=""
                            className="h-full w-full object-cover"
                            height={88}
                            src={assetUrl(post.image_url)}
                            unoptimized
                            width={88}
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center text-xs font-bold text-zinc-400">
                            {post.title.slice(0, 2).toLocaleUpperCase("tr-TR")}
                          </div>
                        )}
                      </div>
                      <div>
                        <p className="font-semibold text-ink">{post.title}</p>
                        <p className="line-clamp-1 text-xs text-zinc-500">{post.excerpt || post.slug}</p>
                      </div>
                    </div>
                  </DataCell>
                  <DataCell>{post.published_at ? formatDateTime(post.published_at) : "-"}</DataCell>
                  <DataCell>
                    <StatusPill tone={post.active ? "mint" : "sun"}>
                      {post.active ? "Aktif" : "Pasif"}
                    </StatusPill>
                  </DataCell>
                  <DataCell>
                    <div className="flex flex-wrap gap-2">
                      {canManageContent ? (
                        <Button onClick={() => startEditingBlog(post)} size="sm" type="button" variant="outline">
                          Düzenle
                        </Button>
                      ) : null}
                      {canDeleteContent ? (
                        <Button
                          disabled={deleteBlogMutation.isPending && deleteBlogMutation.variables === post.id}
                          onClick={() => deleteBlogMutation.mutate(post.id)}
                          size="sm"
                          type="button"
                          variant="danger"
                        >
                          {deleteBlogMutation.isPending && deleteBlogMutation.variables === post.id ? "Siliniyor" : "Sil"}
                        </Button>
                      ) : null}
                      {!canManageContent && !canDeleteContent ? <span className="text-xs text-zinc-400">Salt okunur</span> : null}
                    </div>
                  </DataCell>
                </tr>
              )}
            />
          </Panel>

          <ActivityPanel
            title="İçerik notları"
            items={[
              `${formatCount(activeSlides)} slayt aktif vitrinde sıralanıyor.`,
              `${formatCount(activeCampaigns)} kampanya mağaza akışına hazır.`,
              `${formatCount(activeCollections)} koleksiyon ürün sayfasında yayında.`,
              `${formatCount(activeBlogPosts)} blog yazısı Suvera içerik merkezinde aktif.`,
              scheduledCampaigns > 0
                ? `${formatCount(scheduledCampaigns)} kampanya bitiş tarihiyle takip ediliyor.`
                : "Tarihli kampanya yok.",
            ]}
          />
      </div>
      ) : null}

      {collectionProductsModal ? (
        <div
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={(event) => {
            if (event.target === event.currentTarget) setCollectionProductsModal(null);
          }}
          role="dialog"
        >
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
            <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
              <div>
                <h3 className="text-base font-semibold text-ink">
                  {collectionProductsModal.title} – Ürünleri yönet
                </h3>
                <p className="mt-1 text-xs text-zinc-500">
                  Seçtiğiniz ürünlerin etiketlerine <code>{collectionProductsModal.slug}</code> otomatik
                  eklenir/çıkarılır. Diğer etiketler korunur.
                </p>
              </div>
              <Button
                onClick={() => setCollectionProductsModal(null)}
                size="sm"
                type="button"
                variant="outline"
              >
                Kapat
              </Button>
            </div>
            <div className="border-b border-line px-5 py-3">
              <input
                aria-label="Ürün ara"
                className="w-full rounded-md border border-line px-3 py-2 text-sm focus:border-ink focus:outline-none"
                onChange={(event) => setCollectionProductFilter(event.target.value)}
                placeholder="Ürün adı ile filtrele..."
                type="search"
                value={collectionProductFilter}
              />
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {collectionProductsQuery.isLoading ? (
                <p className="py-8 text-center text-sm text-zinc-500">Ürünler yükleniyor...</p>
              ) : collectionProductsQuery.isError ? (
                <InlineError message={collectionProductsQuery.error.message} />
              ) : collectionProductsQuery.data ? (
                <CollectionProductPicker
                  filter={collectionProductFilter}
                  onToggle={(productId, nextChecked) => {
                    setCollectionProductOverrides((prev) => {
                      const next = new Map(prev);
                      next.set(productId, nextChecked);
                      return next;
                    });
                  }}
                  products={collectionProductsQuery.data.products}
                  selectedIds={collectionProductSelectedIds}
                />
              ) : null}
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3">
              <span className="text-xs text-zinc-500">
                {collectionProductSelectedIds.length} ürün seçildi
              </span>
              <div className="flex gap-2">
                <Button
                  onClick={() => setCollectionProductsModal(null)}
                  type="button"
                  variant="outline"
                >
                  Vazgeç
                </Button>
                <Button
                  disabled={collectionProductsMutation.isPending || collectionProductsQuery.isLoading}
                  onClick={() => {
                    if (!collectionProductsModal) return;
                    collectionProductsMutation.mutate({
                      id: collectionProductsModal.id,
                      memberIds: collectionProductSelectedIds,
                    });
                  }}
                  type="button"
                >
                  {collectionProductsMutation.isPending ? "Kaydediliyor..." : "Kaydet"}
                </Button>
              </div>
            </div>
            {collectionProductsMutation.isError ? (
              <div className="border-t border-line px-5 py-2">
                <InlineError message={collectionProductsMutation.error.message} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function CollectionProductPicker({
  products,
  selectedIds,
  onToggle,
  filter,
}: {
  products: CollectionProductMembership[];
  selectedIds: number[];
  onToggle: (id: number, nextChecked: boolean) => void;
  filter: string;
}) {
  const selectedSet = new Set(selectedIds);
  const query = filter.trim().toLocaleLowerCase("tr-TR");
  const visible = query
    ? products.filter((product) => product.name.toLocaleLowerCase("tr-TR").includes(query))
    : products;
  if (visible.length === 0) {
    return <p className="py-6 text-center text-sm text-zinc-500">Eşleşen ürün bulunamadı.</p>;
  }
  return (
    <ul className="space-y-1">
      {visible.map((product) => {
        const id = Number(product.id);
        const checked = selectedSet.has(id);
        return (
          <li key={id}>
            <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-zinc-50">
              <input
                checked={checked}
                onChange={() => onToggle(id, !checked)}
                type="checkbox"
              />
              <span className="flex-1 truncate">{product.name}</span>
              <span className="text-xs uppercase text-zinc-400">{product.status}</span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function formatCampaignValue(campaign: ApiCampaign) {
  const value = Number(campaign.value || 0);
  const normalizedType = campaign.type.toLocaleLowerCase("tr-TR");
  if (normalizedType.includes("percent") || normalizedType.includes("yuzde")) {
    return `%${formatCount(value)}`;
  }
  if (normalizedType.includes("bundle") || normalizedType.includes("al")) {
    return campaign.type;
  }
  return formatCount(value);
}
