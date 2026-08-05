"use client";

// The app had NO error boundary anywhere. Any throw in a client component took
// the route down with no message and no way back — which is why a teacher's bug
// report reads "the app froze" rather than "it said something went wrong", and
// why there was no error text to work from when it did.
//
// This wraps every segment below src/app. It does NOT wrap the root layout
// itself (Next's rule: error.js wraps page/loading/not-found and nested layouts,
// never the layout in its own segment) — a root-layout failure would need
// global-error.tsx, which is a separate, rarer case.
//
// PROP NAME: `unstable_retry`, not `reset`. This Next version renamed it; `reset`
// still exists but only clears the error state without re-fetching, and the docs
// are explicit that retry is the one you want.
// See node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md
//
// WHY THE STRINGS ARE INLINE, when the app has a ten-locale catalogue:
// an error boundary must not be able to fail. i18n/dictionaries.ts is
// `import "server-only"` and unusable from a Client Component, and the obvious
// alternative — a dynamic import of the locale's JSON — would make the fallback
// UI depend on a network fetch, when a failed chunk load is one of the LIKELIER
// causes of the error we are already recovering from. So these two strings are
// copied from `common.somethingWentWrong` / `common.tryAgain` and pinned by
// src/i18n/__tests__/error-boundary-strings.test.ts, which fails if they ever
// drift from the catalogue.

import { useEffect } from "react";

type Copy = { message: string; retry: string };

/** Exported for the drift test. Keys are the lower-cased <html lang> values. */
export const ERROR_COPY: Record<string, Copy> = {
  en: { message: "Something went wrong — try again shortly.", retry: "Try again" },
  ms: { message: "Ada masalah — sila cuba lagi sebentar lagi.", retry: "Cuba lagi" },
  ar: { message: "حدث خطأ ما — أعد المحاولة بعد قليل.", retry: "أعد المحاولة" },
  fr: { message: "Une erreur est survenue — réessayez dans un instant.", retry: "Réessayer" },
  es: { message: "Algo salió mal — inténtalo de nuevo en un momento.", retry: "Reintentar" },
  pt: { message: "Algo deu errado — tente de novo em instantes.", retry: "Tentar de novo" },
  te: { message: "ఏదో పొరపాటు జరిగింది — కాసేపటి తర్వాత మళ్లీ ప్రయత్నించండి.", retry: "మళ్లీ ప్రయత్నించండి" },
  mr: { message: "काहीतरी चूक झाली — थोड्या वेळाने पुन्हा प्रयत्न करा.", retry: "पुन्हा प्रयत्न करा" },
  hi: { message: "कुछ गड़बड़ हो गई — थोड़ी देर बाद फिर कोशिश करें।", retry: "फिर कोशिश करें" },
  "ms-arab": { message: "اد مسئله — سيلا چوبا لاݢي سبنتر لاݢي.", retry: "چوبا لاݢي" },
};

/** The copy for whatever <html lang> the layout rendered. `ms-Arab` is BCP-47
 * title-case for our internal `ms-arab`, hence the lower-case lookup. */
function copyForDocument(): Copy {
  if (typeof document === "undefined") return ERROR_COPY.en;
  const tag = (document.documentElement.lang || "en").toLowerCase();
  return ERROR_COPY[tag] ?? ERROR_COPY[tag.split("-")[0]] ?? ERROR_COPY.en;
}

export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    // Nothing collects these yet, but the browser console is the only record a
    // beta teacher can be walked through reading, and `digest` is the handle
    // that matches a server-side log line.
    console.error("[sketchcast] unhandled error", error);
  }, [error]);

  const copy = copyForDocument();

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="card w-full max-w-md p-6 text-center">
        <p className="text-sm text-[#14181F]">{copy.message}</p>
        {/* The digest is the ONLY thing that ties a user's screenshot to a log
            line. Rendered small and selectable rather than hidden, because the
            support path is a teacher reading it back over WhatsApp. */}
        {error.digest && (
          <p className="mt-2 select-all font-mono text-[11px] text-[#98A0A9]">{error.digest}</p>
        )}
        <button onClick={() => unstable_retry()} className="btn-primary mt-4 h-11 px-4 text-sm">
          {copy.retry}
        </button>
      </div>
    </div>
  );
}
