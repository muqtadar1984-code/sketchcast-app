"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Dictionary } from "@/i18n/dictionaries";
import { htmlLang, type Locale } from "@/i18n/locales";
import { fmt } from "@/i18n/format";
import { COUNTRY_CODES } from "@/utils/countries";
import { SCHOOL_TYPES, SIZE_BANDS, REGISTRANT_ROLES, CURRICULA, TURNSTILE_ACTION, previewSlug } from "@/utils/school-registration-options";
import Turnstile from "@/components/turnstile";

// Step two of "Create your school's workspace" (0101, Phase 3): everything
// about the SCHOOL, in one screen. The account already exists and the email is
// confirmed by the time this renders. POSTs /api/school-finish, which does the
// only writes.
//
// The option VALUES are stable machine keys from utils/school-registration-
// options.ts (stored in schools.meta and read by the console); the LABELS come
// from the dictionary. The route validates against the same sets.

type T = Dictionary["app"]["schoolSignup"]["finish"];

/** "I agree to the {terms} and the {privacy}." → the sentence with two links,
 * in whatever order the translator put the slots. */
function Consent({ text, terms, privacy }: { text: string; terms: { href: string; label: string }; privacy: { href: string; label: string } }) {
  const parts = text.split(/(\{terms\}|\{privacy\})/);
  return (
    <>
      {parts.map((p, i) => {
        if (p === "{terms}" || p === "{privacy}") {
          const link = p === "{terms}" ? terms : privacy;
          return (
            <a key={i} href={link.href} target="_blank" rel="noreferrer" className="text-[#0C8175] underline">
              {link.label}
            </a>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

export default function FinishForm({
  t,
  common,
  locale,
  country: initialCountry,
  siteKey,
  schoolHost,
  legalBase,
}: {
  t: T;
  common: Dictionary["common"];
  locale: Locale;
  /** The edge's guess, from the page's server render; the reader can change it. */
  country: string | null;
  /** NEXT_PUBLIC_TURNSTILE_SITE_KEY — null renders no widget (see utils/turnstile.ts). */
  siteKey: string | null;
  /** The portal host, for the address preview. */
  schoolHost: string;
  /** Where /terms and /privacy live for this locale. */
  legalBase: string;
}) {
  const router = useRouter();
  const [schoolName, setSchoolName] = useState("");
  const [country, setCountry] = useState(initialCountry ?? "");
  const [schoolType, setSchoolType] = useState("");
  const [sizeBand, setSizeBand] = useState("");
  const [role, setRole] = useState("");
  const [curricula, setCurricula] = useState<string[]>([]);
  const [phone, setPhone] = useState("");
  const [heardFrom, setHeardFrom] = useState("");
  const [consent, setConsent] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onToken = useCallback((v: string | null) => setToken(v), []);

  // Country names from the runtime's CLDR data (the onboarding form's pattern):
  // no country-name strings in the message files, native names in every locale.
  const countries = useMemo(() => {
    const tag = htmlLang(locale);
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([tag], { type: "region" });
    } catch {
      names = null;
    }
    return COUNTRY_CODES.map((code) => {
      let name = code as string;
      try {
        name = names?.of(code) ?? code;
      } catch {
        // the registry only holds assigned codes
      }
      return { code, name };
    }).sort((a, b) => a.name.localeCompare(b.name, tag));
  }, [locale]);

  const missing = {
    schoolName: schoolName.trim().length < 2,
    country: !country,
    schoolType: !schoolType,
    sizeBand: !sizeBand,
    role: !role,
    consent: !consent,
    captcha: !!siteKey && !token,
  };
  const ready = !Object.values(missing).some(Boolean);
  const show = (k: keyof typeof missing) => attempted && missing[k];

  const toggle = (value: string) =>
    setCurricula((list) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setAttempted(true);
    setError(null);
    if (!ready) return;
    setBusy(true);
    const res = await fetch("/api/school-finish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schoolName: schoolName.trim(),
        country,
        meta: { school_type: schoolType, size_band: sizeBand, curricula },
        registration: { registrant_role: role, phone: phone.trim() || null, heard_from: heardFrom.trim() || null },
        turnstileToken: token,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    setBusy(false);
    if (!res.ok) {
      // A failed or expired challenge needs a fresh token; the widget re-issues
      // one on its own, so just clear ours and say so in the reader's language.
      if (json.code === "captcha") {
        setToken(null);
        setError(t.captchaRequired);
        return;
      }
      setError(json.error ?? common.somethingWentWrong);
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  const field = "field w-full h-11 px-3 text-[#14181F]";
  const label = "block text-xs font-medium text-[#5B6470] mb-1";
  const hint = "text-xs text-[#B3401F] mt-1";

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div>
        <label className={label} htmlFor="schoolName">{t.schoolName}</label>
        <input
          id="schoolName"
          required
          value={schoolName}
          onChange={(e) => setSchoolName(e.target.value)}
          className={field}
          autoComplete="organization"
        />
        {schoolName.trim().length >= 2 && (
          <p className="text-xs text-[#98A0A9] mt-1">
            {fmt(t.portalPreview, { url: `${schoolHost}/${previewSlug(schoolName)}` })}
          </p>
        )}
        {show("schoolName") && <p className={hint}>{t.schoolName}</p>}
      </div>

      <div>
        <label className={label} htmlFor="country">{t.country}</label>
        <select id="country" value={country} onChange={(e) => setCountry(e.target.value)} className={field}>
          <option value="">{t.chooseOne}</option>
          {countries.map((c) => (
            <option key={c.code} value={c.code}>{c.name}</option>
          ))}
        </select>
        {show("country") && <p className={hint}>{t.country}</p>}
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label className={label} htmlFor="schoolType">{t.schoolType}</label>
          <select id="schoolType" value={schoolType} onChange={(e) => setSchoolType(e.target.value)} className={field}>
            <option value="">{t.chooseOne}</option>
            {SCHOOL_TYPES.map((k) => (
              <option key={k} value={k}>{t.types[k]}</option>
            ))}
          </select>
          {show("schoolType") && <p className={hint}>{t.schoolType}</p>}
        </div>
        <div>
          <label className={label} htmlFor="sizeBand">{t.sizeBand}</label>
          <select id="sizeBand" value={sizeBand} onChange={(e) => setSizeBand(e.target.value)} className={field}>
            <option value="">{t.chooseOne}</option>
            {SIZE_BANDS.map((k) => (
              <option key={k} value={k}>{t.sizes[k]}</option>
            ))}
          </select>
          {show("sizeBand") && <p className={hint}>{t.sizeBand}</p>}
        </div>
      </div>

      <div>
        <label className={label} htmlFor="role">{t.yourRole}</label>
        <select id="role" value={role} onChange={(e) => setRole(e.target.value)} className={field}>
          <option value="">{t.chooseOne}</option>
          {REGISTRANT_ROLES.map((k) => (
            <option key={k} value={k}>{t.roles[k]}</option>
          ))}
        </select>
        {show("role") && <p className={hint}>{t.yourRole}</p>}
      </div>

      <fieldset>
        <legend className={label}>{t.curricula}</legend>
        <div className="flex flex-wrap gap-2">
          {CURRICULA.map((k) => {
            const on = curricula.includes(k);
            return (
              <button
                key={k}
                type="button"
                onClick={() => toggle(k)}
                aria-pressed={on}
                className={`chip font-sans h-8 px-3 text-sm ${on ? "bg-[#E2F4F1] text-[#0C8175]" : "bg-[#EEF0EC] text-[#5B6470]"}`}
              >
                {t.curriculumOptions[k]}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <label className={label} htmlFor="phone">{t.phone}</label>
          <input id="phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} className={field} autoComplete="tel" maxLength={40} />
        </div>
        <div>
          <label className={label} htmlFor="heardFrom">{t.heardFrom}</label>
          <input id="heardFrom" value={heardFrom} onChange={(e) => setHeardFrom(e.target.value)} className={field} maxLength={80} />
        </div>
      </div>

      <label className="flex items-start gap-2 text-sm text-[#14181F]">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1" />
        <span>
          <Consent
            text={t.consent}
            terms={{ href: `${legalBase}/terms`, label: t.termsLabel }}
            privacy={{ href: `${legalBase}/privacy`, label: t.privacyLabel }}
          />
        </span>
      </label>
      {show("consent") && <p className={hint}>{t.consentRequired}</p>}

      {siteKey && (
        <div>
          <Turnstile siteKey={siteKey} action={TURNSTILE_ACTION} onToken={onToken} />
          {show("captcha") && <p className={hint}>{t.captchaRequired}</p>}
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      <button type="submit" disabled={busy} className="btn-primary w-full h-11">
        {busy ? t.creating : t.submit}
      </button>
    </form>
  );
}
