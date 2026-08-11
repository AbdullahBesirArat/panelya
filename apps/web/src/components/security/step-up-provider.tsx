"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { InlineError } from "@/components/operations-shared";
import {
  beginStepUpPasskey, fetchStepUpStatus, finishStepUpPasskey, verifyStepUp,
} from "@/lib/api/security";
import { getApiErrorCode } from "@/lib/api/types";
import { queryKeys } from "@/lib/query-keys";
import { useSessionStore } from "@/store/session";

type PendingAction = {
  action: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  requireFactor: boolean;
};

type StepUpContextValue = {
  runWithStepUp: <T>(action: () => Promise<T>) => Promise<T>;
  requestStepUp: () => Promise<void>;
};

type FactorMethod = "password" | "totp" | "recovery_code";

const StepUpContext = createContext<StepUpContextValue | null>(null);

export function useStepUp() {
  const value = useContext(StepUpContext);
  if (!value) throw new Error("useStepUp must be used inside StepUpProvider");
  return value;
}

export function StepUpProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const actorType = useSessionStore((state) => state.actorType);
  const subjectId = useSessionStore((state) => state.admin?.id ?? state.user?.id ?? null);
  const pendingRef = useRef<PendingAction | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<FactorMethod>("password");
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [factorRequired, setFactorRequired] = useState(false);

  const statusQuery = useQuery({
    queryKey: queryKeys.security.stepUp(actorType, subjectId),
    queryFn: fetchStepUpStatus,
    enabled: open,
    staleTime: 0,
  });

  const restoreOpenerFocus = useCallback(() => {
    let attempts = 0;
    const restore = () => {
      const opener = openerRef.current;
      if (!opener?.isConnected) return;
      if (!(opener instanceof HTMLButtonElement) || !opener.disabled) {
        opener.focus();
        return;
      }
      attempts += 1;
      if (attempts < 10) window.requestAnimationFrame(restore);
    };
    window.requestAnimationFrame(restore);
  }, []);

  const close = useCallback((reason?: unknown) => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    setOpen(false);
    setBusy(false);
    setValue("");
    setError("");
    setFactorRequired(false);
    if (pending && reason) pending.reject(reason);
    restoreOpenerFocus();
  }, [restoreOpenerFocus]);

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => {
      const firstControl = inputRef.current ?? dialogRef.current?.querySelector<HTMLElement>(
        'button:not([disabled]), input:not([disabled])',
      );
      firstControl?.focus();
    }, 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) close(new Error("Kimlik doğrulama iptal edildi."));
      if (event.key === "Tab") {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        );
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [busy, close, open, statusQuery.data]);

  const beginChallenge = useCallback(<T,>(
    action: () => Promise<T>,
    requireFactor: boolean,
    opener?: HTMLElement | null,
  ): Promise<T> => {
    if (pendingRef.current) return Promise.reject(new Error("Başka bir kimlik doğrulama işlemi sürüyor."));
    openerRef.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setFactorRequired(requireFactor);
    setMethod(requireFactor ? "totp" : "password");
    setOpen(true);
    return new Promise<T>((resolve, reject) => {
      pendingRef.current = {
        action,
        resolve: (result) => resolve(result as T),
        reject,
        requireFactor,
      };
    });
  }, []);

  const runWithStepUp = useCallback(<T,>(action: () => Promise<T>): Promise<T> => {
    // The protected request is asynchronous and commonly disables its trigger. Capture
    // focus before it starts; by the time STEP_UP_REQUIRED returns, focus may be <body>.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return action().catch((cause: unknown) => {
      if (getApiErrorCode(cause) !== "STEP_UP_REQUIRED"
        && getApiErrorCode(cause) !== "STEP_UP_FACTOR_REQUIRED") throw cause;
      return beginChallenge(action, getApiErrorCode(cause) === "STEP_UP_FACTOR_REQUIRED", opener);
    });
  }, [beginChallenge]);

  const requestStepUp = useCallback(
    () => beginChallenge(async () => undefined, true),
    [beginChallenge],
  );

  async function replayPending() {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    setOpen(false);
    try {
      const result = await pending.action();
      pending.resolve(result);
    } catch (cause) {
      if (getApiErrorCode(cause) === "STEP_UP_FACTOR_REQUIRED") {
        pendingRef.current = { ...pending, requireFactor: true };
        setFactorRequired(true);
        setMethod("totp");
        setError("Bu işlem için şifreye ek olarak kayıtlı bir güvenlik faktörü gerekiyor.");
        setBusy(false);
        setOpen(true);
        return;
      }
      pending.reject(cause);
    }
    setBusy(false);
    setValue("");
    setFactorRequired(false);
    restoreOpenerFocus();
  }

  async function submitFactor() {
    if (!value.trim() || busy) return;
    try {
      setBusy(true);
      setError("");
      if (effectiveMethod === "password") await verifyStepUp({ method: effectiveMethod, password: value });
      if (effectiveMethod === "totp") await verifyStepUp({ method: effectiveMethod, token: value });
      if (effectiveMethod === "recovery_code") await verifyStepUp({ method: effectiveMethod, code: value });
      await queryClient.invalidateQueries({ queryKey: queryKeys.security.stepUp(actorType, subjectId) });
      await replayPending();
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : "Doğrulama tamamlanamadı.");
    }
  }

  async function submitPasskey() {
    if (busy) return;
    try {
      setBusy(true);
      setError("");
      const begun = await beginStepUpPasskey();
      const response = await startAuthentication({ optionsJSON: begun.options });
      await finishStepUpPasskey(response, begun.challengeId);
      await queryClient.invalidateQueries({ queryKey: queryKeys.security.stepUp(actorType, subjectId) });
      await replayPending();
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : "Passkey doğrulaması tamamlanamadı.");
    }
  }

  const available = statusQuery.data?.available;
  const effectiveMethod: FactorMethod = factorRequired
    ? available?.totp
      ? "totp"
      : available?.recovery_code
        ? "recovery_code"
        : method
    : method === "password" && !available?.password
      ? available?.totp
        ? "totp"
        : available?.recovery_code
          ? "recovery_code"
          : method
      : method;
  const factorInputAvailable = effectiveMethod === "totp"
    ? Boolean(available?.totp)
    : effectiveMethod === "recovery_code"
      ? Boolean(available?.recovery_code)
      : Boolean(available?.password) && !factorRequired;

  return (
    <StepUpContext.Provider value={{ requestStepUp, runWithStepUp }}>
      {children}
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="presentation">
          <section
            aria-labelledby="step-up-title"
            aria-modal="true"
            className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl"
            ref={dialogRef}
            role="dialog"
          >
            <h2 className="text-lg font-bold" id="step-up-title">Kimliğinizi yeniden doğrulayın</h2>
            <p className="mt-1 text-sm text-zinc-600">
              {factorRequired
                ? "Devam etmek için kayıtlı bir ikinci faktörü doğrulayın."
                : "Bu kritik işlem için yakın zamanda doğrulama gerekiyor."}
            </p>
            {error ? <div className="mt-4"><InlineError message={error} /></div> : null}
            {statusQuery.isError ? <div className="mt-4"><InlineError message="Doğrulama yöntemleri yüklenemedi." /></div> : null}
            <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Doğrulama yöntemi">
              {available?.password && !factorRequired ? <Button size="sm" variant={effectiveMethod === "password" ? "mint" : "outline"} onClick={() => { setMethod("password"); setValue(""); }}>Şifre</Button> : null}
              {available?.totp ? <Button size="sm" variant={effectiveMethod === "totp" ? "mint" : "outline"} onClick={() => { setMethod("totp"); setValue(""); }}>Doğrulama kodu</Button> : null}
              {available?.recovery_code ? <Button size="sm" variant={effectiveMethod === "recovery_code" ? "mint" : "outline"} onClick={() => { setMethod("recovery_code"); setValue(""); }}>Kurtarma kodu</Button> : null}
            </div>
            {factorInputAvailable ? (
              <>
                <label className="mt-4 block text-sm font-semibold" htmlFor="step-up-value">
                  {effectiveMethod === "password" ? "Şifre" : effectiveMethod === "totp" ? "6 haneli kod" : "Kurtarma kodu"}
                </label>
                <input
                  autoComplete={effectiveMethod === "password" ? "current-password" : "one-time-code"}
                  className="focus-ring mt-1 h-10 w-full rounded-lg border border-line px-3 text-sm"
                  id="step-up-value"
                  inputMode={effectiveMethod === "totp" ? "numeric" : "text"}
                  onChange={(event) => setValue(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void submitFactor(); }}
                  ref={inputRef}
                  type={effectiveMethod === "password" ? "password" : "text"}
                  value={value}
                />
              </>
            ) : null}
            <div className="mt-5 flex flex-wrap justify-between gap-2">
              <div>{available?.webauthn ? <Button disabled={busy} onClick={() => void submitPasskey()} variant="outline">Passkey kullan</Button> : null}</div>
              <div className="flex gap-2">
                <Button disabled={busy} onClick={() => close(new Error("Kimlik doğrulama iptal edildi."))} variant="ghost">Vazgeç</Button>
                {factorInputAvailable ? <Button disabled={busy || !value.trim()} onClick={() => void submitFactor()}>{busy ? "Doğrulanıyor…" : "Doğrula ve devam et"}</Button> : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </StepUpContext.Provider>
  );
}
