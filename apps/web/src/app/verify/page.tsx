"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { confirmTenantEmailChange, verifyTenantEmail } from "@/lib/api";

type Status = "pending" | "ok" | "error";

export default function VerifyPage() {
  const params = useSearchParams();
  const [status, setStatus] = useState<Status>("pending");
  const [message, setMessage] = useState("Dogrulama yapiliyor...");

  useEffect(() => {
    const token = (params?.get("token") || "").trim();
    const purpose = (params?.get("purpose") || "").trim();

    if (!token) {
      setStatus("error");
      setMessage("Dogrulama linki eksik veya hatali.");
      return;
    }

    const run = async () => {
      try {
        if (purpose === "email_change") {
          await confirmTenantEmailChange(token);
          setStatus("ok");
          setMessage("E-posta degisikligi onaylandi. Yeni adresinizle giris yapabilirsiniz.");
        } else {
          await verifyTenantEmail(token);
          setStatus("ok");
          setMessage("E-postaniz dogrulandi. Hesabiniz hazir.");
        }
      } catch (err) {
        setStatus("error");
        setMessage(err instanceof Error ? err.message : "Dogrulama basarisiz.");
      }
    };
    run();
  }, [params]);

  const tone =
    status === "ok"
      ? "border-mint/30 bg-mint/10 text-mint"
      : status === "error"
        ? "border-coral/30 bg-coral/10 text-coral"
        : "border-line bg-white text-zinc-600";

  return (
    <main className="flex min-h-screen items-center justify-center bg-paper px-6 py-12">
      <div className="w-full max-w-md rounded-xl border border-line bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold uppercase text-mint">Panelya</p>
        <h1 className="mt-3 text-2xl font-bold">E-posta dogrulama</h1>
        <p className={`mt-6 rounded-lg border px-4 py-3 text-sm font-semibold ${tone}`}>{message}</p>
        <a className="focus-ring mt-6 inline-flex h-11 items-center rounded-lg bg-ink px-5 text-sm font-semibold text-white" href="/login">
          Giris sayfasina don
        </a>
      </div>
    </main>
  );
}
