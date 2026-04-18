"use client";

import type { FormEvent } from "react";
import Image from "next/image";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { loginSession, registerWorkspace } from "@/lib/api";
import { useSessionStore } from "@/store/session";
import { useToastStore } from "@/store/toast";

type Mode = "login" | "register";

export default function LoginPage() {
  const router = useRouter();
  const accessToken = useSessionStore((state) => state.accessToken);
  const hydrated = useSessionStore((state) => state.hydrated);
  const applySession = useSessionStore((state) => state.applySession);
  const pushToast = useToastStore((state) => state.pushToast);
  const [mode, setMode] = useState<Mode>("login");
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
      router.replace("/dashboard");
    }
  }, [hydrated, accessToken, router]);

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const session = await loginSession(loginForm);
      applySession(session);
      pushToast({
        title: "Oturum acildi",
        description: "Dashboard hazir.",
        tone: "success",
      });
      router.replace("/dashboard");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Oturum acilamadi";
      setError(message);
      pushToast({
        title: "Giris basarisiz",
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
        title: "Workspace hazir",
        description: "Yeni organizasyon ile oturum acildi.",
        tone: "success",
      });
      router.replace("/dashboard");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Workspace olusturulamadi";
      setError(message);
      pushToast({
        title: "Workspace acilamadi",
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
          <p className="text-sm font-semibold uppercase text-mint">Maveran</p>
          <h1 className="mt-3 text-4xl font-bold leading-tight">Operasyonlar tek merkezde.</h1>
          <p className="mt-4 text-base leading-7 text-zinc-600">
            Workspace kur, ekibini davet et, siparis ve stok akislarini tek panelden yonet.
          </p>

          <div className="mt-8 inline-flex rounded-lg border border-line bg-white p-1">
            <button
              className={`focus-ring rounded-md px-4 py-2 text-sm font-semibold ${mode === "login" ? "bg-mint text-white" : "text-zinc-600"}`}
              onClick={() => setMode("login")}
              type="button"
            >
              Giris
            </button>
            <button
              className={`focus-ring rounded-md px-4 py-2 text-sm font-semibold ${mode === "register" ? "bg-mint text-white" : "text-zinc-600"}`}
              onClick={() => setMode("register")}
              type="button"
            >
              Workspace ac
            </button>
          </div>

          {mode === "login" ? (
            <form className="mt-6 space-y-4" onSubmit={handleLogin}>
              <label className="block">
                <span className="text-sm font-semibold text-zinc-700">E-posta</span>
                <input
                  className="focus-ring mt-2 h-12 w-full rounded-lg border border-line bg-white px-4"
                  onChange={(event) => setLoginForm((state) => ({ ...state, email: event.target.value }))}
                  placeholder="owner@maveran.com"
                  type="email"
                  value={loginForm.email}
                />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-zinc-700">Sifre</span>
                <input
                  className="focus-ring mt-2 h-12 w-full rounded-lg border border-line bg-white px-4"
                  onChange={(event) => setLoginForm((state) => ({ ...state, password: event.target.value }))}
                  placeholder="************"
                  type="password"
                  value={loginForm.password}
                />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-zinc-700">Workspace slug</span>
                <input
                  className="focus-ring mt-2 h-12 w-full rounded-lg border border-line bg-white px-4"
                  onChange={(event) => setLoginForm((state) => ({ ...state, organizationSlug: event.target.value }))}
                  placeholder="maveran"
                  type="text"
                  value={loginForm.organizationSlug}
                />
              </label>
              <button className="focus-ring h-12 w-full rounded-lg bg-mint px-5 font-semibold text-white disabled:opacity-70" disabled={loading} type="submit">
                {loading ? "Oturum aciliyor" : "Giris yap"}
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
                  placeholder="owner@workspace.com"
                  type="email"
                  value={registerForm.email}
                />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-zinc-700">Sifre</span>
                <input
                  className="focus-ring mt-2 h-12 w-full rounded-lg border border-line bg-white px-4"
                  onChange={(event) => setRegisterForm((state) => ({ ...state, password: event.target.value }))}
                  placeholder="En az 12 karakter"
                  type="password"
                  value={registerForm.password}
                />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-zinc-700">Workspace adi</span>
                <input
                  className="focus-ring mt-2 h-12 w-full rounded-lg border border-line bg-white px-4"
                  onChange={(event) => setRegisterForm((state) => ({ ...state, organizationName: event.target.value }))}
                  placeholder="Maveran Labs"
                  type="text"
                  value={registerForm.organizationName}
                />
              </label>
              <label className="block">
                <span className="text-sm font-semibold text-zinc-700">Workspace slug</span>
                <input
                  className="focus-ring mt-2 h-12 w-full rounded-lg border border-line bg-white px-4"
                  onChange={(event) => setRegisterForm((state) => ({ ...state, organizationSlug: event.target.value }))}
                  placeholder="maveran-labs"
                  type="text"
                  value={registerForm.organizationSlug}
                />
              </label>
              <button className="focus-ring h-12 w-full rounded-lg bg-mint px-5 font-semibold text-white disabled:opacity-70" disabled={loading} type="submit">
                {loading ? "Workspace kuruluyor" : "Workspace ac"}
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
          alt="Warehouse operations desk"
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
