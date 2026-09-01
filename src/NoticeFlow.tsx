import React, { useState, useRef } from "react";

// ─── Config ────────────────────────────────────────────────────────────
const API_BASE = "https://noticeiq-api.iotcsales.workers.dev";
const LICENSE_API = "https://iotc-license-check.iotcsales.workers.dev";

// ─── Types ──────────────────────────────────────────────────────────────

type NoticeType = "GSTR-3A" | "ASMT-10" | "DRC-01" | "REG-17" | "UNKNOWN";
type Urgency = "red" | "amber" | "neutral";
type AnswerValue = "yes" | "no" | "fully" | "partially";
type Screen = "license" | "upload" | "ingesting" | "classifying" | "confirm" | "questions" | "details" | "generating" | "synopsis" | "draft" | "error";

interface BranchQuestion {
  id: string;
  text: string;
  type: "yes_no" | "select";
  options?: AnswerValue[];
  showIf?: { q1: AnswerValue };
}

interface ClassifyResult {
  notice_type: NoticeType;
  confidence: number;
  notice_number: string | null;
  notice_date: string | null;
  explicit_deadline_date: string | null;
  gstin: string | null;
  tax_period: string | null;
  demand_amount: number | null;
  discrepancy_summary: string | null;
  cancellation_ground: string | null;
  requiresManualConfirm: boolean;
}

interface DraftApiResult {
  success: boolean;
  error: string | null;
  draftText: string | null;
  sectionCitation: string | null;
  synopsis: {
    noticeTypeLabel: string;
    whatThisIs: string;
    whatWereTelling: string;
    deadlineLine: string;
    urgencyLevel: Urgency;
    consequenceIfMissed: string;
    branchSelected: string;
    deadlineWarning: string | null;
  } | null;
  checklist: { id: string; text: string }[] | null;
  calc: { daysRemaining: number; urgencyLevel: Urgency; deadlineDate: string } | null;
}

// ─── Branch questions + routing — identical to classify.js ────────────────

const BRANCH_QUESTIONS: Record<Exclude<NoticeType, "UNKNOWN">, BranchQuestion[]> = {
  "GSTR-3A": [
    { id: "q1", text: "Have you already filed the return this notice refers to?", type: "yes_no" },
    { id: "q2", text: "Is there a specific reason for the delay?", type: "yes_no", showIf: { q1: "no" } },
  ],
  "ASMT-10": [
    { id: "q1", text: "Do you agree with the discrepancy flagged?", type: "select", options: ["yes", "no", "partially"] },
    { id: "q2", text: "Do you have documents that explain the discrepancy?", type: "yes_no", showIf: { q1: "no" } },
  ],
  "DRC-01": [{ id: "q1", text: "Do you agree with the tax demand?", type: "select", options: ["fully", "partially", "no"] }],
  "REG-17": [
    { id: "q1", text: "Is the ground for cancellation factually accurate?", type: "yes_no" },
    { id: "q2", text: "Is it something you can fix now?", type: "yes_no", showIf: { q1: "no" } },
  ],
};

function resolveBranch(noticeType: NoticeType, answers: Record<string, AnswerValue>): "A" | "B" | "C" | null {
  switch (noticeType) {
    case "GSTR-3A":
      if (answers.q1 === "yes") return "A";
      if (answers.q1 === "no" && answers.q2 === "no") return "B";
      if (answers.q1 === "no" && answers.q2 === "yes") return "C";
      break;
    case "ASMT-10":
      if (answers.q1 === "yes") return "B";
      if (answers.q1 === "no" && answers.q2 === "yes") return "A";
      if (answers.q1 === "partially") return "C";
      break;
    case "DRC-01":
      if (answers.q1 === "no") return "A";
      if (answers.q1 === "partially") return "B";
      if (answers.q1 === "fully") return "C";
      break;
    case "REG-17":
      if (answers.q1 === "no" && answers.q2 === "no") return "C";
      if (answers.q1 === "yes") return "B";
      if (answers.q1 === "no") return "A";
      break;
  }
  return null;
}

// Fields Draft templates need that Classify can never extract — only the
// user knows these (what they did, why, what evidence they have). Ported
// from templates.js's requiredVars, minus whatever's auto-filled from
// Classify output (noticeNumber, noticeDate, period, gstin, demandAmount).
interface FieldDef { id: string; label: string; placeholder?: string; type?: "text" | "date" | "number" | "textarea" }

const MANUAL_FIELDS: Record<string, FieldDef[]> = {
  "GSTR-3A:A": [
    { id: "returnType", label: "Which return was this notice about?", placeholder: "e.g. GSTR-3B" },
    { id: "filingDate", label: "Date you actually filed it", type: "date" },
    { id: "arn", label: "ARN from that filing" },
  ],
  "GSTR-3A:B": [
    { id: "returnType", label: "Which return is this notice about?", placeholder: "e.g. GSTR-3B" },
    { id: "delayReason", label: "Reason for the delay",placeholder: "e.g. server downtime prevented timely filing", type: "textarea" },
    { id: "commitDays", label: "Days you're committing to file within", type: "number" },
  ],
  "GSTR-3A:C": [
    { id: "returnType", label: "Which return is this notice about?", placeholder: "e.g. GSTR-3B" },
    { id: "hardshipDetail", label: "Describe the hardship / reason for delay", placeholder: "e.g. sudden hospitalization of the accountant handling filings", type: "textarea" },
  ],
  "ASMT-10:A": [
    { id: "pointRef", label: "Which point in the notice? (e.g. 'Point 1')" },
    { id: "explanationReason", label: "Why the discrepancy is explainable", type: "textarea" },
  ],
  "ASMT-10:B": [
    { id: "pointRef", label: "Which point in the notice?" },
    { id: "diffAmount", label: "Differential tax amount paid (₹)", type: "number" },
    { id: "challanRef", label: "Payment challan reference" },
    { id: "paymentDate", label: "Date paid", type: "date" },
  ],
  "ASMT-10:C": [
    { id: "pointA", label: "Point you're explaining" },
    { id: "explanationA", label: "Your explanation for that point", type: "textarea" },
    { id: "pointB", label: "Point you're accepting" },
    { id: "diffAmount", label: "Differential tax amount paid (₹)", type: "number" },
    { id: "challanRef", label: "Payment challan reference" },
    { id: "paymentDate", label: "Date paid", type: "date" },
  ],
  "DRC-01:A": [
    { id: "sectionNum", label: "Section cited (73 or 74)", placeholder: "73" },
    { id: "grounds", label: "Grounds for contesting the demand", type: "textarea" },
  ],
  "DRC-01:B": [
    { id: "sectionNum", label: "Section cited (73 or 74)", placeholder: "73" },
    { id: "acceptedAmount", label: "Amount you're accepting (₹)", type: "number" },
    { id: "challanRef", label: "Payment challan reference" },
    { id: "paymentDate", label: "Date paid", type: "date" },
    { id: "contestedAmount", label: "Amount you're contesting (₹)", type: "number" },
    { id: "grounds", label: "Grounds for contesting the remainder", type: "textarea" },
  ],
  "DRC-01:C": [
    { id: "sectionNum", label: "Section cited (73 or 74)", placeholder: "73" },
    { id: "hardshipReason", label: "Reason for requesting a payment plan", type: "textarea" },
  ],
  "REG-17:A": [{ id: "evidenceDetail", label: "Evidence that the ground is incorrect", type: "textarea" }],
  "REG-17:B": [
    { id: "correctiveAction", label: "What corrective action you took", type: "textarea" },
    { id: "correctionDate", label: "Date you completed it", type: "date" },
  ],
  "REG-17:C": [
    { id: "procedureIssue", label: "Describe the procedural issue (e.g. notice not received)", type: "textarea" },
    { id: "updatedAddress", label: "Your updated correspondence address", type: "textarea" },
  ],
};

const URGENCY_STYLES: Record<Urgency, { ring: string; tint: string; label: string }> = {
  red: { ring: "#A6402F", tint: "#F6E9E7", label: "Urgent" },
  amber: { ring: "#B8862E", tint: "#F7EFDF", label: "Coming up" },
  neutral: { ring: "#6B7A6F", tint: "#EDEFEC", label: "On track" },
};

const SUPPORTED_TYPES: Exclude<NoticeType, "UNKNOWN">[] = ["GSTR-3A", "ASMT-10", "DRC-01", "REG-17"];
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const SUPPORTED_MIME = ["image/jpeg", "image/png", "image/webp", "application/pdf"];

// ─── Shared bits ───────────────────────────────────────────────────────

function Logo({ size = 30 }: { size?: number }) {
  return (
    <div className="flex items-center gap-2.5">
      <svg width={size} height={size} viewBox="0 0 200 200">
        <g transform="translate(100,100) rotate(-7)">
          <circle cx="0" cy="0" r="72" fill="none" stroke="#1F5C4F" strokeWidth={7} strokeDasharray="13 9" />
          <circle cx="0" cy="0" r="86" fill="none" stroke="#1F5C4F" strokeWidth={1.5} opacity={0.35} />
          <path d="M -22 -30 L 10 -30 L 22 -18 L 22 30 L -22 30 Z" fill="none" stroke="#1F5C4F" strokeWidth={7} strokeLinejoin="round" />
          <path d="M 10 -30 L 10 -18 L 22 -18" fill="none" stroke="#1F5C4F" strokeWidth={7} strokeLinejoin="round" />
          <path d="M -12 -6 L -3 4 L 15 -16" fill="none" stroke="#1F5C4F" strokeWidth={8} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      </svg>
      <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: size * 0.62, fontWeight: 600, color: "#16221D", letterSpacing: "-0.01em" }}>
        Notice<span style={{ color: "#1F5C4F" }}>IQ</span>
      </span>
    </div>
  );
}

function LiabilityBanner() {
  return (
    <div className="w-full px-4 py-2.5 text-center sticky top-0 z-20" style={{ background: "#16221D", color: "#F1F0EB", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 12.5 }}>
      Filing assistance draft — not legal advice. Review before submission.
    </div>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 11.5, fontWeight: 600, color: "#6B7A6F", textTransform: "uppercase", letterSpacing: "0.06em" }}>
      {children}
    </div>
  );
}

function Spinner({ label }: { label: string }) {
  return (
    <div className="px-5 pt-16 pb-10 max-w-md mx-auto flex flex-col items-center text-center">
      <div
        className="animate-spin rounded-full"
        style={{ width: 44, height: 44, border: "3px solid #D7D3C7", borderTopColor: "#1F5C4F" }}
      />
      <div className="mt-5" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 14.5, color: "#16221D" }}>
        {label}
      </div>
    </div>
  );
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="px-5 pt-12 pb-10 max-w-md mx-auto text-center">
      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 600, color: "#16221D" }} className="mb-3">
        Something went wrong
      </div>
      <p style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 14.5, color: "#16221D" }} className="mb-7">
        {message}
      </p>
      <button
        onClick={onRetry}
        className="py-3 px-6 rounded-sm"
        style={{ background: "#1F5C4F", color: "#F1F0EB", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 14, fontWeight: 600 }}
      >
        Try again
      </button>
    </div>
  );
}

// —— Screen: license ——————————————
function LicenseScreen({ onValidated }: { onValidated: () => void }) {
  const [key, setKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");

  const handleVerify = async () => {
    if (!key.trim()) {
      setError("Please enter your license key.");
      return;
    }
    setChecking(true);
    setError("");
    try {
      const res = await fetch(LICENSE_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "noticeiq", license_key: key.trim() }),
      });
      const data = await res.json();
      if (data.valid) {
        localStorage.setItem("noticeiq_license_key", key.trim());
        onValidated();
      } else {
        setError(data.error || "That license key isn't valid. Please check and try again.");
      }
    } catch {
      setError("Couldn't verify your license right now. Please check your connection and try again.");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="px-5 pt-12 pb-10 max-w-md mx-auto text-center">
      <div style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 600, color: "#16221D" }} className="mb-3">
        Enter your license key
      </div>
      <p style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 14.5, color: "#16221D" }} className="mb-5">
        Check your email from Gumroad for your NoticeIQ license key.
      </p>
      <input
        type="text"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX"
        className="w-full py-3 px-4 rounded-sm mb-3"
        style={{ border: "1px solid #6B7A6F", fontFamily: "'IBM Plex Mono', monospace", fontSize: 14 }}
      />
      {error && (
        <p style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 13.5, color: "#A6402F" }} className="mb-3">
          {error}
        </p>
      )}
      <button
        onClick={handleVerify}
        disabled={checking}
        className="py-3 px-6 rounded-sm"
        style={{ background: "#1F5C4F", color: "#F1F0EB", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 14, fontWeight: 600 }}
      >
        {checking ? "Checking..." : "Unlock NoticeIQ"}
      </button>
    </div>
  );
}// ─── Screen: upload ────────────────────────────────────────────────────

function UploadScreen({ onFileReady, onError }: { onFileReady: (base64: string, mimeType: string, sizeBytes: number) => void; onError: (msg: string) => void }) {
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFile = (file: File) => {
    if (!SUPPORTED_MIME.includes(file.type)) {
      onError("Please upload a JPEG, PNG, WebP, or PDF file.");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      onError(`File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max size is 20MB.`);
      return;
    }

    // PDFs pass through unchanged — compression below is images only.
    if (file.type === "application/pdf") {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.split(",")[1] ?? "";
        onFileReady(base64, file.type, file.size);
      };
      reader.onerror = () => onError("Couldn't read that file. Please try again.");
      reader.readAsDataURL(file);
      return;
    }

    // Images: downscale + recompress via canvas before upload. This keeps
    // the payload small and consistent regardless of the original photo's
    // resolution or camera-specific encoding quirks.
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const MAX_DIMENSION = 1600;
      let { width, height } = img;
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        const scale = MAX_DIMENSION / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        onError("Couldn't process that image. Please try again.");
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            onError("Couldn't process that image. Please try again.");
            return;
          }
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result as string;
            const base64 = result.split(",")[1] ?? "";
            onFileReady(base64, "image/jpeg", blob.size);
          };
          reader.onerror = () => onError("Couldn't read that file. Please try again.");
          reader.readAsDataURL(blob);
        },
        "image/jpeg",
        0.8
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      onError("Couldn't read that file. Please try again.");
    };
    img.src = objectUrl;
  };

  return (
    <div className="px-5 pt-10 pb-12 max-w-md mx-auto">
      <Eyebrow>Step 1 of 4</Eyebrow>
      <h1 className="mt-2 mb-3" style={{ fontFamily: "'Fraunces', serif", fontSize: 26, fontWeight: 600, color: "#16221D", lineHeight: 1.3 }}>
        Upload your notice
      </h1>
      <p style={{ fontFamily: "Georgia, serif", fontSize: 15, color: "#16221D", lineHeight: 1.55 }} className="mb-8">
        A clear photo or PDF of your GSTR-3A, ASMT-10, DRC-01, or REG-17 notice.
      </p>

      <div className="flex flex-col gap-3">
        <button
          onClick={() => cameraInputRef.current?.click()}
          className="w-full py-6 rounded-sm flex items-center justify-center gap-3"
          style={{ border: "1.5px dashed #1F5C4F", background: "#FCFBF8" }}
        >
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="#1F5C4F" strokeWidth={1.5}>
            <path d="M4 7h3l1.5-2h7L17 7h3a1 1 0 011 1v11a1 1 0 01-1 1H4a1 1 0 01-1-1V8a1 1 0 011-1z" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="12" cy="13" r="3.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 14.5, fontWeight: 600, color: "#1F5C4F" }}>
            Take a photo
          </span>
        </button>

        <button
          onClick={() => fileInputRef.current?.click()}
          className="w-full py-6 rounded-sm flex items-center justify-center gap-3"
          style={{ border: "1.5px dashed #1F5C4F", background: "#FCFBF8" }}
        >
          <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke="#1F5C4F" strokeWidth={1.5}>
            <path d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 9l5-5 5 5M12 4v13" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 14.5, fontWeight: 600, color: "#1F5C4F" }}>
            Choose from photos or files
          </span>
        </button>
      </div>
      <div className="mt-3 text-center" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 12, color: "#6B7A6F" }}>
        JPEG, PNG, WebP, or PDF · up to 20MB
      </div>

      {/* Camera capture — capture attribute forces the device camera to
          open directly. Kept on a separate input from the picker below,
          since combining them on one <input> makes some mobile browsers
          (notably Android Chrome) skip the photo-library option entirely
          and jump straight to the camera. */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />

      {/* Photo library / file picker — no capture attribute, so the
          browser shows its normal picker (camera roll, files, cloud
          storage) instead of forcing the camera. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
        }}
      />
    </div>
  );
}

// ─── Screen: confirm classification ────────────────────────────────────

function ConfirmScreen({
  result,
  onConfirm,
  onSelectType,
}: {
  result: ClassifyResult;
  onConfirm: () => void;
  onSelectType: (type: Exclude<NoticeType, "UNKNOWN">) => void;
}) {
  const [showPicker, setShowPicker] = useState(result.notice_type === "UNKNOWN");
  const pct = Math.round(result.confidence * 100);
  const isUnknown = result.notice_type === "UNKNOWN";

  return (
    <div className="px-5 pt-8 pb-10 max-w-md mx-auto">
      <Eyebrow>Step 2 of 4 · Confirm what we found</Eyebrow>
      <h1 className="mt-2 mb-6" style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 600, color: "#16221D", lineHeight: 1.3 }}>
        {isUnknown ? "We couldn't confidently identify this notice" : `We think this is a ${result.notice_type}`}
      </h1>

      {!isUnknown && (
        <div className="p-4 rounded-sm mb-6" style={{ background: "#FCFBF8", border: "1px solid #D7D3C7" }}>
          <div className="flex items-center justify-between mb-1">
            <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 13, color: "#6B7A6F" }}>Confidence</span>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: "#16221D" }}>{pct}%</span>
          </div>
          <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: "#EDEFEC" }}>
            <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct >= 75 ? "#1F5C4F" : "#B8862E" }} />
          </div>
        </div>
      )}

      {result.discrepancy_summary && (
        <p style={{ fontFamily: "Georgia, serif", fontSize: 15, color: "#16221D", lineHeight: 1.6 }} className="mb-8">
          {result.discrepancy_summary}
        </p>
      )}

      {!showPicker ? (
        <div className="flex flex-col gap-3">
          <button onClick={onConfirm} className="w-full py-3.5 rounded-sm" style={{ background: "#1F5C4F", color: "#F1F0EB", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 15, fontWeight: 600 }}>
            Yes, that's right →
          </button>
          <button onClick={() => setShowPicker(true)} className="w-full py-2 underline underline-offset-2" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 13, color: "#6B7A6F" }}>
            No, choose a different notice type
          </button>
        </div>
      ) : (
        <div>
          <div style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 13.5, color: "#16221D" }} className="mb-3">
            Select the correct notice type:
          </div>
          <div className="grid grid-cols-2 gap-2 mb-4">
            {SUPPORTED_TYPES.map((t) => (
              <button
                key={t}
                onClick={() => onSelectType(t)}
                className="py-2.5 rounded-sm"
                style={{
                  border: `1.5px solid ${t === result.notice_type ? "#1F5C4F" : "#D7D3C7"}`,
                  background: t === result.notice_type ? "#1F5C4F" : "transparent",
                  color: t === result.notice_type ? "#F1F0EB" : "#16221D",
                  fontFamily: "'IBM Plex Mono', monospace",
                  fontSize: 13,
                }}
              >
                {t}
              </button>
            ))}
          </div>
          <div style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 12, color: "#6B7A6F" }}>
            This tool currently only supports GST notices — GSTR-3A, ASMT-10, DRC-01, and REG-17.
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Screen: branch Q&A ────────────────────────────────────────────────

function QuestionsScreen({ noticeType, onResolved }: { noticeType: Exclude<NoticeType, "UNKNOWN">; onResolved: (branch: "A" | "B" | "C") => void }) {
  const questions = BRANCH_QUESTIONS[noticeType];
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const visibleQuestions = questions.filter((q) => !q.showIf || answers[Object.keys(q.showIf)[0]] === Object.values(q.showIf)[0]);

  const answer = (qId: string, val: AnswerValue) => {
    const next = { ...answers, [qId]: val };
    setAnswers(next);
    const branch = resolveBranch(noticeType, next);
    if (branch) onResolved(branch);
  };

  return (
    <div className="px-5 pt-8 pb-10 max-w-md mx-auto">
      <Eyebrow>Step 3 of 4 · a couple of quick questions</Eyebrow>
      <h1 className="mt-2 mb-7" style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 600, color: "#16221D", lineHeight: 1.3 }}>
        This decides which response we draft
      </h1>
      {visibleQuestions.map((q) => (
        <div key={q.id} className="mb-6">
          <div style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 15.5, color: "#16221D", marginBottom: 10 }}>{q.text}</div>
          <div className="flex flex-wrap gap-2">
            {(q.options ?? (["yes", "no"] as AnswerValue[])).map((opt) => (
              <button
                key={opt}
                onClick={() => answer(q.id, opt)}
                className="px-4 py-2 rounded-sm capitalize"
                style={{
                  border: `1.5px solid ${answers[q.id] === opt ? "#1F5C4F" : "#D7D3C7"}`,
                  background: answers[q.id] === opt ? "#1F5C4F" : "transparent",
                  color: answers[q.id] === opt ? "#F1F0EB" : "#16221D",
                  fontFamily: "'IBM Plex Sans', sans-serif",
                  fontSize: 14,
                  fontWeight: 500,
                }}
              >
                {opt}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Screen: additional details (facts only the user knows) ───────────

function DetailsScreen({
  noticeType,
  branch,
  onSubmit,
  initialValues,
}: {
  noticeType: Exclude<NoticeType, "UNKNOWN">;
  branch: "A" | "B" | "C";
  onSubmit: (vars: Record<string, string>) => void;
  initialValues?: Record<string, string>;
}) {
  const fields = MANUAL_FIELDS[`${noticeType}:${branch}`] ?? [];
  const [values, setValues] = useState<Record<string, string>>(initialValues ?? {});
  const allFilled = fields.every((f) => (values[f.id] ?? "").trim().length > 0);

  return (
    <div className="px-5 pt-8 pb-12 max-w-md mx-auto">
      <Eyebrow>Step 4 of 4 · a few more details</Eyebrow>
      <h1 className="mt-2 mb-7" style={{ fontFamily: "'Fraunces', serif", fontSize: 24, fontWeight: 600, color: "#16221D", lineHeight: 1.3 }}>
        Facts only you know
      </h1>
      <div className="space-y-5 mb-8">
        {fields.map((f) => (
          <div key={f.id}>
            <label style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 13.5, color: "#16221D", display: "block", marginBottom: 6 }}>
              {f.label}
            </label>
            {f.type === "textarea" ? (
              <textarea
                rows={3}
                value={values[f.id] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                placeholder={f.placeholder}
                className="w-full p-3 rounded-sm"
                style={{ border: "1px solid #D7D3C7", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 14, color: "#16221D", background: "#FCFBF8" }}
              />
            ) : (
              <input
                type={f.type === "date" ? "date" : f.type === "number" ? "number" : "text"}
                value={values[f.id] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
                placeholder={f.placeholder}
                className="w-full p-3 rounded-sm"
                style={{ border: "1px solid #D7D3C7", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 14, color: "#16221D", background: "#FCFBF8" }}
              />
            )}
          </div>
        ))}
      </div>
      <button
        disabled={!allFilled}
        onClick={() => onSubmit(values)}
        className="w-full py-3.5 rounded-sm"
        style={{ background: allFilled ? "#1F5C4F" : "#B9BFB9", color: "#F1F0EB", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 15, fontWeight: 600, cursor: allFilled ? "pointer" : "not-allowed" }}
      >
        Generate draft response →
      </button>
    </div>
  );
}

// ─── Screen: synopsis (from live /api/draft response) ─────────────────

function SynopsisScreen({ draft, onContinue, onSkip }: { draft: DraftApiResult; onContinue: () => void; onSkip: () => void }) {
  if (!draft.synopsis || !draft.calc) return null;
  const s = URGENCY_STYLES[draft.synopsis.urgencyLevel];
  return (
    <div className="px-5 pt-8 pb-10 max-w-md mx-auto">
      <h1 className="mt-2 mb-6" style={{ fontFamily: "'Fraunces', serif", fontSize: 27, fontWeight: 600, color: "#16221D", lineHeight: 1.25 }}>
        What this notice means
      </h1>
      <div className="flex items-start gap-4 mb-7">
        <div
          className="inline-flex flex-col items-center justify-center shrink-0"
          style={{ width: 148, height: 148, borderRadius: "50%", border: `3px dashed ${s.ring}`, transform: "rotate(-7deg)", background: s.tint, color: s.ring }}
        >
          <span style={{ fontFamily: "'Fraunces', serif", fontSize: 44, fontWeight: 600, lineHeight: 1 }}>{draft.calc.daysRemaining}</span>
          <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 4 }}>days left</span>
        </div>
        <div className="pt-1">
          <div style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 12, fontWeight: 600, color: s.ring, textTransform: "uppercase" }}>{s.label}</div>
          <div className="mt-1" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 14.5, color: "#16221D" }}>{draft.synopsis.deadlineLine}</div>
        </div>
      </div>
      {draft.synopsis.deadlineWarning && (
        <div className="mb-6 p-3 rounded-sm" style={{ background: "#F7EFDF", border: "1px solid #B8862E33" }}>
          <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 13, color: "#16221D" }}>{draft.synopsis.deadlineWarning}</span>
        </div>
      )}
      <dl className="space-y-5">
        <div><Eyebrow>What this notice is</Eyebrow><dd className="mt-1" style={{ fontFamily: "Georgia, serif", fontSize: 15.5, color: "#16221D", lineHeight: 1.5 }}>{draft.synopsis.whatThisIs}</dd></div>
        <div><Eyebrow>What we're telling them</Eyebrow><dd className="mt-1" style={{ fontFamily: "Georgia, serif", fontSize: 15.5, color: "#16221D", lineHeight: 1.5 }}>{draft.synopsis.branchSelected}</dd></div>
        <div><Eyebrow>If you miss it</Eyebrow><dd className="mt-1" style={{ fontFamily: "Georgia, serif", fontSize: 15.5, color: "#16221D", lineHeight: 1.5 }}>{draft.synopsis.consequenceIfMissed}</dd></div>
      </dl>
      <div className="mt-9 flex flex-col gap-3">
        <button onClick={onContinue} className="w-full py-3.5 rounded-sm" style={{ background: "#1F5C4F", color: "#F1F0EB", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 15, fontWeight: 600 }}>
          Review draft response →
        </button>
        <button onClick={onSkip} className="w-full py-2 underline underline-offset-2" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 13, color: "#6B7A6F" }}>
          Skip, take me straight to the draft
        </button>
      </div>
    </div>
  );
}

// ─── Screen: draft + review gate ──────────────────────────────────────

function DraftScreen({ draft, needsAmountCheck, onBack }: { draft: DraftApiResult; needsAmountCheck: boolean; onBack: () => void }) {
  const [checks, setChecks] = useState({ facts: false, key: false, amount: false, understand: false });
  const [copied, setCopied] = useState(false);
  const requiredKeys = needsAmountCheck ? (["facts", "key", "amount", "understand"] as const) : (["facts", "key", "understand"] as const);
  const unlocked = requiredKeys.every((k) => checks[k]);

  if (!draft.draftText || !draft.checklist) return null;

  const toggle = (k: keyof typeof checks) => setChecks((c) => ({ ...c, [k]: !c[k] }));

  const handleCopy = () => {
    if (!unlocked || !draft.draftText) return;
    navigator.clipboard?.writeText(draft.draftText).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleDownload = () => {
    if (!unlocked || !draft.draftText) return;
    const blob = new Blob([draft.draftText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "response-draft.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="px-5 pt-6 pb-12 max-w-md mx-auto">
      <button onClick={onBack} className="mb-4 underline underline-offset-2" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 12.5, color: "#6B7A6F" }}>
        ← back to summary
      </button>
      {draft.sectionCitation && (
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#6B7A6F" }}>{draft.sectionCitation}</div>
      )}
      <h2 className="mt-1 mb-5" style={{ fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 600, color: "#16221D" }}>Draft response</h2>

      <div className="relative overflow-hidden rounded-sm" style={{ background: "#FCFBF8", border: "1px solid #D7D3C7", padding: "28px 22px" }}>
        {!unlocked && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none" style={{ transform: "rotate(-18deg)" }}>
            <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 30, fontWeight: 700, letterSpacing: "0.08em", color: "#16221D", opacity: 0.09, whiteSpace: "nowrap" }}>
              DRAFT · REVIEW REQUIRED
            </span>
          </div>
        )}
        <p className="relative whitespace-pre-line" style={{ fontFamily: "Georgia, serif", fontSize: 15, lineHeight: 1.75, color: "#16221D" }}>
          {draft.draftText}
        </p>
      </div>

      <div className="mt-5 rounded-sm p-4" style={{ background: "#EDEFEC", border: "1px solid #D7D3C7" }}>
        <Eyebrow>Before you can copy or download</Eyebrow>
        <div className="mt-3 space-y-3">
          {draft.checklist.map((item) => {
            const key = item.id.includes("amount") ? "amount" : item.id.includes("understand") ? "understand" : item.id.includes("facts") ? "facts" : "key";
            return (
              <label key={item.id} className="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" checked={checks[key]} onChange={() => toggle(key)} className="mt-0.5 shrink-0" style={{ accentColor: "#1F5C4F", width: 17, height: 17 }} />
                <span style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 13.5, color: "#16221D" }}>{item.text}</span>
              </label>
            );
          })}
        </div>
      </div>

      <div className="mt-5 flex gap-3">
        <button disabled={!unlocked} onClick={handleCopy} className="flex-1 py-3 rounded-sm" style={{ background: unlocked ? "#1F5C4F" : "#B9BFB9", color: "#F1F0EB", fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 14, fontWeight: 600, cursor: unlocked ? "pointer" : "not-allowed" }}>
          {copied ? "Copied ✓" : "Copy draft"}
        </button>
        <button disabled={!unlocked} onClick={handleDownload} className="flex-1 py-3 rounded-sm" style={{ background: "transparent", color: unlocked ? "#1F5C4F" : "#B9BFB9", border: `1.5px solid ${unlocked ? "#1F5C4F" : "#B9BFB9"}`, fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 14, fontWeight: 600, cursor: unlocked ? "pointer" : "not-allowed" }}>
          Download
        </button>
      </div>
      {!unlocked && (
        <div className="mt-2.5 text-center" style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 12, color: "#6B7A6F" }}>
          Complete all checks above to unlock
        </div>
      )}
    </div>
  );
}

// ─── Root ──────────────────────────────────────────────────────────────

export default function NoticeFlow() {
  const [screen, setScreen] = useState<Screen>(() =>
    localStorage.getItem("noticeiq_license_key") ? "upload" : "license"
  );
  const [errorMsg, setErrorMsg] = useState("");
  const [classifyResult, setClassifyResult] = useState<ClassifyResult | null>(null);
  const [noticeType, setNoticeType] = useState<Exclude<NoticeType, "UNKNOWN"> | null>(null);
  const [branch, setBranch] = useState<"A" | "B" | "C" | null>(null);
  const [draftResult, setDraftResult] = useState<DraftApiResult | null>(null);
  const [lastDetailsVars, setLastDetailsVars] = useState<Record<string, string> | undefined>(undefined);
  const [retryScreen, setRetryScreen] = useState<Screen>("upload");

    const goError = (msg: string, target: Screen = "upload") => {
    setErrorMsg(msg);
    setRetryScreen(target);
    setScreen("error");
  };

  const handleFileReady = async (base64: string, mimeType: string, sizeBytes: number) => {
    setScreen("ingesting");
    try {
      const res = await fetch(`${API_BASE}/api/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base64Data: base64, mimeType, sizeBytes }),
      });
      const body = await res.json();
      if (!res.ok || !body.success || body.blocked) {
        goError(body.quality_notes || body.error || "We couldn't read this notice. Please try a clearer photo.");
        return;
      }
      setScreen("classifying");
      const cRes = await fetch(`${API_BASE}/api/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ extractedText: body.extracted_text }),
      });
      const cBody = await cRes.json();
      if (!cRes.ok || !cBody.success) {
        goError(cBody.error || "We couldn't process this notice right now. Please try again.");
        return;
      }
      setClassifyResult(cBody as ClassifyResult);
      setNoticeType(cBody.notice_type !== "UNKNOWN" ? cBody.notice_type : null);
      setScreen("confirm");
    } catch {
      goError("We couldn't process this notice right now. Please try again.");
    }
  };

  const handleSelectType = (type: Exclude<NoticeType, "UNKNOWN">) => {
    setNoticeType(type);
    setScreen("questions");
  };

  const handleBranchResolved = (b: "A" | "B" | "C") => {
    setBranch(b);
    setScreen("details");
  };

  const handleDetailsSubmit = async (manualVars: Record<string, string>) => {
    if (!classifyResult || !noticeType || !branch) return;
    setScreen("generating");
    setLastDetailsVars(manualVars);
    const vars: Record<string, string> = {
      noticeNumber: classifyResult.notice_number ?? "",
      noticeDate: classifyResult.notice_date ?? "",
      period: classifyResult.tax_period ?? "",
      gstin: classifyResult.gstin ?? "",
    demandAmount: classifyResult.demand_amount != null ? String(classifyResult.demand_amount) : "",
    groundStated: classifyResult.cancellation_ground ?? "",
      ...manualVars,
    };
    const amounts =
      noticeType === "DRC-01" && classifyResult.demand_amount != null
        ? {
            demand: classifyResult.demand_amount,
            accepted: manualVars.acceptedAmount ? Number(manualVars.acceptedAmount) : undefined,
            contested: manualVars.contestedAmount ? Number(manualVars.contestedAmount) : undefined,
          }
        : undefined;

    try {
      const res = await fetch(`${API_BASE}/api/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          noticeType,
          branch,
          noticeDate: classifyResult.notice_date,
          explicitDeadline: classifyResult.explicit_deadline_date,
          amounts,
          vars,
        }),
      });
      const body = (await res.json()) as DraftApiResult;
      if (!res.ok || !body.success) {
        goError(body.error || "We couldn't generate the draft right now. Please try again.", "details");
        return;
      }
      setDraftResult(body);
      setScreen("synopsis");
    } catch {
      goError("We couldn't generate the draft right now. Please try again.", "details");
    }
  };

  const needsAmountCheck = noticeType === "DRC-01" && branch === "B";

  return (
    <div style={{ background: "#F1F0EB", minHeight: "100vh" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
        * { -webkit-font-smoothing: antialiased; }
        input:focus-visible, textarea:focus-visible, button:focus-visible { outline: 2px solid #1F5C4F; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }
      `}</style>

      <div className="max-w-md mx-auto px-5 pt-5 pb-1">
        <Logo />
      </div>
      <LiabilityBanner />

      {screen === "license" && <LicenseScreen onValidated={() => setScreen("upload")} />}
      {screen === "upload" && <UploadScreen onFileReady={handleFileReady} onError={goError} />}
      {screen === "ingesting" && <Spinner label="Reading your notice…" />}
      {screen === "classifying" && <Spinner label="Identifying the notice type…" />}
      {screen === "confirm" && classifyResult && (
        <ConfirmScreen result={classifyResult} onConfirm={() => setScreen("questions")} onSelectType={handleSelectType} />
      )}
      {screen === "questions" && noticeType && <QuestionsScreen noticeType={noticeType} onResolved={handleBranchResolved} />}
      {screen === "details" && noticeType && branch && <DetailsScreen noticeType={noticeType} branch={branch} initialValues={lastDetailsVars} onSubmit={handleDetailsSubmit} />}
      {screen === "generating" && <Spinner label="Preparing your draft…" />}
      {screen === "synopsis" && draftResult && <SynopsisScreen draft={draftResult} onContinue={() => setScreen("draft")} onSkip={() => setScreen("draft")} />}
      {screen === "draft" && draftResult && <DraftScreen draft={draftResult} needsAmountCheck={needsAmountCheck} onBack={() => setScreen("synopsis")} />}
      {screen === "error" && <ErrorScreen message={errorMsg} onRetry={() => setScreen(retryScreen)} />}

      <footer className="max-w-md mx-auto px-5 pt-2 pb-8 text-center">
        <div style={{ fontFamily: "'IBM Plex Sans', sans-serif", fontSize: 11.5, color: "#6B7A6F" }}>Built by Team IOTC</div>
      </footer>
    </div>
  );
}
