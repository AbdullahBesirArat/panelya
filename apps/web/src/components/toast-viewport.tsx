"use client";

import { useEffect } from "react";
import { useToastStore } from "@/store/toast";

const toneClass = {
  success: "border-leaf/30 bg-white text-ink",
  error: "border-coral/30 bg-white text-ink",
  info: "border-mint/30 bg-white text-ink",
} as const;

const badgeClass = {
  success: "bg-leaf/10 text-leaf",
  error: "bg-coral/10 text-coral",
  info: "bg-mint/10 text-mint",
} as const;

export function ToastViewport() {
  const items = useToastStore((state) => state.items);
  const dismissToast = useToastStore((state) => state.dismissToast);

  useEffect(() => {
    if (items.length === 0) return;

    const timers = items.map((item) =>
      window.setTimeout(() => dismissToast(item.id), 3200)
    );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [items, dismissToast]);

  if (items.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-4 top-4 z-50 flex flex-col gap-3 sm:left-auto sm:right-4 sm:w-full sm:max-w-sm">
      {items.map((item) => (
        <section
          className={`pointer-events-auto rounded-lg border px-4 py-3 shadow-panel transition-all ${toneClass[item.tone]}`}
          key={item.id}
        >
          <div className="flex items-start gap-3">
            <span className={`inline-flex min-h-8 items-center rounded-md px-2.5 text-xs font-semibold ${badgeClass[item.tone]}`}>
              {item.tone === "success" ? "OK" : item.tone === "error" ? "Hata" : "Bilgi"}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{item.title}</p>
              {item.description ? <p className="mt-1 text-sm text-zinc-500">{item.description}</p> : null}
            </div>
            <button
              className="focus-ring rounded-md px-2 py-1 text-xs font-semibold text-zinc-500"
              onClick={() => dismissToast(item.id)}
              type="button"
            >
              Kapat
            </button>
          </div>
        </section>
      ))}
    </div>
  );
}
