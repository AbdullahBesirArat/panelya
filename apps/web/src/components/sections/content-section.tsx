"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MetricGrid } from "@/components/page-kit";
import { Button } from "@/components/ui/button";
import {
  createCampaign,
  createSlide,
  deleteCampaign,
  deleteSlide,
  fetchCampaigns,
  fetchSlides,
  updateCampaign,
  updateSlide,
  type ApiCampaign,
  type ApiSlide,
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
  const [slideForm, setSlideForm] = useState(emptySlideForm);
  const [campaignForm, setCampaignForm] = useState(emptyCampaignForm);

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

  if (slidesQuery.isLoading || campaignsQuery.isLoading) return <SectionLoading />;
  if (slidesQuery.isError || campaignsQuery.isError || !slidesQuery.data || !campaignsQuery.data) {
    return (
      <SectionError
        message="İçerik verisi yüklenemedi."
        onRetry={() => {
          void slidesQuery.refetch();
          void campaignsQuery.refetch();
        }}
      />
    );
  }

  const slides = slidesQuery.data;
  const campaigns = campaignsQuery.data;
  const activeSlides = slides.filter((slide) => slide.active).length;
  const activeCampaigns = campaigns.filter((campaign) => campaign.active).length;
  const scheduledCampaigns = campaigns.filter((campaign) => campaign.active && campaign.end_date).length;

  async function invalidateContent() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["slides", organizationSlug] }),
      queryClient.invalidateQueries({ queryKey: ["campaigns", organizationSlug] }),
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

  return (
    <>
      <MetricGrid
        metrics={[
          { label: "Aktif slayt", value: formatCount(activeSlides), tone: "mint" },
          { label: "Tüm slayt", value: formatCount(slides.length), tone: "leaf" },
          { label: "Aktif kampanya", value: formatCount(activeCampaigns), tone: "sun" },
          { label: "Tarihli kampanya", value: formatCount(scheduledCampaigns), tone: "coral" },
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
