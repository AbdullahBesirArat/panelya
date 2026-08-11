import type { FormEvent, ReactNode } from "react";

export function ProductForm({
  children,
  onSubmit,
  ariaLabel = "Ürün formu",
}: {
  children: ReactNode;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  ariaLabel?: string;
}) {
  return (
    <form aria-label={ariaLabel} className="grid gap-4" onSubmit={onSubmit}>
      {children}
    </form>
  );
}
