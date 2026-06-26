"use client";

import type { FormEvent } from "react";
import Image from "next/image";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { loginAdminSession, loginSession, registerWorkspace } from "@/lib/api";
import { PLATFORM_NAME } from "@/lib/branding";
import { useSessionStore } from "@/store/session";
import { useToastStore } from "@/store/toast";

type Mode = "login" | "register";
type LoginRole = "store" | "admin";

export default function LoginPage() {
  const router = useRouter();
  const accessToken = useSessionStore((state) => state.accessToken);
  const actorType = useSessionStore((state) => state.actorType);
  const hydrated = useSessionStore((state) => state.hydrated);
  const applySession = useSessionStore((state) => state.applySession);
  const applyAdminSession = useSessionStore((state) => state.applyAdminSession);
  const pushToast = useToastStore((state) => state.pushToast);
  const [mode, setMode] = useState<Mode>("login");
  const [loginRole, setLoginRole] = useState<LoginRole>("store");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loginForm, setLoginForm] = useState({
    email: "",
    password: "",
    organizationSlug: "",
  });
  const [registerForm, setRegisterForm] = useState({
    name: "",
    email: "",
    password: "",
    organizationName: "",
    organizationSlug: "",
  });

  useEffect(() => {
    if (hydrated && accessToken) {
      router.replace(actorType === "admin" ? "/superadmin" : "/dashboard");
    }
  }, [hydrated, accessToken, actorType, router]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      if (loginRole === "admin") {
        // Platform Yöneticisi (super_admin) — admins tablosu, ayri admin endpoint.
        // Magaza kisa adi ZORUNLU DEGIL.
        const adminSession = await loginAdminSession({
          username: loginForm.email.trim(),
          password: loginForm.password,
        });
        applyAdminSession(adminSession);
        pushToast({
          title: "Platform yöneticisi oturumu açıldı",
          description: "Platform Yönetimi paneli hazır.",
          tone: "success",
        });
        router.replace("/superadmin");
        return;
      }

      // Magaza Yoneticisi (organization owner/admin/member) — mevcut akis.
      const session = await loginSession({
        email: loginForm.email,
        password: loginForm.password,
        organizationSlug: loginForm.organizationSlug.trim() || undefined,
      });
      applySession(session);
      pushToast({
        title: "Oturum açıldı",
        description: "Operasyon paneli hazır.",
        tone: "success",
      });
      router.replace("/dashboard");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Oturum açılamadı";
      setError(message);
      pushToast({
        title: "Giriş başarısız",
        description: message,
        tone: "error",
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const session = await registerWorkspace(registerForm);
      applySession(session);
      pushToast({
        title: "Mağaza hazır",
        description: `Dogrulama linki ${registerForm.email} adresine gonderildi. Postanizi kontrol edin.`,
        tone: "success",
      });
      router.replace("/dashboard");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Mağaza oluşturulamadı";
      setError(message);
      pushToast({
        title: "Mağaza açılamadı",
        description: message,
        tone: "error",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid min-h-screen grid-cols-1 bg-paper text-ink lg:grid-cols-[1.05fr_0.95fr]">
      <section className="flex items-center px-6 py-10 sm:px-10 lg:px-16">
        <div className="w-full max-w-md">
          <p className="text-sm font-semibold uppercase text-mint">{PLATFORM_NAME}</p>
          <h1 className="mt-3 text-4xl font-bold leading-tight">Türkiye e-ticaret operasyonu tek merkezde.</h1>
          <p className="mt-4 text-base leading-7 text-zinc-600">
            Mağazanı kur, ekibini davet et, sipariş, stok, ödeme ve kargo akışlarını tek panelden yönet.
          </p>

          <div className="mt-8 inline-flex rounded-lg border border-line bg-white p-1">
            <button
              className={`focus-ring rounded-md px-4 py-2 text-sm font-semibold ${mode === "login" ? "bg-mint text-white" : "text-zinc-600"}`}
              onClick={() => setMode("login")}
              type="button"
            >
              Giriş
            </button>
            <button
              className={`focus-ring rounded-md px-4 py-2 text-sm font-semibold ${mode === "register" ? "bg-mint text-white" : "text-zinc-600"}`}
              onClick={() => setMode("register")}
              type="button"
            >
              Mağaza aç
            </button>
          </div>

          {mode === "login" ? (
            <form className="mt-6 space-y-4" onSubmit={handleLogin}>
              <div className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-white p-1">
                <button
                  className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${loginRole === "store" ? "bg-ink text-white" : "text-zinc-600"}`}
                  onClick={() => { setLoginRole("store"); setError(""); }}
                  type="button"
                >
                  Mağaza Yöneticisi
                </button>
                <button
                  className={`focus-ring rounded-md px-3 py-2 text-sm font-semibold ${loginRole === "admin" ? "bg-ink text-white" : "text-zinc-600"}`}
                  onClick={() => { setLoginRole("admin"); setError(""); }}
                  type="button"
                >
                  Platform Yöneticisi
                </button>
              </div>
              <p className="text-xs text-zinc-500">
                {loginRole === "admin"
                  ? "Sistem sahibi (super_admin) girişi — mağaza kısa adı gerekmez."
                  : "Mağaza ekibi girişi. Birden fazla mağazanız varsa kısa ad ile seçebilirsiniz."}
              </p>
              <label className="block">
                <span className="text-sm font-semibold text-zinc-700">E-posta</span>
                <input
                  autoComplete="username"
                  className="focus-ring mt-2 h-12 w-full rounded-lg border border-line bg-white px-4"
                  onChange={(event) => setLoginForm((state) => ({ ...state, email: event.target.value }))}
                  placeholder={loginRole === "admin" ? "yonetici@ornek.com" : "magaza-sahibi@ornek.com"}
                  type="email"
                  value={loginForm.email}
                />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-zinc-700">Şifre</span>
                <input
                  autoComplete="current-password"
                  className="focus-ring mt-2 h-12 w-full rounded-lg border border-line bg-white px-4"
                  onChange={(event) => setLoginForm((state) => ({ ...state, password: event.target.value }))}
                  placeholder="************"
                  type="password"
                  value={loginForm.password}
                />
              </label>
              {loginRole === "store" ? (
                <label className="block">
                  <span className="text-sm font-semibold text-zinc-700">Mağaza kısa adı <span className="font-normal text-zinc-400">(opsiyonel)</span></span>
                  <input
                    className="focus-ring mt-2 h-12 w-full rounded-lg border border-line bg-white px-4"
                    onChange={(event) => setLoginForm((state) => ({ ...state, organizationSlug: event.target.value }))}
                    placeholder="panelya"
                    type="text"
                    value={loginForm.organizationSlug}
                  />
                </label>
              ) : null}
              <button className="focus-ring h-12 w-full rounded-lg bg-mint px-5 font-semibold text-white disabled:opacity-70" disabled={loading} type="submit">
                {loading ? "Oturum açılıyor" : loginRole === "admin" ? "Platform yöneticisi girişi" : "Giriş yap"}
              </button>
            </form>
          ) : (
            <form className="mt-6 space-y-4" onSubmit={handleRegister}>
              <label className="block">
                <span className="text-sm font-semibold text-zinc-700">Ad soyad</span>
                <input
                  className="focus-ring mt-2 h-12 w-full rounded-lg border border-line bg-white px-4"
                  onChange={(event) => setRegisterForm((state) => ({ ...state, name: event.target.value }))}
                  placeholder="Arat"
                  type="text"
                  value={registerForm.name}
                />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-zinc-700">E-posta</span>
                <input
                  className="focus-ring mt-2 h-12 w-full rounded-lg border border-line bg-white px-4"
                  onChange={(event) => setRegisterForm((state) => ({ ...state, email: event.target.value }))}
                  placeholder="sahip@magaza.com"
                  type="email"
                  value={registerForm.email}
                />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-zinc-700">Şifre</span>
                <input
                  className="focus-ring mt-2 h-12 w-full rounded-lg border border-line bg-white px-4"
                  onChange={(event) => setRegisterForm((state) => ({ ...state, password: event.target.value }))}
                  placeholder="Sifre"
                  type="password"
                  value={registerForm.password}
                />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-zinc-700">Mağaza adı</span>
                <input
                  className="focus-ring mt-2 h-12 w-full rounded-lg border border-line bg-white px-4"
                  onChange={(event) => setRegisterForm((state) => ({ ...state, organizationName: event.target.value }))}
                  placeholder="Panelya"
                  type="text"
                  value={registerForm.organizationName}
                />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-zinc-700">Mağaza kısa adı</span>
                <input
                  className="focus-ring mt-2 h-12 w-full rounded-lg border border-line bg-white px-4"
                  onChange={(event) => setRegisterForm((state) => ({ ...state, organizationSlug: event.target.value }))}
                  placeholder="panelya"
                  type="text"
                  value={registerForm.organizationSlug}
                />
              </label>
              <button className="focus-ring h-12 w-full rounded-lg bg-mint px-5 font-semibold text-white disabled:opacity-70" disabled={loading} type="submit">
                {loading ? "Mağaza kuruluyor" : "Mağaza aç"}
              </button>
            </form>
          )}

          {error ? (
            <p className="mt-4 rounded-lg border border-coral/30 bg-coral/10 px-4 py-3 text-sm font-semibold text-coral">
              {error}
            </p>
          ) : null}
        </div>
      </section>

      <section className="hidden min-h-screen items-end bg-ink p-8 text-white lg:flex">
        <Image
          alt="Türkiye e-ticaret operasyon masası"
          className="h-[72vh] w-full rounded-lg object-cover"
          height={1440}
          priority
          sizes="(min-width: 1024px) 50vw, 0px"
          src="https://images.unsplash.com/photo-1556761175-5973dc0f32e7?auto=format&fit=crop&w=1200&q=80"
          width={1200}
        />
      </section>
    </main>
  );
}
