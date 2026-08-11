import Image from "next/image";
import { FieldLabel, InlineError, InlineHint } from "@/components/operations-shared";

export type ProductImageEntry = { color: string; url: string };

export function ImageManager({
  imageColor,
  colors,
  imagesText,
  entries,
  isUploading,
  errorMessage,
  onImageColorChange,
  onImagesTextChange,
  onFiles,
  colorLabel,
  resolveUrl,
}: {
  imageColor: string;
  colors: string[];
  imagesText: string;
  entries: ProductImageEntry[];
  isUploading: boolean;
  errorMessage?: string;
  onImageColorChange: (value: string) => void;
  onImagesTextChange: (value: string) => void;
  onFiles: (files: File[]) => void;
  colorLabel: (value: string) => string;
  resolveUrl: (value: string) => string;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <FieldLabel htmlFor="product-images">Ürün görselleri (kapak ve renk seçilince değişen galeri)</FieldLabel>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <select
            aria-label="Görsel rengi"
            className="focus-ring h-9 rounded-lg border border-line bg-white px-2 text-xs"
            onChange={(event) => onImageColorChange(event.target.value)}
            value={imageColor}
          >
            <option value="">Genel görsel</option>
            {colors.map((color) => <option key={color} value={color}>{colorLabel(color)}</option>)}
          </select>
          <label className="focus-ring inline-flex h-9 cursor-pointer items-center rounded-lg border border-line px-3 text-xs font-semibold text-ink">
            <input
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              multiple
              onChange={(event) => {
                const files = Array.from(event.target.files || []);
                if (files.length) onFiles(files);
                event.currentTarget.value = "";
              }}
              type="file"
            />
            {isUploading ? "Yükleniyor" : "Görsel yükle"}
          </label>
        </div>
      </div>
      <textarea
        className="focus-ring min-h-32 rounded-lg border border-line bg-white px-3 py-3 text-sm"
        id="product-images"
        onChange={(event) => onImagesTextChange(event.target.value)}
        placeholder={"Önce renk seçip görsel yükleyin ya da elle yazın\n#111111 | /api/media/.../detail\n/api/media/.../detail"}
        value={imagesText}
      />
      <InlineHint>Renk seçiliyken yüklenen görsel o renge bağlanır. Düz linkler genel galeri görseli olur.</InlineHint>
      {entries.length ? (
        <div className="grid gap-3 sm:grid-cols-3">
          {entries.slice(0, 9).map((entry, index) => (
            <div className="overflow-hidden rounded-lg border border-line bg-zinc-50" key={`${entry.color}-${entry.url}-${index}`}>
              <Image
                alt={entry.color ? `${colorLabel(entry.color)} ürün görseli` : "Ürün görseli"}
                className="h-28 w-full object-cover"
                height={160}
                sizes="(max-width: 640px) 100vw, 240px"
                src={resolveUrl(entry.url)}
                unoptimized
                width={240}
              />
              <p className="truncate px-3 py-2 text-xs font-semibold text-zinc-600">
                {entry.color ? `${colorLabel(entry.color)} rengi` : "Genel görsel"}
              </p>
            </div>
          ))}
        </div>
      ) : null}
      {errorMessage ? <InlineError message={errorMessage} /> : null}
    </div>
  );
}
