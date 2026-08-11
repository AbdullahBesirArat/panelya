import type { ApiCategory } from "@/lib/api/types";

export function CategoryPicker({
  categories,
  value,
  onChange,
  id,
  emptyLabel = "Kategori seç",
  disabled = false,
}: {
  categories: ApiCategory[];
  value: string;
  onChange: (value: string) => void;
  id?: string;
  emptyLabel?: string;
  disabled?: boolean;
}) {
  return (
    <select
      // A31: this picker has no visible label anywhere it is used, so without a name it
      // was an anonymous combobox (axe select-name, critical). The empty-option text is
      // the control's own description, so it doubles as the accessible name.
      aria-label={emptyLabel}
      className="focus-ring h-10 rounded-lg border border-line bg-white px-3 text-sm"
      disabled={disabled}
      id={id}
      onChange={(event) => onChange(event.target.value)}
      value={value}
    >
      <option value="">{emptyLabel}</option>
      {categories.map((category) => (
        <option key={category.id} value={category.id}>{category.name}</option>
      ))}
    </select>
  );
}
