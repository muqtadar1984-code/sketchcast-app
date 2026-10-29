// SK Shell — answering the greeting's offer (S2 job tray, "the next greeting").
//
// When the greeting leads with "Your kit for Specialised Cells is ready — want
// me to open it?", the signed memory carries an `offer` (memory.ts SkOffer)
// for exactly ONE turn. This module decides whether that turn's words answer
// it: "yes" / "open it" / "ya, buka" / "نعم" → open; "no" / "not now" /
// "tidak" / "لا" → decline; anything else → not an answer (the turn runs as
// usual and the offer lapses). PURE: text in, verdict out. The rules router's
// bare-ack reply ("Nothing is waiting on an answer") is what a "yes" got
// before, so the route asks this first whenever an offer is pending.

export type OfferAnswer = "yes" | "no" | null;

const YES = [
  "yes",
  "yeah",
  "yep",
  "yup",
  "ok",
  "okay",
  "sure",
  "please",
  "yes please",
  "go ahead",
  "do it",
  "open it",
  "open",
  "open the kit",
  "open my kit",
  "open the kit please",
  "open that",
  "open it please",
  "please open it",
  "yes open it",
  "show me",
  "show it",
  "take me there",
  "ya",
  "boleh",
  "baik",
  "buka",
  "bukakan",
  "buka ia",
  "ya buka",
  "ya bukakan",
  "boleh buka",
  "نعم",
  "أجل",
  "اجل",
  "حسنا",
  "حسناً",
  "تمام",
  "افتح",
  "افتحها",
  "افتحه",
  "نعم افتحها",
  "نعم افتحه",
  "oui",
  "sí",
  "si",
  "sim",
];

const NO = ["no", "nope", "no thanks", "no thank you", "not now", "later", "not yet", "tidak", "tak", "tak payah", "nanti", "bukan sekarang", "لا", "لا شكرا", "ليس الآن", "ليس الان", "non", "não", "nao"];

function norm(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFC")
    .replace(/[.,!?؟،。]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function offerAnswer(text: string): OfferAnswer {
  const t = norm(text);
  if (!t || t.length > 40) return null;
  if (YES.includes(t)) return "yes";
  if (NO.includes(t)) return "no";
  return null;
}
