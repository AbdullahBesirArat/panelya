"use client";

import Image from "next/image";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ApiCategory } from "@/lib/api/types";
import { dashboardMediaUrl, type InstagramDraft, type InstagramDraftPatch } from "@/lib/api/instagram-import";

const inputClass = "focus-ring h-10 w-full rounded-lg border border-line bg-white px-3 text-sm";
const areaClass = "focus-ring min-h-24 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm";

export function InstagramDraftEditor({
  draft, categories, busy, onSave, onApply, onSkip, onDiscard, onClose,
}: {
  draft: InstagramDraft; categories: ApiCategory[]; busy: boolean;
  onSave: (patch: InstagramDraftPatch) => void; onApply: (patch: InstagramDraftPatch) => void; onSkip: () => void;
  onDiscard: () => void; onClose: () => void;
}) {
  const [form, setForm] = useState(() => ({
    product_name: draft.product_name || "", price: draft.price || "", sale_price: draft.sale_price || "",
    category_id: draft.category_id || "", colors: (draft.colors || []).join(", "), sizes: (draft.sizes || []).join(", "),
    fabric_info: draft.fabric_info || "", measurements: (draft.measurements || []).join("\n"),
    short_description: draft.short_description || "", description: draft.description || "",
    product_story: draft.product_story || "", tags: (draft.tags || []).join(", "),
    default_stock: String(draft.default_stock ?? 5),
  }));
  const [imageBindings, setImageBindings] = useState<Record<string, string>>(() => Object.fromEntries(
    draft.images.map((image) => [image.id, image.bound_color || ""]),
  ));
  const [draggedImageId, setDraggedImageId] = useState<string | null>(null);
  const list = (value: string) => Array.from(new Set(value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean)));
  const patch: InstagramDraftPatch = {
    product_name: form.product_name, price: form.price || null, sale_price: form.sale_price || null,
    category_id: form.category_id || null, colors: list(form.colors), sizes: list(form.sizes),
    fabric_info: form.fabric_info, measurements: list(form.measurements), short_description: form.short_description,
    description: form.description, product_story: form.product_story, tags: list(form.tags),
    default_stock: Number(form.default_stock) || 0,
    image_bindings: draft.images.map((image) => ({ image_id: image.id, bound_color: imageBindings[image.id] || null })),
  };
  const canApply = Boolean(form.product_name.trim() && Number(form.price) > 0 && ["ready", "needs_review"].includes(draft.status));

  return (
    <div aria-labelledby="instagram-draft-title" aria-modal="true" className="fixed inset-0 z-50 overflow-y-auto bg-ink/45 p-4" role="dialog">
      <div className="mx-auto max-w-5xl rounded-2xl bg-white p-5 shadow-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-ink" id="instagram-draft-title">AI ürün taslağını gözden geçir</h2>
            <p className="mt-1 text-sm text-zinc-600">AI önerilerini doğrulayın. Fiyat doğrulanmadan ürün oluşturulamaz.</p>
          </div>
          <button aria-label="Taslak penceresini kapat" className="focus-ring rounded-lg border border-line px-3 py-1.5" onClick={onClose} type="button">Kapat</button>
        </div>

        {draft.warnings?.length ? (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="status">
            <p className="font-semibold">İnceleme uyarıları</p>
            <ul className="mt-1 list-disc pl-5">{draft.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
          </div>
        ) : null}

        <div className="mt-5 grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
          <div>
            <div className="grid grid-cols-2 gap-2">
              {draft.images.map((image) => (
                <div className="overflow-hidden rounded-xl border border-line bg-zinc-50" draggable onDragEnd={() => setDraggedImageId(null)} onDragStart={() => setDraggedImageId(image.id)} key={image.id}>
                  <Image alt={image.bound_color ? `${image.bound_color} ürün görseli` : "Instagram ürün görseli"} className="aspect-square h-auto w-full object-cover" height={320} src={dashboardMediaUrl(image.card_url)} unoptimized width={320} />
                  <label className="block px-2 py-1 text-xs text-zinc-600">Görsel rengi<select className="mt-1 w-full rounded border border-line bg-white px-1 py-1" onChange={(event) => setImageBindings((value) => ({ ...value, [image.id]: event.target.value }))} value={imageBindings[image.id] || ""}><option value="">Genel görsel</option>{list(form.colors).map((color) => <option key={color} value={color}>{color}</option>)}</select></label>
                </div>
              ))}
            </div>
            {list(form.colors).length ? <div className="mt-3"><p className="text-xs font-semibold text-zinc-600">Bir görseli renk alanına sürükleyerek eşleştirin</p><div className="mt-2 flex flex-wrap gap-2">{list(form.colors).map((color) => <button className="focus-ring rounded-lg border border-dashed border-line bg-zinc-50 px-3 py-2 text-xs font-semibold" key={color} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (draggedImageId) setImageBindings((value) => ({ ...value, [draggedImageId]: color })); setDraggedImageId(null); }} type="button">{color}</button>)}</div></div> : null}
            {draft.permalink ? <a className="mt-3 inline-block text-sm font-semibold text-mint underline" href={draft.permalink} rel="noreferrer" target="_blank">Instagram gönderisini aç</a> : null}
            <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-600">{draft.caption || "Açıklama yok"}</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="sm:col-span-2 text-sm font-medium text-ink">Ürün adı<input className={`${inputClass} mt-1`} onChange={(event) => setForm((value) => ({ ...value, product_name: event.target.value }))} value={form.product_name} /></label>
            <label className="text-sm font-medium text-ink">Fiyat<input className={`${inputClass} mt-1`} min="0.01" onChange={(event) => setForm((value) => ({ ...value, price: event.target.value }))} step="0.01" type="number" value={form.price} /></label>
            <label className="text-sm font-medium text-ink">İndirimli fiyat<input className={`${inputClass} mt-1`} min="0" onChange={(event) => setForm((value) => ({ ...value, sale_price: event.target.value }))} step="0.01" type="number" value={form.sale_price} /></label>
            <label className="text-sm font-medium text-ink">Kategori<select className={`${inputClass} mt-1`} onChange={(event) => setForm((value) => ({ ...value, category_id: event.target.value }))} value={form.category_id}><option value="">Kategori seçilmedi</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
            <label className="text-sm font-medium text-ink">Başlangıç stoğu<input className={`${inputClass} mt-1`} min="0" onChange={(event) => setForm((value) => ({ ...value, default_stock: event.target.value }))} type="number" value={form.default_stock} /></label>
            <label className="text-sm font-medium text-ink">Renkler<input className={`${inputClass} mt-1`} onChange={(event) => setForm((value) => ({ ...value, colors: event.target.value }))} placeholder="Siyah, Ekru" value={form.colors} /></label>
            <label className="text-sm font-medium text-ink">Bedenler<input className={`${inputClass} mt-1`} onChange={(event) => setForm((value) => ({ ...value, sizes: event.target.value }))} placeholder="S, M, L" value={form.sizes} /></label>
            <label className="sm:col-span-2 text-sm font-medium text-ink">Kumaş bilgisi<input className={`${inputClass} mt-1`} onChange={(event) => setForm((value) => ({ ...value, fabric_info: event.target.value }))} value={form.fabric_info} /></label>
            <label className="sm:col-span-2 text-sm font-medium text-ink">Ölçüler<textarea className={`${areaClass} mt-1`} onChange={(event) => setForm((value) => ({ ...value, measurements: event.target.value }))} value={form.measurements} /></label>
            <label className="sm:col-span-2 text-sm font-medium text-ink">Kısa açıklama<textarea className={`${areaClass} mt-1`} onChange={(event) => setForm((value) => ({ ...value, short_description: event.target.value }))} value={form.short_description} /></label>
            <label className="sm:col-span-2 text-sm font-medium text-ink">Açıklama<textarea className={`${areaClass} mt-1`} onChange={(event) => setForm((value) => ({ ...value, description: event.target.value }))} value={form.description} /></label>
            <label className="sm:col-span-2 text-sm font-medium text-ink">Ürün hikâyesi<textarea className={`${areaClass} mt-1`} onChange={(event) => setForm((value) => ({ ...value, product_story: event.target.value }))} value={form.product_story} /></label>
            <label className="sm:col-span-2 text-sm font-medium text-ink">Etiketler<input className={`${inputClass} mt-1`} onChange={(event) => setForm((value) => ({ ...value, tags: event.target.value }))} value={form.tags} /></label>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-line pt-4">
          <Button disabled={busy} onClick={onSkip} type="button" variant="outline">Atla</Button>
          <Button disabled={busy} onClick={onDiscard} type="button" variant="outline">Taslağı sil</Button>
          <Button disabled={busy} onClick={() => onSave(patch)} type="button" variant="outline">Değişiklikleri kaydet</Button>
          <Button disabled={busy || !canApply} onClick={() => onApply(patch)} type="button">Taslak ürün oluştur</Button>
        </div>
      </div>
    </div>
  );
}
