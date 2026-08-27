"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DataCell, DataGrid, EmptyText, FieldLabel, InlineError, InlineHint, Panel,
  SectionError, SectionLoading, StatusPill, formatDateTime,
} from "@/components/operations-shared";
import {
  createThemeDraft, createThemePreviewToken, fetchPublishedTheme, fetchThemeDraft,
  fetchThemeVersions, publishThemeDraft, rollbackTheme, saveThemeDraft, validateThemeConfig,
  type ThemeColorKey, type ThemeConfig, type ThemeFontStack, type ThemeSection,
  type ThemeSectionType, type ThemeTrustIcon, type ThemeValidationReport, type ThemeVersion,
} from "@/lib/api/themes";
import { fetchCategories } from "@/lib/api/catalog";
import { fetchCollections } from "@/lib/api/content";
import { fetchDomains } from "@/lib/api/domains";
import {
  fetchMediaAssets, MEDIA_UPLOAD_ACCEPT, resolveApiAssetUrl, uploadMediaAsset, type MediaAsset,
} from "@/lib/api/media";
import { getApiErrorCode } from "@/lib/api/types";
import { queryKeys } from "@/lib/query-keys";
import {
  COLOR_FIELDS, FONT_OPTIONS, NUMERIC_BOUNDS, SECTION_OPTIONS, TRUST_ICON_OPTIONS, canPublish, clampToBounds,
  createSection,
  draftDiffersFromPublished, moveSection, normalizeHex, previewUrl, saveStateLabel,
  sectionLabel, sectionSummary, themeErrorMessage, toggleSection, versionLabel,
  withSections, withTokens, type SaveState,
} from "@/features/theme/presentation";

const inputClass =
  "focus-ring h-9 w-full rounded-lg border border-line bg-white px-3 text-sm text-zinc-800";
const AUTOSAVE_DELAY_MS = 1200;
const MANAGE_ROLES = ["super_admin", "owner", "admin"];
const SINGLETON_SECTION_TYPES = new Set<ThemeSectionType>(["hero", "newsletter"]);

function errorText(error: unknown) {
  return themeErrorMessage(getApiErrorCode(error), error instanceof Error ? error.message : "");
}

function sourceValue(source: { type: string; id?: number | string }) {
  if (source.type === "none") return "none";
  return (source.type === "category" || source.type === "collection") && Number.isInteger(Number(source.id))
    ? `${source.type}:${source.id}`
    : "products";
}

function sourceFromValue(value: string) {
  if (value === "none") return { type: "none" } as const;
  const [type, rawId] = value.split(":");
  const id = Number(rawId);
  if ((type === "category" || type === "collection") && Number.isInteger(id) && id > 0) {
    return { type, id } as const;
  }
  return { type: "products" } as const;
}

function MediaAssetSelect({
  assets, disabled, id, label, loading, organizationSlug, value, onChange,
}: {
  assets: MediaAsset[];
  disabled: boolean;
  id: string;
  label: string;
  loading: boolean;
  organizationSlug: string;
  value: string | null;
  onChange: (mediaId: string | null) => void;
}) {
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState("");
  const selectable = assets.filter((asset) => asset.status === "ready");
  const selected = selectable.find((asset) => asset.id === value) ?? null;
  const previewUrl = selected
    ? resolveApiAssetUrl(selected.variants.thumbnail?.url || selected.variants.card?.url || selected.url)
    : "";
  const selectedMissing = Boolean(value && !selected);

  async function upload(file: File | null) {
    if (!file || disabled || uploading) return;
    setUploading(true);
    setUploadProgress(0);
    setUploadError("");
    try {
      const uploaded = await uploadMediaAsset(file, setUploadProgress);
      onChange(uploaded.id);
      await queryClient.invalidateQueries({ queryKey: ["media-assets", organizationSlug] });
      await queryClient.refetchQueries({ queryKey: ["media-assets", organizationSlug], type: "active" });
    } catch (uploadFailure) {
      setUploadError(uploadFailure instanceof Error ? uploadFailure.message : "Görsel yüklenemedi.");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  return (
    <div className="grid gap-2">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select
        className={inputClass}
        disabled={disabled || loading}
        id={id}
        onChange={(event) => onChange(event.target.value || null)}
        value={value ?? ""}
      >
        <option value="">{loading ? "Görseller yükleniyor…" : "Görsel seçilmedi"}</option>
        {selectedMissing ? <option value={value ?? ""}>Mevcut seçili görsel</option> : null}
        {selectable.map((asset) => (
          <option key={asset.id} value={asset.id}>
            {asset.original_filename || "İsimsiz görsel"}
            {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ""}
          </option>
        ))}
      </select>
      {previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- URLs may be tenant CDN or same-origin BFF assets.
        <img
          alt={selected?.original_filename || "Seçili görsel önizlemesi"}
          className="mt-2 h-28 w-full rounded-lg border border-line object-cover"
          loading="lazy"
          src={previewUrl}
        />
      ) : null}
      <input
        accept={MEDIA_UPLOAD_ACCEPT}
        className="sr-only"
        disabled={disabled || uploading}
        onChange={(event) => void upload(event.target.files?.[0] ?? null)}
        ref={fileInput}
        type="file"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={disabled || uploading}
          onClick={() => fileInput.current?.click()}
          type="button"
          variant="outline"
        >
          {uploading ? "Yükleniyor…" : "Görsel Yükle"}
        </Button>
        <span className="text-xs text-zinc-500">JPEG, PNG veya WebP · en fazla 5 MB</span>
      </div>
      {uploading ? (
        <div aria-label={`Yükleme ilerlemesi yüzde ${uploadProgress}`} className="grid gap-1" role="status">
          <progress className="h-2 w-full" max={100} value={uploadProgress} />
          <span className="text-xs text-zinc-500">%{uploadProgress}</span>
        </div>
      ) : null}
      {uploadError ? <p className="text-xs font-medium text-red-700" role="alert">{uploadError}</p> : null}
    </div>
  );
}

export function ThemeSection({ organizationSlug, currentRole }: { organizationSlug: string; currentRole: string }) {
  const queryClient = useQueryClient();
  const canManage = MANAGE_ROLES.includes(currentRole);

  const [config, setConfig] = useState<ThemeConfig | null>(null);
  const [expectedHash, setExpectedHash] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [report, setReport] = useState<ThemeValidationReport | null>(null);
  const [publishReason, setPublishReason] = useState("");
  const [rollbackReason, setRollbackReason] = useState("");
  const [rollbackTarget, setRollbackTarget] = useState<number | null>(null);
  // The raw preview token lives only here, for this render. It is handed to the frame in a
  // URL fragment (never sent to a server, never logged) and is not stored anywhere else.
  const [previewSrc, setPreviewSrc] = useState("");
  const [previewWidth, setPreviewWidth] = useState<"desktop" | "mobile">("desktop");
  const [newSectionType, setNewSectionType] = useState<ThemeSectionType>("product-carousel");
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const publishedQuery = useQuery({
    queryKey: queryKeys.theme.published(organizationSlug),
    queryFn: fetchPublishedTheme,
  });
  const draftQuery = useQuery({
    queryKey: queryKeys.theme.draft(organizationSlug),
    queryFn: fetchThemeDraft,
  });
  const versionsQuery = useQuery({
    queryKey: queryKeys.theme.versions(organizationSlug),
    queryFn: () => fetchThemeVersions(30),
  });
  // A27: the preview has to run on the storefront's own origin, which is the tenant's
  // canonical custom domain when they have one.
  const domainsQuery = useQuery({
    queryKey: queryKeys.domains.tenant(organizationSlug),
    queryFn: fetchDomains,
  });
  const categoriesQuery = useQuery({
    queryKey: queryKeys.catalog.categories(organizationSlug),
    queryFn: fetchCategories,
  });
  const collectionsQuery = useQuery({
    queryKey: queryKeys.content.collections(organizationSlug),
    queryFn: fetchCollections,
  });
  const mediaQuery = useQuery({
    enabled: canManage,
    queryKey: ["media-assets", organizationSlug],
    queryFn: fetchMediaAssets,
  });

  const draft = draftQuery.data?.draft ?? null;
  const published = publishedQuery.data?.theme ?? null;

  // Adopt the server's draft whenever a new one arrives (first load, refetch after a
  // conflict, publish). Local edits are kept while the hash is unchanged.
  // The hash the editor has already adopted, tracked in a ref rather than read back out of
  // state: the check has to happen in the effect, not inside a state updater, because
  // updaters run during render and must stay free of other setState calls.
  const adoptedHash = useRef<string | null>(null);
  useEffect(() => {
    if (!draft) return;
    if (adoptedHash.current === draft.validation_hash) return;
    adoptedHash.current = draft.validation_hash;
    setConfig(draft.config);
    setReport(draft.validation_result);
    setSaveState("idle");
    setExpectedHash(draft.validation_hash);
  }, [draft]);

  const storefrontOrigin = useMemo(() => {
    const canonical = (domainsQuery.data?.items ?? []).find(
      (domain) => domain.is_canonical && domain.status === "active"
    );
    if (canonical) return `https://${canonical.hostname}`;
    return process.env.NEXT_PUBLIC_STOREFRONT_URL || "";
  }, [domainsQuery.data]);

  // Every hash the editor accepts goes through here so the ref above never falls behind the
  // state: a stale ref would let a refetch overwrite the config the user is editing.
  const adoptHash = useCallback((hash: string | null) => {
    adoptedHash.current = hash;
    setExpectedHash(hash);
  }, []);

  const invalidateAll = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.theme.published(organizationSlug) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.theme.draft(organizationSlug) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.theme.versions(organizationSlug) }),
    ]);
  }, [queryClient, organizationSlug]);

  const createDraftMutation = useMutation({
    mutationFn: createThemeDraft,
    onSuccess: async (result) => {
      setError("");
      setConfig(result.draft.config);
      adoptHash(result.draft.validation_hash);
      setSaveState("idle");
      await invalidateAll();
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });

  const saveMutation = useMutation({
    mutationFn: (next: ThemeConfig) => saveThemeDraft(next, expectedHash),
    onSuccess: async (result) => {
      adoptHash(result.draft.validation_hash);
      setReport(result.draft.validation_result);
      setSaveState("saved");
      setError("");
      await queryClient.invalidateQueries({ queryKey: queryKeys.theme.draft(organizationSlug) });
    },
    onError: (mutationError) => {
      // A conflict is not an error to swallow: the editor stops autosaving and asks the
      // user to reload the newer draft, so nobody's work is silently overwritten.
      if (getApiErrorCode(mutationError) === "THEME_VERSION_CONFLICT") setSaveState("conflict");
      else setSaveState("error");
      setError(errorText(mutationError));
    },
  });

  const validateMutation = useMutation({
    mutationFn: () => validateThemeConfig(config ?? undefined),
    onSuccess: (result) => {
      setReport(result.report);
      setError("");
      setNotice(result.report.valid ? "Tema doğrulamadan geçti." : "");
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });

  const publishMutation = useMutation({
    mutationFn: () => publishThemeDraft(expectedHash, publishReason.trim()),
    onSuccess: async () => {
      setNotice("Tema yayınlandı.");
      setError("");
      setPublishReason("");
      setSaveState("idle");
      adoptHash(null);
      await invalidateAll();
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });

  const rollbackMutation = useMutation({
    mutationFn: (versionId: number) => rollbackTheme(versionId, rollbackReason.trim()),
    onSuccess: async () => {
      setNotice("Seçilen sürüm yeniden yayınlandı.");
      setError("");
      setRollbackReason("");
      setRollbackTarget(null);
      adoptHash(null);
      await invalidateAll();
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });

  const previewMutation = useMutation({
    mutationFn: () => createThemePreviewToken(draft?.id),
    onSuccess: (result) => {
      setError("");
      setPreviewSrc(previewUrl(storefrontOrigin, result.token));
    },
    onError: (mutationError) => setError(errorText(mutationError)),
  });

  // Autosave. Deliberately debounced rather than per-keystroke: every save is an
  // optimistic-concurrency round trip, and a conflict must be rare enough to be meaningful.
  const scheduleSave = useCallback((next: ThemeConfig) => {
    if (!canManage) return;
    setSaveState("dirty");
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      setSaveState("saving");
      saveMutation.mutate(next);
    }, AUTOSAVE_DELAY_MS);
  }, [canManage, saveMutation]);

  useEffect(() => () => {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
  }, []);

  const update = useCallback((next: ThemeConfig) => {
    setConfig(next);
    scheduleSave(next);
  }, [scheduleSave]);

  if (draftQuery.isLoading || publishedQuery.isLoading) return <SectionLoading />;
  if (draftQuery.isError) {
    return <SectionError message={errorText(draftQuery.error)} onRetry={() => void draftQuery.refetch()} />;
  }

  const versions = versionsQuery.data?.items ?? [];
  const publications = versionsQuery.data?.publications ?? [];
  const hasChanges = draftDiffersFromPublished(expectedHash, published?.hash ?? null);
  const publishAllowed = canManage && hasChanges && canPublish(report ?? draft?.validation_result ?? null);
  const newSectionUnavailable = Boolean(
    config && SINGLETON_SECTION_TYPES.has(newSectionType)
    && config.sections.some((section) => section.type === newSectionType)
  );

  function setColor(key: ThemeColorKey, value: string) {
    if (!config) return;
    const hex = normalizeHex(value);
    if (!hex) return;
    update(withTokens(config, {
      ...config.tokens,
      colors: { ...config.tokens.colors, [key]: hex },
    }));
  }

  function setFont(slot: "heading" | "body", value: ThemeFontStack) {
    if (!config) return;
    update(withTokens(config, { ...config.tokens, fonts: { ...config.tokens.fonts, [slot]: value } }));
  }

  function setNumeric(field: "spacing" | "radius", value: number) {
    if (!config) return;
    update(withTokens(config, { ...config.tokens, [field]: clampToBounds(value, NUMERIC_BOUNDS[field]) }));
  }

  function setContainer(field: "maxWidth" | "paddingX", value: number) {
    if (!config) return;
    update(withTokens(config, {
      ...config.tokens,
      container: { ...config.tokens.container, [field]: clampToBounds(value, NUMERIC_BOUNDS[field]) },
    }));
  }

  function replaceSection(index: number, section: ThemeSection) {
    if (!config) return;
    update(withSections(config, config.sections.map((item, position) => (position === index ? section : item))));
  }

  function move(index: number, direction: -1 | 1) {
    if (!config) return;
    update(withSections(config, moveSection(config.sections, index, direction)));
  }

  function toggle(index: number) {
    if (!config) return;
    update(withSections(config, toggleSection(config.sections, index)));
  }

  function addSection() {
    if (!config || config.sections.length >= 20 || newSectionUnavailable) return;
    update(withSections(config, [...config.sections, createSection(newSectionType, config.sections.length)]));
  }

  function removeSection(index: number) {
    if (!config) return;
    update(withSections(config, config.sections
      .filter((_, position) => position !== index)
      .map((section, order) => ({ ...section, order }))));
  }

  function resetToDefaults() {
    // "Reset" restores what is LIVE, never a hardcoded palette in this component: the
    // published config is the only defaults the tenant has actually approved.
    if (!published) return;
    update(published.config);
    setNotice("Taslak, yayındaki temaya döndürüldü. Yayınlanana kadar mağaza değişmez.");
  }

  return (
    <div className="grid gap-6">
      {error ? <InlineError message={error} /> : null}
      {notice ? <InlineHint>{notice}</InlineHint> : null}

      <Panel
        title="Tema sürümü"
        description="Mağazanın görünümü sürümlenir: taslakta çalışır, doğrular, yayınlar ve gerektiğinde geri alırsınız."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={saveState === "conflict" || saveState === "error" ? "coral" : "mint"}>
              {saveStateLabel(saveState)}
            </StatusPill>
            {!draft && canManage ? (
              <Button
                disabled={createDraftMutation.isPending}
                onClick={() => createDraftMutation.mutate()}
              >
                Taslak oluştur
              </Button>
            ) : null}
          </div>
        }
      >
        <dl className="grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase text-zinc-600">Yayında</dt>
            <dd className="text-sm text-zinc-800">
              {published ? `v${published.versionNumber}` : "Yayınlanmış tema yok"}
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-600">Taslak</dt>
            <dd className="text-sm text-zinc-800">{draft ? `v${draft.version_number}` : "Taslak yok"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase text-zinc-600">Yayınlanmamış değişiklik</dt>
            <dd className="text-sm text-zinc-800">{hasChanges ? "Var" : "Yok"}</dd>
          </div>
        </dl>

        {saveState === "conflict" ? (
          <div className="mt-4 rounded-lg border border-line bg-amber-50 p-4 text-sm text-zinc-800">
            <p className="font-semibold">Taslak başka bir yerde değişti.</p>
            <p className="mt-1">
              Otomatik kaydetme durduruldu; hiçbir değişiklik üzerine yazılmadı. Güncel taslağı
              yükleyip düzenlemenizi tekrar uygulayın.
            </p>
            <Button
              className="mt-3"
              onClick={async () => {
                adoptHash(null);
                setSaveState("idle");
                setError("");
                await draftQuery.refetch();
              }}
            >
              Güncel taslağı yükle
            </Button>
          </div>
        ) : null}
      </Panel>

      {config ? (
        <>
          <Panel title="Renkler ve tipografi" description="Yalnızca doğrulanmış tema değerleri; özel CSS veya HTML yoktur.">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {COLOR_FIELDS.map((field) => (
                <div key={field.key}>
                  <FieldLabel htmlFor={`theme-color-${field.key}`}>{field.label}</FieldLabel>
                  <div className="flex items-center gap-2">
                    <input
                      aria-label={`${field.label} rengi`}
                      className="h-9 w-12 cursor-pointer rounded border border-line bg-white"
                      disabled={!canManage}
                      id={`theme-color-${field.key}`}
                      onChange={(event) => setColor(field.key, event.target.value)}
                      type="color"
                      value={config.tokens.colors[field.key]}
                    />
                    <input
                      aria-label={`${field.label} rengi (hex)`}
                      className={inputClass}
                      disabled={!canManage}
                      onChange={(event) => setColor(field.key, event.target.value)}
                      value={config.tokens.colors[field.key]}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <FieldLabel htmlFor="theme-font-heading">Başlık yazı tipi</FieldLabel>
                <select
                  className={inputClass}
                  disabled={!canManage}
                  id="theme-font-heading"
                  onChange={(event) => setFont("heading", event.target.value as ThemeFontStack)}
                  value={config.tokens.fonts.heading}
                >
                  {FONT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <FieldLabel htmlFor="theme-font-body">Gövde yazı tipi</FieldLabel>
                <select
                  className={inputClass}
                  disabled={!canManage}
                  id="theme-font-body"
                  onChange={(event) => setFont("body", event.target.value as ThemeFontStack)}
                  value={config.tokens.fonts.body}
                >
                  {FONT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <FieldLabel htmlFor="theme-spacing">Boşluk (px)</FieldLabel>
                <input
                  className={inputClass}
                  disabled={!canManage}
                  id="theme-spacing"
                  max={NUMERIC_BOUNDS.spacing.max}
                  min={NUMERIC_BOUNDS.spacing.min}
                  onChange={(event) => setNumeric("spacing", Number(event.target.value))}
                  type="number"
                  value={config.tokens.spacing}
                />
              </div>
              <div>
                <FieldLabel htmlFor="theme-radius">Köşe yarıçapı (px)</FieldLabel>
                <input
                  className={inputClass}
                  disabled={!canManage}
                  id="theme-radius"
                  max={NUMERIC_BOUNDS.radius.max}
                  min={NUMERIC_BOUNDS.radius.min}
                  onChange={(event) => setNumeric("radius", Number(event.target.value))}
                  type="number"
                  value={config.tokens.radius}
                />
              </div>
              <div>
                <FieldLabel htmlFor="theme-container-width">İçerik genişliği (px)</FieldLabel>
                <input
                  className={inputClass}
                  disabled={!canManage}
                  id="theme-container-width"
                  max={NUMERIC_BOUNDS.maxWidth.max}
                  min={NUMERIC_BOUNDS.maxWidth.min}
                  onChange={(event) => setContainer("maxWidth", Number(event.target.value))}
                  type="number"
                  value={config.tokens.container.maxWidth}
                />
              </div>
              <div>
                <FieldLabel htmlFor="theme-container-padding">Yan boşluk (px)</FieldLabel>
                <input
                  className={inputClass}
                  disabled={!canManage}
                  id="theme-container-padding"
                  max={NUMERIC_BOUNDS.paddingX.max}
                  min={NUMERIC_BOUNDS.paddingX.min}
                  onChange={(event) => setContainer("paddingX", Number(event.target.value))}
                  type="number"
                  value={config.tokens.container.paddingX}
                />
              </div>
            </div>
          </Panel>

          <Panel
            title="Bölümler"
            description="Gerçek katalog verisiyle çalışan ana sayfa bloklarını ekleyin, sıralayın ve yayınlayın."
          >
            <div className="mb-4 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-zinc-50 p-3">
              <div className="min-w-64 flex-1">
                <FieldLabel htmlFor="theme-new-section">Yeni bölüm tipi</FieldLabel>
                <select
                  className={inputClass}
                  disabled={!canManage || config.sections.length >= 20}
                  id="theme-new-section"
                  onChange={(event) => setNewSectionType(event.target.value as ThemeSectionType)}
                  value={newSectionType}
                >
                  {SECTION_OPTIONS.map((option) => (
                    <option
                      disabled={SINGLETON_SECTION_TYPES.has(option.value)
                        && config.sections.some((section) => section.type === option.value)}
                      key={option.value}
                      value={option.value}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <Button disabled={!canManage || config.sections.length >= 20 || newSectionUnavailable} onClick={addSection}>
                Bölüm ekle
              </Button>
            </div>
            <ul className="grid gap-3">
              {config.sections.map((section, index) => (
                <li className="rounded-lg border border-line p-4" key={section.id}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-zinc-800">{sectionLabel(section.type)}</p>
                      <p className="text-xs text-zinc-600">{sectionSummary(section)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        aria-label={`${sectionLabel(section.type)} bölümünü yukarı taşı`}
                        disabled={!canManage || index === 0}
                        onClick={() => move(index, -1)}
                        variant="outline"
                      >
                        Yukarı
                      </Button>
                      <Button
                        aria-label={`${sectionLabel(section.type)} bölümünü aşağı taşı`}
                        disabled={!canManage || index === config.sections.length - 1}
                        onClick={() => move(index, 1)}
                        variant="outline"
                      >
                        Aşağı
                      </Button>
                      <label className="flex items-center gap-2 text-sm text-zinc-700">
                        <input
                          aria-label={`${sectionLabel(section.type)} bölümünü göster`}
                          checked={section.enabled}
                          disabled={!canManage}
                          onChange={() => toggle(index)}
                          type="checkbox"
                        />
                        Görünür
                      </label>
                      <Button
                        aria-label={`${sectionLabel(section.type)} bölümünü sil`}
                        disabled={!canManage}
                        onClick={() => removeSection(index)}
                        variant="outline"
                      >
                        Sil
                      </Button>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {section.type === "hero" ? (
                      <>
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-eyebrow`}>Eyebrow</FieldLabel>
                          <input
                            className={inputClass}
                            disabled={!canManage}
                            id={`section-${section.id}-eyebrow`}
                            maxLength={60}
                            onChange={(event) => replaceSection(index, {
                              ...section, settings: { ...section.settings, eyebrow: event.target.value },
                            })}
                            value={section.settings.eyebrow}
                          />
                        </div>
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-title`}>Ana Başlık</FieldLabel>
                          <input
                            className={inputClass}
                            disabled={!canManage}
                            id={`section-${section.id}-title`}
                            maxLength={120}
                            onChange={(event) => replaceSection(index, {
                              ...section, settings: { ...section.settings, title: event.target.value },
                            })}
                            value={section.settings.title}
                          />
                        </div>
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-accent`}>Vurgulu İkinci Satır</FieldLabel>
                          <input
                            className={inputClass}
                            disabled={!canManage}
                            id={`section-${section.id}-accent`}
                            maxLength={120}
                            onChange={(event) => replaceSection(index, {
                              ...section, settings: { ...section.settings, accentText: event.target.value },
                            })}
                            value={section.settings.accentText}
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <FieldLabel htmlFor={`section-${section.id}-subtitle`}>Açıklama</FieldLabel>
                          <input
                            className={inputClass}
                            disabled={!canManage}
                            id={`section-${section.id}-subtitle`}
                            maxLength={240}
                            onChange={(event) => replaceSection(index, {
                              ...section, settings: { ...section.settings, subtitle: event.target.value },
                            })}
                            value={section.settings.subtitle}
                          />
                        </div>
                        <MediaAssetSelect
                          assets={mediaQuery.data ?? []}
                          disabled={!canManage}
                          id={`section-${section.id}-hero-media`}
                          label="Desktop Hero Görseli"
                          loading={mediaQuery.isLoading}
                          organizationSlug={organizationSlug}
                          onChange={(mediaId) => replaceSection(index, {
                            ...section, settings: { ...section.settings, mediaId },
                          })}
                          value={section.settings.mediaId}
                        />
                        <MediaAssetSelect
                          assets={mediaQuery.data ?? []}
                          disabled={!canManage}
                          id={`section-${section.id}-hero-mobile-media`}
                          label="Mobile Hero Görseli"
                          loading={mediaQuery.isLoading}
                          organizationSlug={organizationSlug}
                          onChange={(mobileMediaId) => replaceSection(index, {
                            ...section, settings: { ...section.settings, mobileMediaId },
                          })}
                          value={section.settings.mobileMediaId}
                        />
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-hero-cta`}>Primary CTA Metni</FieldLabel>
                          <input
                            className={inputClass}
                            disabled={!canManage}
                            id={`section-${section.id}-hero-cta`}
                            maxLength={40}
                            onChange={(event) => replaceSection(index, {
                              ...section, settings: { ...section.settings, ctaLabel: event.target.value },
                            })}
                            value={section.settings.ctaLabel}
                          />
                        </div>
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-hero-target`}>Primary CTA Hedefi</FieldLabel>
                          <select className={inputClass} disabled={!canManage} id={`section-${section.id}-hero-target`}
                            value={sourceValue(section.settings.ctaTarget)}
                            onChange={(event) => replaceSection(index, { ...section, settings: { ...section.settings, ctaTarget: sourceFromValue(event.target.value) } })}>
                            <option value="none">Bağlantı yok</option>
                            <option value="products">Tüm ürünler</option>
                            {(categoriesQuery.data ?? []).map((category) => <option key={`category-${category.id}`} value={`category:${category.id}`}>Kategori: {category.name}</option>)}
                            {(collectionsQuery.data ?? []).map((collection) => <option key={`collection-${collection.id}`} value={`collection:${collection.id}`}>Koleksiyon: {collection.title}</option>)}
                          </select>
                        </div>
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-hero-secondary-cta`}>Secondary CTA Metni</FieldLabel>
                          <input
                            className={inputClass}
                            disabled={!canManage}
                            id={`section-${section.id}-hero-secondary-cta`}
                            maxLength={40}
                            onChange={(event) => replaceSection(index, {
                              ...section, settings: { ...section.settings, secondaryCtaLabel: event.target.value },
                            })}
                            value={section.settings.secondaryCtaLabel}
                          />
                        </div>
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-hero-secondary-target`}>Secondary CTA Hedefi</FieldLabel>
                          <select className={inputClass} disabled={!canManage} id={`section-${section.id}-hero-secondary-target`}
                            value={sourceValue(section.settings.secondaryCtaTarget)}
                            onChange={(event) => replaceSection(index, { ...section, settings: { ...section.settings, secondaryCtaTarget: sourceFromValue(event.target.value) } })}>
                            <option value="none">Bağlantı yok</option>
                            <option value="products">Tüm ürünler</option>
                            {(categoriesQuery.data ?? []).map((category) => <option key={`secondary-category-${category.id}`} value={`category:${category.id}`}>Kategori: {category.name}</option>)}
                            {(collectionsQuery.data ?? []).map((collection) => <option key={`secondary-collection-${collection.id}`} value={`collection:${collection.id}`}>Koleksiyon: {collection.title}</option>)}
                          </select>
                        </div>
                      </>
                    ) : null}

                    {section.type === "product-grid" ? (
                      <>
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-limit`}>Ürün sayısı</FieldLabel>
                          <input
                            className={inputClass}
                            disabled={!canManage}
                            id={`section-${section.id}-limit`}
                            max={NUMERIC_BOUNDS.limit.max}
                            min={NUMERIC_BOUNDS.limit.min}
                            onChange={(event) => replaceSection(index, {
                              ...section,
                              settings: {
                                ...section.settings,
                                limit: clampToBounds(Number(event.target.value), NUMERIC_BOUNDS.limit),
                              },
                            })}
                            type="number"
                            value={section.settings.limit}
                          />
                        </div>
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-columns`}>Sütun sayısı</FieldLabel>
                          <input
                            className={inputClass}
                            disabled={!canManage}
                            id={`section-${section.id}-columns`}
                            max={NUMERIC_BOUNDS.columns.max}
                            min={NUMERIC_BOUNDS.columns.min}
                            onChange={(event) => replaceSection(index, {
                              ...section,
                              settings: {
                                ...section.settings,
                                columns: clampToBounds(Number(event.target.value), NUMERIC_BOUNDS.columns),
                              },
                            })}
                            type="number"
                            value={section.settings.columns}
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <FieldLabel htmlFor={`section-${section.id}-source`}>Ürün kaynağı</FieldLabel>
                          <select
                            className={inputClass}
                            disabled={!canManage}
                            id={`section-${section.id}-source`}
                            onChange={(event) => replaceSection(index, {
                              ...section, settings: { ...section.settings, source: sourceFromValue(event.target.value) },
                            })}
                            value={sourceValue(section.settings.source)}
                          >
                            <option value="products">Tüm aktif ürünler</option>
                            {(categoriesQuery.data ?? []).map((category) => (
                              <option key={`category-${category.id}`} value={`category:${category.id}`}>Kategori: {category.name}</option>
                            ))}
                            {(collectionsQuery.data ?? []).map((collection) => (
                              <option key={`collection-${collection.id}`} value={`collection:${collection.id}`}>Koleksiyon: {collection.title}</option>
                            ))}
                          </select>
                        </div>
                      </>
                    ) : null}

                    {section.type === "product-carousel" ? (
                      <>
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-title`}>Başlık</FieldLabel>
                          <input className={inputClass} disabled={!canManage} id={`section-${section.id}-title`}
                            maxLength={120} value={section.settings.title}
                            onChange={(event) => replaceSection(index, { ...section, settings: { ...section.settings, title: event.target.value } })} />
                        </div>
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-limit`}>Ürün sayısı</FieldLabel>
                          <input className={inputClass} disabled={!canManage} id={`section-${section.id}-limit`}
                            min={2} max={16} type="number" value={section.settings.limit}
                            onChange={(event) => replaceSection(index, { ...section, settings: { ...section.settings, limit: Math.min(16, Math.max(2, Number(event.target.value) || 2)) } })} />
                        </div>
                        <div className="sm:col-span-2">
                          <FieldLabel htmlFor={`section-${section.id}-description`}>Açıklama</FieldLabel>
                          <input className={inputClass} disabled={!canManage} id={`section-${section.id}-description`}
                            maxLength={240} value={section.settings.description}
                            onChange={(event) => replaceSection(index, { ...section, settings: { ...section.settings, description: event.target.value } })} />
                        </div>
                        <div className="sm:col-span-2">
                          <FieldLabel htmlFor={`section-${section.id}-source`}>Ürün kaynağı</FieldLabel>
                          <select className={inputClass} disabled={!canManage} id={`section-${section.id}-source`}
                            value={sourceValue(section.settings.source)}
                            onChange={(event) => replaceSection(index, { ...section, settings: { ...section.settings, source: sourceFromValue(event.target.value) } })}>
                            <option value="products">Tüm aktif ürünler</option>
                            {(categoriesQuery.data ?? []).map((category) => <option key={`category-${category.id}`} value={`category:${category.id}`}>Kategori: {category.name}</option>)}
                            {(collectionsQuery.data ?? []).map((collection) => <option key={`collection-${collection.id}`} value={`collection:${collection.id}`}>Koleksiyon: {collection.title}</option>)}
                          </select>
                        </div>
                      </>
                    ) : null}

                    {section.type === "trust-features" ? (
                      <div className="sm:col-span-2 grid gap-2">
                        {section.settings.items.map((item, itemIndex) => (
                          <div className="grid gap-2 sm:grid-cols-3" key={`${section.id}-item-${itemIndex}`}>
                            <select
                              aria-label={`${itemIndex + 1}. madde simgesi`}
                              className={inputClass}
                              disabled={!canManage}
                              onChange={(event) => replaceSection(index, {
                                ...section,
                                settings: {
                                  ...section.settings,
                                  items: section.settings.items.map((entry, position) => (position === itemIndex
                                    ? { ...entry, icon: event.target.value as ThemeTrustIcon }
                                    : entry)),
                                },
                              })}
                              value={item.icon}
                            >
                              {TRUST_ICON_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                            <input
                              aria-label={`${itemIndex + 1}. madde başlığı`}
                              className={inputClass}
                              disabled={!canManage}
                              maxLength={60}
                              onChange={(event) => replaceSection(index, {
                                ...section,
                                settings: {
                                  ...section.settings,
                                  items: section.settings.items.map((entry, position) => (position === itemIndex
                                    ? { ...entry, title: event.target.value }
                                    : entry)),
                                },
                              })}
                              value={item.title}
                            />
                            <input
                              aria-label={`${itemIndex + 1}. madde açıklaması`}
                              className={inputClass}
                              disabled={!canManage}
                              maxLength={160}
                              onChange={(event) => replaceSection(index, {
                                ...section,
                                settings: {
                                  ...section.settings,
                                  items: section.settings.items.map((entry, position) => (position === itemIndex
                                    ? { ...entry, text: event.target.value }
                                    : entry)),
                                },
                              })}
                              value={item.text}
                            />
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {section.type === "newsletter" ? (
                      <>
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-title`}>Başlık</FieldLabel>
                          <input
                            className={inputClass}
                            disabled={!canManage}
                            id={`section-${section.id}-title`}
                            maxLength={120}
                            onChange={(event) => replaceSection(index, {
                              ...section, settings: { ...section.settings, title: event.target.value },
                            })}
                            value={section.settings.title}
                          />
                        </div>
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-button`}>Buton yazısı</FieldLabel>
                          <input
                            className={inputClass}
                            disabled={!canManage}
                            id={`section-${section.id}-button`}
                            maxLength={40}
                            onChange={(event) => replaceSection(index, {
                              ...section, settings: { ...section.settings, buttonLabel: event.target.value },
                            })}
                            value={section.settings.buttonLabel}
                          />
                        </div>
                      </>
                    ) : null}

                    {section.type === "collection-blocks" ? (
                      <div>
                        <FieldLabel htmlFor={`section-${section.id}-title`}>Başlık</FieldLabel>
                        <input
                          className={inputClass}
                          disabled={!canManage}
                          id={`section-${section.id}-title`}
                          maxLength={120}
                          onChange={(event) => replaceSection(index, {
                            ...section, settings: { ...section.settings, title: event.target.value },
                          })}
                          value={section.settings.title}
                        />
                      </div>
                    ) : null}

                    {section.type === "category-slider" ? (
                      <>
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-title`}>Başlık</FieldLabel>
                          <input className={inputClass} disabled={!canManage} id={`section-${section.id}-title`}
                            maxLength={120} value={section.settings.title}
                            onChange={(event) => replaceSection(index, { ...section, settings: { ...section.settings, title: event.target.value } })} />
                        </div>
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-limit`}>Gösterim limiti</FieldLabel>
                          <input className={inputClass} disabled={!canManage} id={`section-${section.id}-limit`}
                            min={2} max={12} type="number" value={section.settings.limit}
                            onChange={(event) => replaceSection(index, { ...section, settings: { ...section.settings, limit: Math.min(12, Math.max(2, Number(event.target.value) || 2)) } })} />
                        </div>
                        <div className="sm:col-span-2">
                          <FieldLabel htmlFor={`section-${section.id}-description`}>Açıklama</FieldLabel>
                          <input className={inputClass} disabled={!canManage} id={`section-${section.id}-description`}
                            maxLength={240} value={section.settings.description}
                            onChange={(event) => replaceSection(index, { ...section, settings: { ...section.settings, description: event.target.value } })} />
                        </div>
                        <div className="sm:col-span-2">
                          <p className="text-sm font-medium text-zinc-700">Kategoriler (seçilmezse aktif kategoriler sırasıyla gelir)</p>
                          <div className="mt-1 grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-2">
                            {(categoriesQuery.data ?? []).map((category) => {
                              const id = Number(category.id);
                              const checked = section.settings.categoryIds.includes(id);
                              return <label className="flex items-center gap-2 text-sm" key={category.id}>
                                <input type="checkbox" checked={checked} disabled={!canManage}
                                  onChange={() => replaceSection(index, { ...section, settings: { ...section.settings,
                                    categoryIds: checked ? section.settings.categoryIds.filter((value) => value !== id) : [...section.settings.categoryIds, id],
                                  } })} />
                                {category.name}
                              </label>;
                            })}
                          </div>
                        </div>
                      </>
                    ) : null}

                    {section.type === "collection-showcase" ? (
                      <>
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-title`}>Başlık</FieldLabel>
                          <input className={inputClass} disabled={!canManage} id={`section-${section.id}-title`}
                            maxLength={120} value={section.settings.title}
                            onChange={(event) => replaceSection(index, { ...section, settings: { ...section.settings, title: event.target.value } })} />
                        </div>
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-limit`}>Gösterim limiti</FieldLabel>
                          <input className={inputClass} disabled={!canManage} id={`section-${section.id}-limit`}
                            min={1} max={8} type="number" value={section.settings.limit}
                            onChange={(event) => replaceSection(index, { ...section, settings: { ...section.settings, limit: Math.min(8, Math.max(1, Number(event.target.value) || 1)) } })} />
                        </div>
                        <div className="sm:col-span-2">
                          <FieldLabel htmlFor={`section-${section.id}-description`}>Açıklama</FieldLabel>
                          <input className={inputClass} disabled={!canManage} id={`section-${section.id}-description`}
                            maxLength={240} value={section.settings.description}
                            onChange={(event) => replaceSection(index, { ...section, settings: { ...section.settings, description: event.target.value } })} />
                        </div>
                        <div className="sm:col-span-2">
                          <p className="text-sm font-medium text-zinc-700">Koleksiyonlar (seçilmezse aktif koleksiyonlar sırasıyla gelir)</p>
                          <div className="mt-1 grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-2">
                            {(collectionsQuery.data ?? []).map((collection) => {
                              const id = Number(collection.id);
                              const checked = section.settings.collectionIds.includes(id);
                              return <label className="flex items-center gap-2 text-sm" key={collection.id}>
                                <input type="checkbox" checked={checked} disabled={!canManage}
                                  onChange={() => replaceSection(index, { ...section, settings: { ...section.settings,
                                    collectionIds: checked ? section.settings.collectionIds.filter((value) => value !== id) : [...section.settings.collectionIds, id],
                                  } })} />
                                {collection.title}
                              </label>;
                            })}
                          </div>
                        </div>
                      </>
                    ) : null}

                    {section.type === "editorial" || section.type === "promo-banner" ? (
                      <>
                        {section.type === "editorial" ? <div>
                          <FieldLabel htmlFor={`section-${section.id}-eyebrow`}>Üst etiket</FieldLabel>
                          <input className={inputClass} disabled={!canManage} id={`section-${section.id}-eyebrow`}
                            maxLength={60} value={section.settings.eyebrow}
                            onChange={(event) => replaceSection(index, { ...section, settings: { ...section.settings, eyebrow: event.target.value } })} />
                        </div> : null}
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-title`}>Başlık</FieldLabel>
                          <input className={inputClass} disabled={!canManage} id={`section-${section.id}-title`}
                            maxLength={120} value={section.settings.title}
                            onChange={(event) => replaceSection(index, { ...section, settings: { ...section.settings, title: event.target.value } } as ThemeSection)} />
                        </div>
                        <div className="sm:col-span-2">
                          <FieldLabel htmlFor={`section-${section.id}-description`}>Açıklama</FieldLabel>
                          <input className={inputClass} disabled={!canManage} id={`section-${section.id}-description`}
                            maxLength={240} value={section.settings.description}
                            onChange={(event) => replaceSection(index, { ...section, settings: { ...section.settings, description: event.target.value } } as ThemeSection)} />
                        </div>
                        <MediaAssetSelect
                          assets={mediaQuery.data ?? []}
                          disabled={!canManage}
                          id={`section-${section.id}-media`}
                          label="Bölüm görseli"
                          loading={mediaQuery.isLoading}
                          organizationSlug={organizationSlug}
                          onChange={(mediaId) => replaceSection(index, {
                            ...section, settings: { ...section.settings, mediaId },
                          } as ThemeSection)}
                          value={section.settings.mediaId}
                        />
                        <div>
                          <FieldLabel htmlFor={`section-${section.id}-cta`}>CTA metni</FieldLabel>
                          <input className={inputClass} disabled={!canManage} id={`section-${section.id}-cta`}
                            maxLength={40} value={section.settings.ctaLabel}
                            onChange={(event) => replaceSection(index, { ...section, settings: { ...section.settings, ctaLabel: event.target.value } } as ThemeSection)} />
                        </div>
                        <div className="sm:col-span-2">
                          <FieldLabel htmlFor={`section-${section.id}-target`}>CTA hedefi</FieldLabel>
                          <select className={inputClass} disabled={!canManage} id={`section-${section.id}-target`}
                            value={sourceValue(section.settings.ctaTarget)}
                            onChange={(event) => replaceSection(index, { ...section, settings: { ...section.settings, ctaTarget: sourceFromValue(event.target.value) } } as ThemeSection)}>
                            <option value="products">Tüm ürünler</option>
                            {(categoriesQuery.data ?? []).map((category) => <option key={`category-${category.id}`} value={`category:${category.id}`}>Kategori: {category.name}</option>)}
                            {(collectionsQuery.data ?? []).map((collection) => <option key={`collection-${collection.id}`} value={`collection:${collection.id}`}>Koleksiyon: {collection.title}</option>)}
                          </select>
                        </div>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel
            title="Doğrula ve yayınla"
            description="Yayınlamak taslağı yeni bir sürüm olarak canlıya alır; önceki sürüm arşivlenir ve geri alınabilir."
          >
            <div className="flex flex-wrap items-center gap-2">
              <Button
                disabled={validateMutation.isPending}
                onClick={() => validateMutation.mutate()}
                variant="outline"
              >
                Doğrula
              </Button>
              <Button
                disabled={!canManage || !published}
                onClick={resetToDefaults}
                variant="outline"
              >
                Yayındakine dön
              </Button>
              <Button
                disabled={!canManage || !storefrontOrigin || previewMutation.isPending || !draft}
                onClick={() => previewMutation.mutate()}
                variant="outline"
              >
                Önizle
              </Button>
            </div>

            {report ? (
              <div className="mt-4 grid gap-2">
                {report.errors.map((issue) => (
                  <p className="text-sm text-red-700" key={`e-${issue.field}-${issue.code}`}>
                    <strong>{issue.field}:</strong> {issue.message}
                  </p>
                ))}
                {report.warnings.map((issue) => (
                  <p className="text-sm text-amber-700" key={`w-${issue.field}-${issue.code}`}>
                    <strong>{issue.field}:</strong> {issue.message}
                  </p>
                ))}
                {report.errors.length === 0 && report.warnings.length === 0 ? (
                  <EmptyText>Uyarı yok.</EmptyText>
                ) : null}
              </div>
            ) : null}

            <div className="mt-4 grid gap-2 sm:max-w-md">
              <FieldLabel htmlFor="theme-publish-reason">Yayın notu (isteğe bağlı)</FieldLabel>
              <input
                className={inputClass}
                disabled={!canManage}
                id="theme-publish-reason"
                maxLength={200}
                onChange={(event) => setPublishReason(event.target.value)}
                value={publishReason}
              />
              <Button
                disabled={!publishAllowed || publishMutation.isPending}
                onClick={() => publishMutation.mutate()}
              >
                Yayınla
              </Button>
              {!hasChanges ? <InlineHint>Yayınlanacak değişiklik yok.</InlineHint> : null}
            </div>
          </Panel>

          {previewSrc ? (
            <Panel
              title="Önizleme"
              description="Önizleme yalnızca taslağı gösterir; mağazayı ziyaret edenler yayındaki temayı görür."
              actions={
                <div className="flex items-center gap-2">
                  <Button onClick={() => setPreviewWidth("desktop")} variant={previewWidth === "desktop" ? "mint" : "outline"}>
                    Masaüstü
                  </Button>
                  <Button onClick={() => setPreviewWidth("mobile")} variant={previewWidth === "mobile" ? "mint" : "outline"}>
                    Mobil
                  </Button>
                  <Button onClick={() => setPreviewSrc("")} variant="outline">Kapat</Button>
                </div>
              }
            >
              <div className="overflow-x-auto">
                <iframe
                  className="h-[720px] rounded-lg border border-line bg-white"
                  // The frame is sized here, in the admin, rather than by asking the
                  // storefront to render differently: the preview must be the same renderer
                  // the public site uses, not a second, divergent template.
                  style={{ width: previewWidth === "mobile" ? 390 : "100%" }}
                  src={previewSrc}
                  title="Tema önizlemesi"
                />
              </div>
            </Panel>
          ) : null}
        </>
      ) : (
        <Panel title="Tema düzenleyici" description="Düzenlemeye başlamak için yayındaki temadan bir taslak oluşturun.">
          <EmptyText>Henüz taslak yok.</EmptyText>
        </Panel>
      )}

      <Panel title="Sürüm geçmişi" description="Her yayın kaydedilir. Geri alma, seçilen sürümü yeni bir sürüm olarak yayınlar.">
        <DataGrid
          caption="Sürüm geçmişi"
          columns={["Sürüm", "Durum", "Güncellendi", "İşlem"]}
          emptyMessage="Henüz sürüm yok."
          renderRow={(version: ThemeVersion) => (
            <tr key={version.id}>
              <DataCell>{versionLabel(version)}</DataCell>
              <DataCell>
                <StatusPill tone={version.status === "published" ? "mint" : "leaf"}>
                  {version.status}
                </StatusPill>
              </DataCell>
              <DataCell>{formatDateTime(version.updated_at)}</DataCell>
              <DataCell>
                {version.status === "archived" && canManage ? (
                  <Button onClick={() => setRollbackTarget(version.id)} variant="outline">
                    Geri al
                  </Button>
                ) : (
                  <span className="text-xs text-zinc-600">—</span>
                )}
              </DataCell>
            </tr>
          )}
          rows={versions}
        />

        {rollbackTarget != null ? (
          <div className="mt-4 rounded-lg border border-line p-4">
            <FieldLabel htmlFor="theme-rollback-reason">Geri alma gerekçesi (zorunlu)</FieldLabel>
            <input
              className={inputClass}
              id="theme-rollback-reason"
              maxLength={200}
              onChange={(event) => setRollbackReason(event.target.value)}
              value={rollbackReason}
            />
            <div className="mt-3 flex items-center gap-2">
              <Button
                disabled={rollbackReason.trim().length < 4 || rollbackMutation.isPending}
                onClick={() => rollbackMutation.mutate(rollbackTarget)}
              >
                Bu sürümü yayınla
              </Button>
              <Button onClick={() => { setRollbackTarget(null); setRollbackReason(""); }} variant="outline">
                Vazgeç
              </Button>
            </div>
          </div>
        ) : null}

        {publications.length ? (
          <ul className="mt-4 grid gap-1 text-xs text-zinc-600">
            {publications.map((publication) => (
              <li key={publication.id}>
                {formatDateTime(publication.published_at)}
                {publication.action === "rollback" ? " · geri alma" : " · yayın"}
                {publication.reason ? ` · ${publication.reason}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>
    </div>
  );
}
