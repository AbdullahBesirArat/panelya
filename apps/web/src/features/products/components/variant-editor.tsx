import type { ReactNode } from "react";

export function VariantEditor({ children }: { children: ReactNode }) {
  return (
    <details className="group rounded-lg border border-line bg-zinc-50">
      <summary className="focus-ring flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm font-semibold text-ink">
        <span>Renk, beden ve stok akışı (önce renk, sonra beden, sonra stok)</span>
        <span className="text-xs font-semibold text-zinc-600 group-open:hidden">Aç</span>
        <span className="hidden text-xs font-semibold text-zinc-600 group-open:inline">Kapat</span>
      </summary>
      <div className="space-y-4 border-t border-line bg-white px-4 py-4">{children}</div>
    </details>
  );
}
