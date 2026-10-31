// The gap tracker's phrase net (signal D): first-person "I can't …" in every
// UI language, and quiet on ordinary answers, clarifying questions and "you
// can't". Run: node node_modules/vitest/vitest.mjs run src/sk/gaps
import { describe, expect, it } from "vitest";
import { cantPhrase, normalizeReply } from "../phrases";
import { CLAIM_CANT } from "@/sk/shell/action-claims";
import { ACT_LINES } from "@/sk/shell/act-core";
import { SK_NOTHING_ON_THAT, SK_CANNOT_CONFIRM } from "@/sk/shell/types";

describe("cantPhrase — catches", () => {
  it.each(Object.entries(CLAIM_CANT))("SK's own 'I can't do that from here' (%s)", (_lang, line) => {
    expect(cantPhrase(line)).not.toBeNull();
  });

  it("SK's fixed English lines", () => {
    for (const line of [SK_NOTHING_ON_THAT, SK_CANNOT_CONFIRM, ACT_LINES.refused]) expect(cantPhrase(line)).not.toBeNull();
  });

  it.each([
    ["en", "Sorry, I cannot send emails to parents."],
    ["en", "I’m unable to change a grade once it is released."],
    ["en", "I don't have access to attendance records."],
    ["en", "That report isn't available yet."],
    ["en", "I couldn't find a class called 9C."],
    ["ms", "Maaf, saya tidak dapat menghantar e-mel kepada ibu bapa."],
    ["ms", "Saya tiada maklumat tentang kehadiran."],
    ["ms", "Laporan itu tidak tersedia lagi."],
    ["ms-arab", "مااف، ساي تيدق داڤت مڠهنتر اي-ميل."],
    ["ar", "عذرًا، لا أستطيع إرسال بريد إلكتروني."],
    ["ar", "ليس لديّ وصول إلى سجلات الحضور."],
    ["ar", "هذا التقرير غير متاح حاليًا."],
    ["fr", "Désolé, je ne peux pas envoyer de courriel."],
    ["fr", "Je n’ai pas accès aux présences."],
    ["fr", "Ce rapport n'est pas encore disponible."],
    ["es", "Lo siento, no puedo enviar correos."],
    ["es", "No tengo acceso a la asistencia."],
    ["es", "Ese informe no está disponible."],
    ["pt", "Desculpe, não consigo enviar e-mails."],
    ["pt", "Não tenho acesso às presenças."],
    ["pt", "Esse relatório não está disponível."],
    ["hi", "माफ़ कीजिए, मैं ईमेल नहीं भेज सकता, यह मैं नहीं कर सकता।"],
    ["hi", "मेरे पास उपस्थिति की जानकारी नहीं है।"],
    ["hi", "यह रिपोर्ट अभी उपलब्ध नहीं है।"],
    ["mr", "मी ईमेल पाठवू शकत नाही."],
    ["mr", "हा अहवाल उपलब्ध नाही."],
    ["te", "నేను ఈమెయిల్ పంపలేను."],
    ["te", "ఆ నివేదిక అందుబాటులో లేదు."],
    ["zh", "抱歉，我无法发送电子邮件。"],
  ])("%s: %s", (_lang, text) => {
    expect(cantPhrase(text)).not.toBeNull();
  });

  it("names the language and the matched words", () => {
    expect(cantPhrase("Sorry — I can't do that.")).toEqual({ lang: "en", match: "i can't" });
    expect(cantPhrase("Maaf, saya tidak dapat.")).toMatchObject({ lang: "ms" });
  });
});

describe("cantPhrase — stays quiet", () => {
  it.each([
    "",
    "Opening the Library.",
    "7B has 31 learners; 4 have not handed in the worksheet.",
    "Do you mean 7B or 7C?",
    "I don't know which class you mean — 7B or 7C?",
    "You can't edit a released grade, but you can add a comment.",
    "Here is chapter 3: osmosis moves water across a membrane.",
    "Saya boleh membuka Perpustakaan untuk anda.",
    "Baik, membuka Papan Kelas.",
    "يمكنني فتح المكتبة لك.",
    "Je peux ouvrir la bibliothèque.",
    "Puedo abrir la biblioteca.",
    "Posso abrir a biblioteca.",
    "मैं लाइब्रेरी खोल रहा हूँ।",
    "मी ग्रंथालय उघडत आहे.",
    "నేను లైబ్రరీని తెరుస్తున్నాను.",
    "我可以帮你打开图书馆。",
  ])("%s", (text) => {
    expect(cantPhrase(text)).toBeNull();
  });

  it("null and undefined are not phrases", () => {
    expect(cantPhrase(null)).toBeNull();
    expect(cantPhrase(undefined)).toBeNull();
  });
});

describe("normalizeReply", () => {
  it("folds case, apostrophes, Arabic hamza forms and diacritics", () => {
    expect(normalizeReply("I CAN’T")).toBe("i can't");
    expect(normalizeReply("لا أستطيعُ")).toBe("لا استطيع");
  });
});
