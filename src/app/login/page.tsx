"use client";

import { Suspense, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { Button, FormMessage, TextField, useAsyncAction } from "@/components/ui";

/**
 * useSearchParams() forces a client-side bailout during static
 * prerendering, so it must live under a Suspense boundary — without one,
 * `next build` fails on this page. The fallback renders the same shell
 * so the prerendered HTML still looks like the sign-in screen.
 */
function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { busy, message, run } = useAsyncAction();

  // Preserve the pre-login destination (/trips by default). Validated to a
  // local path so a crafted ?returnTo=https://... can't bounce users off-site.
  const returnToRaw = searchParams.get("returnTo") ?? "/trips";
  const returnTo = returnToRaw.startsWith("/") ? returnToRaw : "/trips";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);

    await run(async () => {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: data.get("email"),
          password: data.get("password"),
        }),
      });
      const body = await res.json();
      if (!res.ok || body.error) {
        throw new Error(body.error?.message ?? "Unable to sign in.");
      }
      router.push(returnTo);
      router.refresh();
    });
  }

  return (
    <AuthShell
      title="Sign in"
      subtitle="Enter your credentials to open the TripOS command center."
      footer={
        <>
          Don&apos;t have an account?{" "}
          <Link
            href={`/register${returnTo !== "/trips" ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`}
            className="font-medium text-navy-700 underline-offset-2 hover:underline dark:text-navy-500"
          >
            Create one
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
        />
        <TextField
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <Button type="submit" disabled={busy} className="h-10 w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
        <FormMessage message={message} />
      </form>
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <AuthShell
          title="Sign in"
          subtitle="Enter your credentials to open the TripOS command center."
          footer={null}
        >
          <div className="mt-6 h-40" />
        </AuthShell>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
