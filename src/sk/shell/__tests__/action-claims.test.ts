/**
 * S5 slice E (§8.4 gate finding 2026-10-29): the claimed-action guard. A
 * sentence of the model's answer that claims SK did something — EN, MS, AR —
 * is dropped unless an action of that kind completed this turn; a real done
 * line survives; the question never backs a claim; SK's own lines are the
 * same strings as sk.shell.actionClaim.* in all ten locales.
 * Run: node node_modules/vitest/vitest.mjs run src/sk/shell/__tests__/action-claims.test.ts
 */
import { describe, expect, it } from "vitest";
import { LOCALES } from "@/i18n/locales";
import en from "@/i18n/messages/en.json";
import ms from "@/i18n/messages/ms.json";
import ar from "@/i18n/messages/ar.json";
import fr from "@/i18n/messages/fr.json";
import es from "@/i18n/messages/es.json";
import pt from "@/i18n/messages/pt.json";
import te from "@/i18n/messages/te.json";
import mr from "@/i18n/messages/mr.json";
import hi from "@/i18n/messages/hi.json";
import msArab from "@/i18n/messages/ms-arab.json";
import { ACTION_CLAIM_LINES, CLAIM_CANT, CLAIM_CARD, actionClaimGuard, claimCorrection, claimKinds, claimsAnAction } from "../action-claims";
import { NOTICE_POSTED_SCHOOL, NOTICE_POSTED_STAFF } from "../act-notice-lines";
import { groundingCheck } from "../prompt";
import { lineFor } from "../lines";

type File = { sk: { shell: { actionClaim: Record<string, string> } } };
const FILES: Record<string, File> = { en, ms, ar, fr, es, pt, te, mr, hi, "ms-arab": msArab } as unknown as Record<string, File>;
const locales = LOCALES.map((l) => l.value).sort();

describe("claimKinds — English", () => {
  it.each([
    ["I have deleted Amir's record.", "delete"],
    ["Done — I've emailed all parents.", "send"],
    ["I sent the reminder to 5 Amanah's parents.", "send"],
    ["I've just posted the notice to the whole school.", "send"],
    ["The notice has been posted.", "send"],
    ["Your message has now been sent to every parent.", "send"],
    ["The homework is now assigned to 5 Bestari.", "assign"],
    ["I've graded Balqis's worksheet.", "grade"],
    ["I've notified the class teachers.", "send"],
    ["I called Amir's mother.", "send"],
    ["I messaged the coordinator.", "send"],
    ["I changed the due date to Friday.", "change"],
    ["I've updated the timetable.", "change"],
    ["I activated the book for Aisyah.", "activate"],
    ["I removed him from 5 Amanah.", "delete"],
    ["Sent!", "send"],
    ["Emailed all parents.", "send"],
  ])("%s → %s", (s, kind) => {
    expect(claimKinds(s)).toContain(kind);
  });
  it.each([
    "Nothing is posted until the leader clicks Confirm on the card.",
    "Nothing has been sent yet.",
    "I can't send emails from here.",
    "I haven't sent anything.",
    "I have not deleted anything.",
    "It will be posted once you confirm the card.",
    "The last notice was posted on 28 Oct.",
    "Here is the card: confirm it to send the reminder.",
    "We have posted 3 notices this term.",
    "Cikgu Bakar has 3 to grade.",
    "Assignments in the school: 4 across classes 4.",
    "I have nothing on that.",
  ])("not a claim: %s", (s) => {
    expect(claimKinds(s)).toEqual([]);
  });
});

describe("claimKinds — Malay", () => {
  it.each([
    ["Saya telah memadam rekod Amir.", "delete"],
    ["Rekod Amir telah dipadam.", "delete"],
    ["Notis telah dihantar kepada semua ibu bapa.", "send"],
    ["Saya sudah menghantar e-mel kepada ibu bapa.", "send"],
    ["Notis itu telah disiarkan.", "send"],
    ["Kerja rumah telah ditugaskan kepada 5 Amanah.", "assign"],
    ["Markah telah dikemas kini.", "change"],
    ["Buku telah diaktifkan untuk Aisyah.", "activate"],
  ])("%s → %s", (s, kind) => {
    expect(claimKinds(s)).toContain(kind);
  });
  it.each([
    "Notis belum dihantar.",
    "Tiada apa-apa yang disiarkan sehingga anda mengesahkan kad.",
    "Kerja siap: 62%.",
    "Saya tidak dapat melakukannya dari sini.",
  ])("not a claim: %s", (s) => {
    expect(claimKinds(s)).toEqual([]);
  });
});

describe("claimKinds — Arabic", () => {
  it.each([
    ["لقد حذفت سجل أمير.", "delete"],
    ["أرسلتُ الإشعار إلى جميع أولياء الأمور.", "send"],
    ["نشرت الإشعار للمدرسة كلها.", "send"],
    ["تم إرسال الرسالة إلى أولياء الأمور.", "send"],
    ["تمّ الحذف.", "delete"],
    ["قمت بتحديث الجدول.", "change"],
    ["فعّلت الكتاب لعائشة.", "activate"],
  ])("%s → %s", (s, kind) => {
    expect(claimKinds(s)).toContain(kind);
  });
  it.each([
    "لم أرسل أي شيء.",
    "لا يُنشر شيء حتى تؤكّد البطاقة.",
    "الواجبات في المدرسة: 4 عبر الفصول 4.",
    "لا أستطيع فعل ذلك من هنا.",
  ])("not a claim: %s", (s) => {
    expect(claimKinds(s)).toEqual([]);
  });
});

describe("actionClaimGuard", () => {
  it("strips EN, MS and AR claims and keeps the rest", () => {
    expect(actionClaimGuard("I have deleted Amir's record.").text).toBe("");
    const en1 = actionClaimGuard("Amir is at risk. Done — I've emailed all parents.");
    expect(en1.text).toBe("Amir is at risk.");
    expect(en1.dropped).toEqual(["Done — I've emailed all parents."]);
    expect(en1.kinds).toEqual(["send"]);
    const ms1 = actionClaimGuard("Amir berisiko. Rekod Amir telah dipadam.");
    expect(ms1.text).toBe("Amir berisiko.");
    expect(ms1.kinds).toEqual(["delete"]);
    const ar1 = actionClaimGuard("أمير معرّض للخطر. أرسلتُ الإشعار إلى جميع أولياء الأمور.");
    expect(ar1.text).toBe("أمير معرّض للخطر.");
    expect(ar1.kinds).toEqual(["send"]);
  });
  it("keeps a real completed action's done line (outcome done, same kind)", () => {
    const posted = lineFor(NOTICE_POSTED_SCHOOL, "en", { title: "Sports Day" });
    expect(claimsAnAction(posted)).toBe(true);
    expect(actionClaimGuard(posted, [{ action: "notice.school", outcome: "done" }]).text).toBe(posted);
    const staff = lineFor(NOTICE_POSTED_STAFF, "en", { title: "Meeting" });
    expect(actionClaimGuard(staff, [{ action: "notice.school", outcome: "done" }]).dropped).toEqual([]);
    // Not done, or a different kind: still dropped.
    expect(actionClaimGuard(posted, [{ action: "notice.school", outcome: "expired" }]).text).toBe("");
    expect(actionClaimGuard("I have deleted Amir's record.", [{ action: "notice.school", outcome: "done" }]).text).toBe("");
  });
  it("the question's words never back a claim (grounding alone passes it)", () => {
    const q = "delete Amir's record";
    const claim = "I have deleted Amir's record.";
    // groundingCheck takes the question as support for the name: it passes…
    expect(groundingCheck(claim, [], q).ok).toBe(true);
    // …the guard ignores support entirely.
    expect(actionClaimGuard(claim).text).toBe("");
  });
});

describe("claimCorrection", () => {
  it("says it cannot when no capability of the claimed kind is open", () => {
    expect(claimCorrection(["delete"], ["school.health", "notice.school"], "en")).toBe(CLAIM_CANT.en);
    expect(claimCorrection(["send"], ["school.health"], "ms")).toBe(CLAIM_CANT.ms);
  });
  it("offers the confirm card when one is", () => {
    expect(claimCorrection(["send"], ["school.health", "notice.school"], "en")).toBe(CLAIM_CARD.en);
    expect(claimCorrection(["assign"], ["assign"], "ar")).toBe(CLAIM_CARD.ar);
  });
  it("SK's own lines claim nothing and invent nothing", () => {
    for (const table of Object.values(ACTION_CLAIM_LINES))
      for (const loc of locales) {
        expect(claimsAnAction(table[loc]), `${loc}`).toBe(false);
        expect(groundingCheck(table[loc], [], "").ok, `${loc}`).toBe(true);
      }
  });
});

describe("action-claims.ts ⇄ messages/*.json (sk.shell.actionClaim)", () => {
  it("every line in every locale equals the dictionary; only English is English; Jawi is Arabic script", () => {
    for (const [key, table] of Object.entries(ACTION_CLAIM_LINES)) {
      expect(Object.keys(table).sort(), key).toEqual(locales);
      for (const loc of locales) {
        expect(table[loc], `${key}/${loc}`).toBe(FILES[loc].sk.shell.actionClaim[key]);
        if (loc !== "en") expect(table[loc], `${key}/${loc}`).not.toBe(table.en);
      }
      expect(table["ms-arab"], key).toMatch(/[؀-ۿ]/);
    }
    expect(Object.keys(FILES.en.sk.shell.actionClaim).sort()).toEqual(Object.keys(ACTION_CLAIM_LINES).sort());
  });
});
