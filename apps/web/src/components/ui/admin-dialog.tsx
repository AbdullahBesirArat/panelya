"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";

// A31. The one modal lifecycle for the admin. Before this, each surface re-implemented its
// own focus trap and each one was missing something different: no background inertness, no
// scroll lock, no explicit backdrop policy, or no focus restore. Anything modal in the
// admin goes through here so those guarantees are a property of the primitive rather than
// of whoever wrote the screen.
//
// A30's step-up dialog deliberately keeps its own implementation: it is security-critical,
// already carries the full lifecycle, and is covered by the A30 acceptance suite.

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function AdminDialog({
  title,
  description,
  children,
  onClose,
  closeLabel = "Kapat",
  /** Whether clicking the backdrop dismisses. Explicit per dialog: a form mid-edit should
   *  not be discarded by a stray click, while a read-only panel may close freely. */
  dismissOnBackdrop = false,
  size = "md",
  /** Where focus goes when the dialog closes.
   *
   *  Capturing document.activeElement at mount is only correct for a dialog that opens
   *  synchronously. When the trigger awaits something first — the TOTP setup runs a step-up,
   *  a network call and QR generation before its state renders the dialog — focus has
   *  already fallen back to <body> by the time this mounts, so there is nothing to capture
   *  and focus is silently never restored. A caller-owned ref is read at CLOSE time, so it
   *  resolves to the trigger's current node however long the open took and even if React
   *  re-rendered it. Optional: synchronous dialogs still get the mount-time fallback. */
  restoreFocusRef,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  closeLabel?: string;
  dismissOnBackdrop?: boolean;
  size?: "md" | "lg";
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // Read through a ref so the effect below can run once and still call the latest handler.
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Releasing isolation and restoring focus must happen on the CLOSE PATH, before React
  // unmounts the dialog — not in the effect cleanup. A live diagnostic proved the opener is
  // still connected and is the same node at that point, yet focus ends up on <body>:
  // cleanup runs while React is still tearing the dialog down, and removing the focused
  // dialog node blurs to <body> straight after. Doing it before unmount is deterministic
  // and needs no timer. The cleanup keeps an idempotent copy as a safety net for unmounts
  // that bypass these paths (a parent dropping the dialog outright).
  const releaseRef = useRef<(() => void) | null>(null);

  // Read at close time, never cached: the explicit trigger ref wins because it resolves to
  // the control's CURRENT node, and the mount-time capture only stands in for dialogs that
  // opened synchronously. Nothing falls back to document.body — focus going nowhere useful
  // is not better than focus staying put.
  const restoreFocusTarget = () => {
    const explicit = restoreFocusRef?.current;
    if (explicit && explicit.isConnected && !(explicit as HTMLButtonElement).disabled) return explicit;
    const captured = openerRef.current;
    if (captured && captured.isConnected) return captured;
    return null;
  };

  const requestCloseRef = useRef<() => void>(() => {});

  const requestClose = () => {
    releaseRef.current?.();
    restoreFocusTarget()?.focus();
    onCloseRef.current();
  };
  // Refreshed every render so the mount-once keydown handler always calls the latest
  // closure, without the effect taking a changing dependency. Declared before the mount
  // effect below, so it is assigned before any key event can reach the handler.
  useEffect(() => {
    requestCloseRef.current = requestClose;
  });

  useEffect(() => {
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // The dialog is portaled to <body>, so the application roots (#main, the sidebar, the
    // header) are its SIBLINGS and can be isolated. Rendering in place made this
    // impossible: #main was an ancestor, and hiding an ancestor would hide the dialog too.
    //
    // aria-hidden alone removes the background from the accessibility tree but still lets
    // focus reach it, so `inert` is applied as well where the browser supports it. Both
    // previous values are captured per element and restored exactly, because an overlay may
    // already have marked something hidden and clearing it blindly would break that.
    const overlay = overlayRef.current;
    const restore: Array<{ node: HTMLElement; ariaHidden: string | null; inert: boolean }> = [];
    for (const sibling of Array.from(document.body.children)) {
      if (!(sibling instanceof HTMLElement)) continue;
      if (sibling === overlay || sibling.contains(overlay)) continue;
      // Non-rendered heads and framework internals carry no semantics to hide.
      if (["SCRIPT", "STYLE", "LINK", "TEMPLATE", "NOSCRIPT"].includes(sibling.tagName)) continue;
      restore.push({
        node: sibling,
        ariaHidden: sibling.getAttribute("aria-hidden"),
        inert: sibling.inert,
      });
      sibling.setAttribute("aria-hidden", "true");
      sibling.inert = true;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Restores the exact prior state rather than clearing, so a nested or pre-existing
    // overlay's own isolation survives this dialog closing. Idempotent: whichever of the
    // close path or the unmount cleanup runs first, the second is a no-op.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const entry of restore) {
        if (entry.ariaHidden === null) entry.node.removeAttribute("aria-hidden");
        else entry.node.setAttribute("aria-hidden", entry.ariaHidden);
        entry.node.inert = entry.inert;
      }
      document.body.style.overflow = previousOverflow;
    };
    releaseRef.current = release;

    closeRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        requestCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      ).filter((node) => node.offsetParent !== null || node.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      // Focus that escaped the dialog is pulled back rather than left outside.
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      release();
    };
  }, []);

  // Portalled to <body> so the application roots become siblings and can be isolated while
  // the dialog is open. Rendered only on the client: `document` does not exist during the
  // server pass, and a modal only ever exists in response to a user action anyway.
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={dismissOnBackdrop ? (event) => {
        if (event.target === event.currentTarget) requestClose();
      } : undefined}
      ref={overlayRef}
    >
      <section
        aria-describedby={description ? descriptionId : undefined}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`flex max-h-[90vh] w-full ${size === "lg" ? "max-w-2xl" : "max-w-lg"} flex-col overflow-hidden rounded-xl bg-white shadow-2xl`}
        ref={dialogRef}
        role="dialog"
      >
        <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-ink" id={titleId}>{title}</h2>
            {description ? (
              <p className="mt-1 text-xs text-zinc-600" id={descriptionId}>{description}</p>
            ) : null}
          </div>
          <Button onClick={requestClose} ref={closeRef} size="sm" variant="ghost">{closeLabel}</Button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </section>
    </div>,
    document.body,
  );
}
