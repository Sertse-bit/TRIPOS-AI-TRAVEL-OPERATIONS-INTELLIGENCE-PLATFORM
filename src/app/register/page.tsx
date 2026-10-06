"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AuthShell } from "@/components/auth-shell";
import { Button, FormMessage, TextField, useAsyncAction } from "@/components/ui";

/**
 * Same Suspense requirement as the login page: useSearchParams() bails
 * out of static prerendering unless a boundary sits above it.
 */
function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { busy, message, run } = useAsyncAction();

  const returnToRaw = searchParams.get("returnTo") ?? "/trips";
  const returnTo = returnToRaw.startsWith("/") ? returnToRaw : "/trips";

  // Password rule mirrors the server's validatePasswordStrength (min 12) so
  // the user gets immediate feedback instead of a round-trip to find out.
  const [password, setPassword] = useState("");
  const passwordTooShort = password.length > 0 && password.length < 12;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);

    await run(async () => {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: data.get("email"),
          password: data.get("password"),
          name: data.get("name"),
        }),
      });
      const body = await res.json();
      if (!res.ok || body.error) {
        throw new Error(body.error?.message ?? "Unable to create account.");
      }
      router.push(returnTo);
      router.refresh();
    });
  }

  return (
    <AuthShell
      title="Create account"
      subtitle="Create a TripOS account to start your trip intelligence board."
      footer={
        <>
          Already have an account?{" "}
          <Link
            href={`/login${returnTo !== "/trips" ? `?returnTo=${encodeURIComponent(returnTo)}` : ""}`}
            className="font-medium text-navy-700 dark:text-navy-500 underline-offset-2 hover:underline dark:text-navy-500"
          >
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <TextField
          label="Name"
          name="name"
          type="text"
          autoComplete="name"
          required
          maxLength={200}
          placeholder="Ada Lovelace"
        />
        <TextField
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@example.com"
        />
        <div>
          <TextField
            label="Password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            onChange={(value) => setPassword(value)}
          />
          <p className={`mt-1 text-xs ${passwordTooShort ? "text-alert-600" : "text-sand-600"}`}>
            At least 12 characters. Length matters more than symbol soup.
          </p>
        </div>
        <Button type="submit" busy={busy} disabled={passwordTooShort} className="h-10 w-full">
          {busy ? "Creating account…" : "Create account"}
        </Button>
        <FormMessage message={message} />
      </form>
    </AuthShell>
  );
}

export default function RegisterPage() {
  return (
    <Suspense
      fallback={
        <AuthShell
          title="Create account"
          subtitle="Create a TripOS account to start your trip intelligence board."
          footer={null}
        >
          <div className="mt-6 h-56" />
        </AuthShell>
      }
    >
      <RegisterForm />
    </Suspense>
  );
}
