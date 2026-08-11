import type { ApiCollection } from "@/lib/api/types";

export function CollectionPicker({
  collections,
  selectedIds,
  onToggle,
  disabled = false,
}: {
  collections: ApiCollection[];
  selectedIds: ReadonlySet<string>;
  onToggle: (collectionId: string) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-600">Koleksiyonlar</legend>
      {collections.length ? collections.map((collection) => (
        <label className="flex min-h-10 items-center gap-3 rounded-lg border border-line px-3 text-sm" key={collection.id}>
          <input
            checked={selectedIds.has(collection.id)}
            className="h-4 w-4 rounded border-line"
            onChange={() => onToggle(collection.id)}
            type="checkbox"
          />
          <span>{collection.title}</span>
        </label>
      )) : <p className="text-sm text-zinc-600">Henüz koleksiyon yok.</p>}
    </fieldset>
  );
}
