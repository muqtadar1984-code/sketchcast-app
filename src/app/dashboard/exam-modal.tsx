"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/utils/supabase/client";

function NumberRow({
  label,
  value,
  set,
}: {
  label: string;
  value: number;
  set: (n: number) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-sm text-[#2C2A26]">{label}</span>
      <input
        type="number"
        min={0}
        max={20}
        value={value}
        onChange={(e) => set(Math.max(0, Math.min(20, parseInt(e.target.value || "0", 10))))}
        className="w-16 h-8 px-2 rounded-lg border border-[#EBE3D3] text-sm text-right outline-none focus:border-[#2E6B4E]"
      />
    </div>
  );
}

// Opens a question-mix dialog and queues an exam_paper generation with params.
export default function ExamModal({
  bookId,
  schoolId,
  chapterRef,
  label = "+ Exam",
}: {
  bookId: string;
  schoolId: string | null;
  chapterRef: number | string;
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fill, setFill] = useState(5);
  const [tf, setTf] = useState(5);
  const [match, setMatch] = useState(4);
  const [subj, setSubj] = useState(3);
  const [answerKey, setAnswerKey] = useState(true);

  async function submit() {
    if (fill + tf + match + subj === 0) {
      setError("Add at least one question.");
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setError("Not signed in.");
      setBusy(false);
      return;
    }
    const params = {
      objective: { fill_blank: fill, true_false: tf, match_column: match },
      subjective: subj,
      include_answer_key: answerKey,
    };
    const { error: gErr } = await supabase.from("generations").insert({
      kind: "exam_paper",
      book_id: bookId,
      owner_id: user.id,
      school_id: schoolId,
      chapter_ref: String(chapterRef),
      params,
      status: "queued",
    });
    setBusy(false);
    if (gErr) {
      setError(gErr.message);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-[#2E6B4E] hover:underline whitespace-nowrap"
      >
        {label}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !busy && setOpen(false)}
        >
          <div
            className="bg-white rounded-xl border border-[#EBE3D3] p-5 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-medium mb-1" style={{ fontFamily: "Georgia, serif" }}>
              Exam paper — question mix
            </h3>
            <p className="text-xs font-medium text-[#6F6A5F] mt-3 mb-1">Objective</p>
            <NumberRow label="Fill in the blanks" value={fill} set={setFill} />
            <NumberRow label="True / False" value={tf} set={setTf} />
            <NumberRow label="Match the columns" value={match} set={setMatch} />
            <p className="text-xs font-medium text-[#6F6A5F] mt-3 mb-1">Subjective</p>
            <NumberRow label="Long-answer questions" value={subj} set={setSubj} />
            <label className="flex items-center gap-2 mt-3 text-sm text-[#2C2A26]">
              <input
                type="checkbox"
                checked={answerKey}
                onChange={(e) => setAnswerKey(e.target.checked)}
              />
              Include answer key
            </label>
            {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setOpen(false)}
                disabled={busy}
                className="h-9 px-3 rounded-lg border border-[#EBE3D3] text-sm hover:bg-[#FBF8F1]"
              >
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={busy}
                className="h-9 px-4 rounded-lg bg-[#2E6B4E] text-white text-sm font-medium hover:bg-[#255A41] disabled:opacity-50"
              >
                {busy ? "Starting…" : "Generate exam"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
