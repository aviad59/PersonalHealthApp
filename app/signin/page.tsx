"use client";

import { Suspense } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignIn />
    </Suspense>
  );
}

function SignIn() {
  const searchParams = useSearchParams();
  const denied = searchParams?.get("error") === "AccessDenied";

  return (
    <div className="px-5 pt-20 pb-10 space-y-8">
      <div className="text-center space-y-2">
        <h1 className="text-3xl font-bold">Health</h1>
        <p className="text-sm text-white/60">Sign in with your Google account to continue.</p>
      </div>

      {denied && (
        <div className="card p-4 text-sm text-amber-400/90 text-center">
          That Google account isn&apos;t connected to this app yet.
        </div>
      )}

      <button
        onClick={() => signIn("google", { callbackUrl: "/" })}
        className="w-full card p-4 flex items-center justify-center gap-3 font-medium active:scale-[0.99] transition-transform"
      >
        <GoogleIcon className="h-5 w-5" />
        Sign in with Google
      </button>
    </div>
  );
}

function GoogleIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" {...props}>
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.2-2.27H12v4.51h6.47c-.28 1.5-1.13 2.77-2.4 3.62v3.01h3.86c2.26-2.08 3.56-5.16 3.56-8.87z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3.01c-1.07.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.27v3.1C3.24 21.3 7.27 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.28A7.2 7.2 0 0 1 4.9 12c0-.79.14-1.55.37-2.28V6.62H1.27A11.96 11.96 0 0 0 0 12c0 1.93.46 3.76 1.27 5.38l4-3.1z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.27 0 3.24 2.7 1.27 6.62l4 3.1C6.22 6.86 8.87 4.75 12 4.75z"
      />
    </svg>
  );
}
