import { create } from "zustand";

type ToastTone = "success" | "error" | "info";

export type ToastItem = {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
};

type ToastState = {
  items: ToastItem[];
  pushToast: (toast: Omit<ToastItem, "id">) => string;
  dismissToast: (id: string) => void;
};

export const useToastStore = create<ToastState>()((set) => ({
  items: [],
  pushToast: (toast) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((state) => ({
      items: [...state.items, { ...toast, id }].slice(-4),
    }));
    return id;
  },
  dismissToast: (id) =>
    set((state) => ({
      items: state.items.filter((item) => item.id !== id),
    })),
}));
