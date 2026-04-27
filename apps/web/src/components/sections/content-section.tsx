"use client";

import type { FormEvent } from "react";
import Image from "next/image";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MetricGrid } from "@/components/page-kit";
import { Button } from "@/components/ui/button";
import {
  API_BASE,
  createCampaign,
  createCollection,
  createSlide,
  deleteCampaign,
  deleteCollection,
  deleteSlide,
  fetchCampaigns,
  fetchCollections,
  fetchSlides,
  updateCampaign,
  updateCollection,
  updateSlide,
  type ApiCampaign,
  type ApiCollection,
  type ApiSlide,
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
  linkUrl: "urunler.html",
  sortOrder: "0",
  active: true,
};

function assetUrl(url: string | null | undefined) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return `${API_BASE.replace(/\/api\/?$/, "")}${url}`;
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
  const [slideForm, setSlideForm] = useState(emptySlideForm);
  const [campaignForm, setCampaignForm] = useState(emptyCampaignForm);
  const [collectionForm, setCollectionForm] = useState(emptyCollectionForm);

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

  if (slidesQuery.isLoading || campaignsQuery.isLoading || collectionsQuery.isLoading) return <SectionLoading />;
  if (slidesQuery.isError || campaignsQuery.isError || collectionsQuery.isError || !slidesQuery.data || !campaignsQuery.data || !collectionsQuery.data) {
    return (
      <SectionError
        message="İçerik verisi yüklenemedi."
        onRetry={() => {
          void slidesQuery.refetch();
          void campaignsQuery.refetch();
          void collectionsQuery.refetch();
        }}
      />
    );
  }

  const slides = slidesQuery.data;
  const campaigns = campaignsQuery.data;
  const collections = collectionsQuery.data;
  const activeSlides = slides.filter((slide) => slide.active).length;
  const activeCampaigns = campaigns.filter((campaign) => campaign.active).length;
  const activeCollections = collections.filter((collection) => collection.active).length;
  const scheduledCampaigns = campaigns.filter((campaign) => campaign.active && campaign.end_date).length;

  async function invalidateContent() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["slides", organizationSlug] }),
      queryClient.invalidateQueries({ queryKey: ["campaigns", organizationSlug] }),
      queryClient.invalidateQueries({ queryKey: ["collections", organizationSlug] }),
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
      linkUrl: collection.link_url || "urunler.html",
      sortOrder: String(collection.sort_order || 0),
      active: collection.active,
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

    const payload = {
      title: collectionForm.title.trim(),
      slug: collectionForm.slug.trim(),
      description: collectionForm.description.trim(),
      imageUrl: collectionForm.imageUrl.trim(),
      linkUrl: collectionForm.linkUrl.trim() || "urunler.html",
      sortOrder,
      active: collectionForm.active,
    };

    if (editingCollectionId) {
      updateCollectionMutation.mutate({ id: editingCollectionId, payload });
      return;
    }

    collectionMutation.mutate(payload);
  }

  return (
    <>
      <MetricGrid
        metrics={[
          { label: "Aktif slayt", value: formatCount(activeSlides), tone: "mint" },
          { label: "Tüm slayt", value: formatCount(slides.length), tone: "leaf" },
          { label: "Aktif kampanya", value: formatCount(activeCampaigns), tone: "sun" },
          { label: "Koleksiyon", value: formatCount(activeCollections), tone: "coral" },
        ]}
      />

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
            <FieldLabel htmlFor="slide-title">Başlık</FieldLabel>
            <input
              className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
              id="slide-title"
              onChange={(event) => setSlideForm((current) => ({ ...current, title: event.target.value }))}
              placeholder="Yeni sezon vitrini"
              value={slideForm.title}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-zinc-700">Etiket</span>
                <input
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  onChange={(event) => setSlideForm((current) => ({ ...current, tag: event.target.value }))}
                  placeholder="Koleksiyon"
                  value={slideForm.tag}
                />
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-zinc-700">Buton</span>
                <input
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  onChange={(event) => setSlideForm((current) => ({ ...current, btn: event.target.value }))}
              placeholder="Keşfet"
                  value={slideForm.btn}
                />
              </label>
            </div>
            <label className="grid gap-2">
              <span className="text-sm font-semibold text-zinc-700">Alt metin</span>
              <textarea
                className="focus-ring min-h-24 rounded-lg border border-line bg-white px-3 py-2 text-sm"
                onChange={(event) => setSlideForm((current) => ({ ...current, sub: event.target.value }))}
                placeholder="Vitrin mesajini yaz"
                value={slideForm.sub}
              />
            </label>
            <label className="grid gap-2">
              <span className="text-sm font-semibold text-zinc-700">Görsel URL</span>
              <input
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                onChange={(event) => setSlideForm((current) => ({ ...current, imageUrl: event.target.value }))}
                placeholder="https://..."
                value={slideForm.imageUrl}
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-zinc-700">Sıra</span>
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
                Aktif
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
              <FieldLabel htmlFor="campaign-name">Kampanya adı</FieldLabel>
              <input
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                id="campaign-name"
                onChange={(event) => setCampaignForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Bahar indirimi"
                value={campaignForm.name}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-zinc-700">Tip</span>
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    onChange={(event) => setCampaignForm((current) => ({ ...current, type: event.target.value }))}
                    placeholder="yüzde"
                    value={campaignForm.type}
                  />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-zinc-700">Değer</span>
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
                  <span className="text-sm font-semibold text-zinc-700">Bitiş tarihi</span>
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
                  Aktif
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

          <Panel
            title={editingCollectionId ? "Koleksiyonu güncelle" : "Yeni koleksiyon"}
            description="Ürün listeleme sayfasındaki koleksiyon bağlantıları"
          >
            <form className="grid gap-3" onSubmit={submitCollection}>
              <FieldLabel htmlFor="collection-title">Koleksiyon adı</FieldLabel>
              <input
                className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                id="collection-title"
                onChange={(event) => setCollectionForm((current) => ({ ...current, title: event.target.value }))}
                placeholder="Yeni Gelenler"
                value={collectionForm.title}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-zinc-700">Kısa ad</span>
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    onChange={(event) => setCollectionForm((current) => ({ ...current, slug: event.target.value }))}
                    placeholder="yeni-gelenler"
                    value={collectionForm.slug}
                  />
                </label>
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-zinc-700">Sıra</span>
                  <input
                    className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                    inputMode="numeric"
                    onChange={(event) => setCollectionForm((current) => ({ ...current, sortOrder: event.target.value }))}
                    value={collectionForm.sortOrder}
                  />
                </label>
              </div>
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-zinc-700">Açıklama</span>
                <textarea
                  className="focus-ring min-h-20 rounded-lg border border-line bg-white px-3 py-2 text-sm"
                  onChange={(event) => setCollectionForm((current) => ({ ...current, description: event.target.value }))}
                  placeholder="Koleksiyon açıklamasını yaz"
                  value={collectionForm.description}
                />
              </label>
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-zinc-700">Link</span>
                <input
                  className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
                  onChange={(event) => setCollectionForm((current) => ({ ...current, linkUrl: event.target.value }))}
                  placeholder="urunler.html?collection=yeni-gelenler"
                  value={collectionForm.linkUrl}
                />
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
                Aktif
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
                  <DataCell>{collection.link_url || "urunler.html"}</DataCell>
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

          <ActivityPanel
            title="İçerik notları"
            items={[
              `${formatCount(activeSlides)} slayt aktif vitrinde sıralanıyor.`,
              `${formatCount(activeCampaigns)} kampanya mağaza akışına hazır.`,
              scheduledCampaigns > 0
                ? `${formatCount(scheduledCampaigns)} kampanya bitiş tarihiyle takip ediliyor.`
                : "Tarihli kampanya yok.",
            ]}
          />
        </div>
      </div>
    </>
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
