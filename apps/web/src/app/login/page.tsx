"use client";
import { useActionState } from "react";
import { login } from "../actions";

export default function Login() {
  const [state, action, pending] = useActionState(login, null as { error?: string } | null);
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <form action={action} className="rise w-full max-w-sm rounded-2xl border border-line bg-panel p-6">
        <div className="mb-6 flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-accent shadow-[0_0_12px] shadow-accent" />
          <span className="font-semibold tracking-tight">AI Universe</span>
        </div>
        <label className="block text-sm text-muted" htmlFor="pw">Owner password</label>
        <input id="pw" name="password" type="password" autoFocus required className="mt-1 w-full" />
        {state?.error && <p className="mt-2 text-sm text-bad">{state.error}</p>}
        <button disabled={pending} className="mt-4 w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-bg disabled:opacity-60">
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
