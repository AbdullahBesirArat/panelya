"use client";

import Image from "next/image";
import { useState } from "react";
import { authenticatedRequest } from "@/lib/api/core";
import { fetchMediaAssetsByChecksums, resolveApiAssetUrl, uploadMediaAsset } from "@/lib/api/media";

type Spin = { frameCount: number; poster: string; frames: string[] };

export function ProductSpinEditor({ productId, initial, disabled, onSaved }: {
  productId: string; initial: unknown; disabled: boolean; onSaved: () => void;
}) {
  const [spin, setSpin] = useState<Spin | null>(() => initial && typeof initial === "object"
    && "frames" in initial && Array.isArray(initial.frames) ? initial as Spin : null);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function inspectFiles() {
    if (files.length < 2 || files.length > 72) throw new Error("2–72 sıralı WebP kare seçin.");
    const checksums = await Promise.all(files.map(async file => {
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
      return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("");
    }));
    if (new Set(checksums).size !== files.length) throw new Error("Aynı kare birden fazla seçilemez.");
    const assets = await fetchMediaAssetsByChecksums(checksums);
    if (assets.length >= 200) throw new Error("Medya eşleşmeleri sınırı aştı; yükleme durduruldu.");
    // Fail closed while the API deployment is still catching up with the editor.
    if (assets.some(asset => !asset.checksum || !checksums.includes(asset.checksum))) throw new Error("Medya doğrulaması tamamlanamadı; yükleme durduruldu.");
    return checksums.map(checksum => {
      const matches = assets.filter(asset => asset.checksum === checksum);
      const ready = matches.find(asset => asset.status === "ready" || asset.status === "orphan_candidate");
      if (!ready && matches.length) throw new Error("Bir kare depolamada işleniyor. Daha sonra tekrar kontrol edin.");
      return ready;
    });
  }
  async function inspect() {
    setBusy(true);
    try {
      const existing = await inspectFiles();
      const count = existing.filter(Boolean).length;
      setMessage(`Medya kontrolü: ${count} mevcut, ${files.length - count} eksik. Henüz yükleme yapılmadı.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Medya kontrol edilemedi."); }
    finally { setBusy(false); }
  }
  async function save(remove = false) {
    setBusy(true);
    setMessage("");
    try {
      let next: Spin | null = null;
      if (!remove) {
        if (files.length < 2 || files.length > 72) throw new Error("2–72 sıralı WebP kare seçin.");
        let dimensions = "";
        for (const file of files) {
          if (file.type !== "image/webp") throw new Error("Kareler WebP biçiminde olmalı.");
          const image = await createImageBitmap(file);
          const size = `${image.width}x${image.height}`;
          image.close();
          if (dimensions && dimensions !== size) throw new Error("Tüm karelerin boyutları aynı olmalı.");
          dimensions = size;
        }
        const existing = await inspectFiles();
        const frames: string[] = [];
        for (let index = 0; index < files.length; index++) {
          const file = files[index];
          setMessage(`Yükleniyor: ${frames.length + 1}/${files.length}`);
          frames.push(existing[index]?.url || (await uploadMediaAsset(file)).url);
        }
        next = { frameCount: frames.length, poster: frames[0], frames };
      }
      const unchanged = next === null ? spin === null : spin?.frameCount === next.frameCount
        && spin.poster === next.poster && spin.frames.every((frame, index) => frame === next.frames[index]);
      if (!unchanged) {
        await authenticatedRequest(`/products/${productId}/spin360`, {
          method: "PUT", body: JSON.stringify({ spin360: next }),
        });
      }
      setSpin(next);
      setFiles([]);
      setMessage(remove ? "360° görünüm kaldırıldı." : "360° görünüm kaydedildi.");
      onSaved();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "360° görünüm kaydedilemedi.");
    } finally { setBusy(false); }
  }
  return <section className="space-y-3 rounded-lg border border-line p-4" aria-label="360° Görünüm">
    <h3 className="text-sm font-semibold">360° Görünüm</h3>
    <p className="text-xs text-zinc-600">{spin ? `${spin.frameCount} kare yapılandırıldı` : "Yapılandırılmadı"}</p>
    {spin && <Image src={resolveApiAssetUrl(spin.poster)} alt="360° kapak görseli" width={90} height={120} unoptimized className="rounded object-contain" />}
    <label className="block text-xs">Sıralı WebP kareleri seçin (000, 030, …). İlk kare kapak olur.
      <input className="mt-2 block w-full text-xs" type="file" accept="image/webp,.webp" multiple disabled={disabled || busy}
        onChange={(event) => setFiles(Array.from(event.target.files || []).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true })))} />
    </label>
    {files.length > 0 && <p className="break-words text-xs">{files.map(file => file.name).join(" → ")}</p>}
    <div className="flex gap-3">
      <button type="button" className="focus-ring rounded border border-line px-3 py-2 text-xs" disabled={disabled || busy || files.length < 2} onClick={() => void inspect()}>Medya kütüphanesini kontrol et</button>
      <button type="button" className="focus-ring rounded border border-line px-3 py-2 text-xs" disabled={disabled || busy || files.length < 2} onClick={() => void save()}>
        {spin ? "360° görünümü değiştir" : "360° görünümü kaydet"}
      </button>
      {spin && <button type="button" className="focus-ring rounded border border-line px-3 py-2 text-xs" disabled={disabled || busy} onClick={() => void save(true)}>360° görünümü kaldır</button>}
    </div>
    <p className="text-xs" role="status">{message}</p>
  </section>;
}
