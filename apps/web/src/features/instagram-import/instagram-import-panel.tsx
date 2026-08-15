"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Panel, SectionError, SectionLoading } from "@/components/operations-shared";
import { fetchCategories } from "@/lib/api/catalog";
import {
  analyzeInstagramMedia, analyzeInstagramMediaBulk, applyInstagramDraft, applyInstagramDraftsBulk,
  disconnectInstagram, discardInstagramDraft,
  fetchInstagramConnections, fetchInstagramDraft, fetchInstagramMedia, skipInstagramDraft,
  instagramDraftErrorMessage, instagramImportErrorMessage, skipInstagramDraftsBulk, startInstagramOAuth,
  syncInstagram, updateInstagramDraft, type InstagramDraftPatch,
} from "@/lib/api/instagram-import";
import { queryKeys } from "@/lib/query-keys";
import { useToastStore } from "@/store/toast";
import { InstagramDraftEditor } from "./instagram-draft-editor";

const statuses = ["", "discovered", "analyzing", "needs_review", "ready", "applied", "skipped", "error"];

export function InstagramImportPanel({ organizationSlug }: { organizationSlug: string }) {
  const queryClient = useQueryClient();
  const toast = useToastStore((state) => state.pushToast);
  const [status, setStatus] = useState("");
  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [selectedMediaIds, setSelectedMediaIds] = useState<string[]>([]);
  const invalidate = async () => queryClient.invalidateQueries({ queryKey: queryKeys.instagramImport.all(organizationSlug) });
  const connectionsQuery = useQuery({ queryKey: queryKeys.instagramImport.connections(organizationSlug), queryFn: fetchInstagramConnections, staleTime: 30_000 });
  const mediaQuery = useQuery({
    queryKey: queryKeys.instagramImport.media(organizationSlug, status),
    queryFn: ({ signal }) => fetchInstagramMedia(status, signal),
    refetchInterval: (query) => query.state.data?.some((item) => ["analyzing", "pending"].includes(item.status)) ? 4_000 : false,
  });
  const categoriesQuery = useQuery({ queryKey: queryKeys.catalog.categories(organizationSlug), queryFn: fetchCategories, staleTime: 60_000 });
  const draftQuery = useQuery({
    queryKey: queryKeys.instagramImport.draft(organizationSlug, selectedDraftId),
    queryFn: ({ signal }) => fetchInstagramDraft(selectedDraftId || "", signal), enabled: Boolean(selectedDraftId),
  });

  const connectMutation = useMutation({
    mutationFn: startInstagramOAuth,
    onSuccess: ({ authorization_url: authorizationUrl }) => {
      const target = new URL(authorizationUrl);
      if (target.origin !== "https://www.instagram.com") throw new Error("Geçersiz Instagram yetkilendirme adresi");
      window.location.assign(target.toString());
    },
  });
  const syncMutation = useMutation({ mutationFn: ({ id, mode }: { id: string; mode: "full" | "incremental" }) => syncInstagram(id, mode), onSuccess: async (result) => { await invalidate(); toast({ title: "Instagram senkronize edildi", description: `${result.discovered} yeni, ${result.changed} güncellenen gönderi`, tone: "success" }); } });
  const disconnectMutation = useMutation({ mutationFn: disconnectInstagram, onSuccess: invalidate });
  const analyzeMutation = useMutation({ mutationFn: ({ id, force }: { id: string; force: boolean }) => analyzeInstagramMedia(id, force), onSuccess: invalidate });
  const bulkAnalyzeMutation = useMutation({ mutationFn: analyzeInstagramMediaBulk, onSuccess: async () => { setSelectedMediaIds([]); await invalidate(); } });
  const saveMutation = useMutation({ mutationFn: ({ id, patch }: { id: string; patch: InstagramDraftPatch }) => updateInstagramDraft(id, patch), onSuccess: async () => { await invalidate(); if (selectedDraftId) await queryClient.invalidateQueries({ queryKey: queryKeys.instagramImport.draft(organizationSlug, selectedDraftId) }); toast({ title: "Taslak kaydedildi", tone: "success" }); } });
  const applyMutation = useMutation({ mutationFn: applyInstagramDraft, onSuccess: async (product) => { setSelectedDraftId(null); await Promise.all([invalidate(), queryClient.invalidateQueries({ queryKey: queryKeys.catalog.products.all(organizationSlug) })]); toast({ title: "Taslak ürün oluşturuldu", description: `Ürün #${product.id} taslak olarak kataloğa eklendi.`, tone: "success" }); } });
  const skipMutation = useMutation({ mutationFn: skipInstagramDraft, onSuccess: async () => { setSelectedDraftId(null); await invalidate(); } });
  const discardMutation = useMutation({ mutationFn: discardInstagramDraft, onSuccess: async () => { setSelectedDraftId(null); await invalidate(); } });
  const bulkApplyMutation = useMutation({ mutationFn: applyInstagramDraftsBulk, onSuccess: async (products) => { setSelectedMediaIds([]); await Promise.all([invalidate(), queryClient.invalidateQueries({ queryKey: queryKeys.catalog.products.all(organizationSlug) })]); toast({ title: `${products.length} taslak ürün oluşturuldu`, tone: "success" }); } });
  const bulkSkipMutation = useMutation({ mutationFn: skipInstagramDraftsBulk, onSuccess: async () => { setSelectedMediaIds([]); await invalidate(); } });
  const connection = connectionsQuery.data?.find((item) => item.status === "active") || connectionsQuery.data?.[0];
  const error = connectionsQuery.error || mediaQuery.error || connectMutation.error || syncMutation.error || analyzeMutation.error || saveMutation.error || applyMutation.error;
  const busy = syncMutation.isPending || analyzeMutation.isPending || bulkAnalyzeMutation.isPending || saveMutation.isPending || applyMutation.isPending || bulkApplyMutation.isPending || skipMutation.isPending || bulkSkipMutation.isPending || discardMutation.isPending;
  const selectedMedia = (mediaQuery.data || []).filter((item) => selectedMediaIds.includes(item.id));
  const selectedDraftIds = selectedMedia.map((item) => item.draft_id).filter((id): id is string => Boolean(id));
  const selectedReadyDraftIds = selectedMedia.filter((item) => ["ready", "needs_review"].includes(item.draft_status || "") && item.product_name && Number(item.price) > 0).map((item) => item.draft_id).filter((id): id is string => Boolean(id));

  return (
    <div className="space-y-5">
      <Panel title="Instagram bağlantısı" description="Business veya Creator hesabını resmi Instagram Login akışıyla bağlayın.">
        {connectionsQuery.isLoading ? <SectionLoading /> : connection ? (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-zinc-50 p-4">
            <div><p className="font-semibold text-ink">@{connection.username || "hesap"}</p><p className="text-sm text-zinc-600">{connection.account_type || "Profesyonel hesap"} · {connection.status}</p><p className="mt-1 text-xs text-zinc-600">Son senkronizasyon: {connection.last_synced_at ? new Date(connection.last_synced_at).toLocaleString("tr-TR") : "Henüz yapılmadı"}</p></div>
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy || connection.status !== "active"} onClick={() => syncMutation.mutate({ id: connection.id, mode: "incremental" })} type="button">Yeni gönderileri al</Button>
              <Button disabled={busy || connection.status !== "active"} onClick={() => syncMutation.mutate({ id: connection.id, mode: "full" })} type="button" variant="outline">Tam senkronizasyon</Button>
              <Button disabled={busy} onClick={() => disconnectMutation.mutate(connection.id)} type="button" variant="outline">Bağlantıyı kes</Button>
            </div>
          </div>
        ) : <Button disabled={connectMutation.isPending} onClick={() => connectMutation.mutate()} type="button">Instagram hesabı bağla</Button>}
      </Panel>

      <Panel title="Gönderiler ve AI taslakları" description="Gönderileri analiz edin, önerileri gözden geçirin ve kataloğa taslak ürün olarak aktarın." actions={<label className="text-sm font-medium text-ink">Durum <select className="focus-ring ml-2 h-9 rounded-lg border border-line bg-white px-2" onChange={(event) => setStatus(event.target.value)} value={status}>{statuses.map((value) => <option key={value || "all"} value={value}>{value || "Tümü"}</option>)}</select></label>}>
        {error ? <SectionError message={instagramImportErrorMessage(error)} /> : null}
        {mediaQuery.isLoading ? <SectionLoading /> : null}
        {selectedMediaIds.length ? <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-zinc-50 p-3"><span className="text-sm font-semibold text-ink">{selectedMediaIds.length} seçili</span><Button disabled={busy} onClick={() => bulkAnalyzeMutation.mutate(selectedMediaIds)} size="sm" type="button" variant="outline">Toplu analiz</Button><Button disabled={busy || selectedReadyDraftIds.length !== selectedMediaIds.length} onClick={() => bulkApplyMutation.mutate(selectedReadyDraftIds)} size="sm" type="button">Toplu taslak oluştur</Button><Button disabled={busy || selectedDraftIds.length !== selectedMediaIds.length} onClick={() => bulkSkipMutation.mutate(selectedDraftIds)} size="sm" type="button" variant="outline">Toplu atla</Button><Button onClick={() => setSelectedMediaIds([])} size="sm" type="button" variant="outline">Seçimi temizle</Button></div> : null}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {(mediaQuery.data || []).map((item) => (
            <article className="rounded-xl border border-line bg-white p-4" key={item.id}>
              <div className="flex items-start justify-between gap-2"><label className="flex items-center gap-2 text-xs font-semibold text-zinc-600"><input aria-label="Gönderiyi seç" checked={selectedMediaIds.includes(item.id)} onChange={(event) => setSelectedMediaIds((ids) => event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} type="checkbox" /><span className="rounded-full bg-zinc-100 px-2 py-1">{item.media_type}</span></label><span className="text-xs font-semibold text-zinc-600">{item.draft_status || item.status}</span></div>
              <p className="mt-3 line-clamp-4 min-h-20 whitespace-pre-wrap text-sm text-zinc-600">{item.caption || "Açıklama yok"}</p>
              {item.visual_analysis_limited ? <p className="mt-2 text-xs text-amber-700">Video için yalnız kapak görseli analiz edilebilir.</p> : null}
              {item.source_changed ? <p className="mt-2 text-xs font-semibold text-amber-700">Kaynak gönderi değişti; yeniden analiz önerilir.</p> : null}
              {item.error_code ? <p className="mt-2 text-xs font-semibold text-amber-700">{instagramDraftErrorMessage(item.error_code)}</p> : null}
              <div className="mt-4 flex flex-wrap gap-2">
                {item.draft_id && ["ready", "needs_review", "error"].includes(item.draft_status || "") ? <Button onClick={() => setSelectedDraftId(item.draft_id)} size="sm" type="button">Taslağı incele</Button> : null}
                {!item.draft_id || ["error", "skipped"].includes(item.status) || item.source_changed ? <Button disabled={busy} onClick={() => analyzeMutation.mutate({ id: item.id, force: Boolean(item.draft_id) })} size="sm" type="button" variant="outline">{item.draft_id ? "Yeniden analiz" : "AI ile analiz et"}</Button> : null}
                {item.permalink ? <a className="focus-ring rounded-md border border-line px-3 py-1.5 text-xs font-semibold" href={item.permalink} rel="noreferrer" target="_blank">Gönderi</a> : null}
              </div>
            </article>
          ))}
        </div>
        {!mediaQuery.isLoading && !mediaQuery.data?.length ? <p className="py-8 text-center text-sm text-zinc-600">Henüz senkronize edilmiş gönderi yok.</p> : null}
      </Panel>

      {selectedDraftId && draftQuery.isLoading ? <SectionLoading /> : null}
      {selectedDraftId && draftQuery.data ? <InstagramDraftEditor key={draftQuery.data.id} draft={draftQuery.data} categories={categoriesQuery.data || []} busy={busy} onApply={(patch) => saveMutation.mutate({ id: selectedDraftId, patch }, { onSuccess: () => applyMutation.mutate(selectedDraftId) })} onClose={() => setSelectedDraftId(null)} onDiscard={() => discardMutation.mutate(selectedDraftId)} onSave={(patch) => saveMutation.mutate({ id: selectedDraftId, patch })} onSkip={() => skipMutation.mutate(selectedDraftId)} /> : null}
    </div>
  );
}
