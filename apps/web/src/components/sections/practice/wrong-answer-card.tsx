"use client";

import { t } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, RotateCcw, Sparkles } from "lucide-react";
import type { WrongAnswer } from "@/lib/api";
import { questionTypeLabel } from "./question-type-label";

interface DiagnosticDraft {
  problemId: string;
  question: string;
  options: Record<string, string> | null;
  selectedAnswer?: string;
  isCorrect?: boolean;
  correctAnswer?: string | null;
  explanation?: string | null;
  diagnosis?: string;
  interpretation?: string;
  pending?: boolean;
}

interface WrongAnswerCardProps {
  item: WrongAnswer;
  index: number;
  draft?: DiagnosticDraft;
  markingId: string | null;
  derivingId: string | null;
  aiActionsEnabled: boolean;
  onMarkMastered: (item: WrongAnswer) => void;
  onDerive: (wrongAnswerId: string) => void;
  onDiagnosticAnswer: (wrongAnswerId: string, answer: string) => void;
}

const DISPLAY_KEYS: Record<string, string> = {
  conceptual: "wrongAnswer.category.conceptual",
  procedural: "wrongAnswer.category.procedural",
  computational: "wrongAnswer.category.computational",
  reading: "wrongAnswer.category.reading",
  careless: "wrongAnswer.category.careless",
  fundamental_gap: "ui.fundamental_gap_lower",
  trap_vulnerability: "ui.trap_vuln_lower",
  carelessness: "ui.carelessness",
  mastered: "ui.mastered",
};

function displayLabel(value: string | null | undefined): string {
  const normalized = value || "unknown";
  return DISPLAY_KEYS[normalized] ? t(DISPLAY_KEYS[normalized]) : normalized.replaceAll("_", " ");
}

export function WrongAnswerCard({
  item,
  index,
  draft,
  markingId,
  derivingId,
  aiActionsEnabled,
  onMarkMastered,
  onDerive,
  onDiagnosticAnswer,
}: WrongAnswerCardProps) {
  const optionKeys = Object.keys(draft?.options ?? {}).sort();

  return (
    <div className="rounded-2xl card-shadow bg-card p-4 space-y-2" data-testid={`wrong-answer-${item.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">
            {index + 1}. {item.question ?? t("ui.untitled_question")}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant="outline">{questionTypeLabel(item.question_type, t)}</Badge>
            {item.error_category ? <Badge variant="secondary">{displayLabel(item.error_category)}</Badge> : null}
            {item.diagnosis ? (
              <Badge variant="secondary">{displayLabel(item.diagnosis)}</Badge>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 rounded-full border border-border/70 bg-muted/45 p-1 shadow-sm">
          <Button
            size="sm"
            variant="outline"
            aria-label={t("ui.mark_as_mastered")}
            onClick={() => void onMarkMastered(item)}
            disabled={markingId === item.id || !item.correct_answer}
            className="h-8 rounded-full border border-emerald-700 bg-emerald-700 px-3 font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:border-emerald-800 hover:bg-emerald-800 hover:text-white hover:shadow-md focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:border-muted disabled:bg-muted disabled:text-muted-foreground"
          >
            {markingId === item.id ? (
              <><Sparkles className="mr-1.5 size-3.5 animate-pulse" />正在记录…</>
            ) : (
              <><CheckCircle2 className="mr-1.5 size-3.5" />我会啦！</>
            )}
          </Button>
          <Button
            data-testid={`derive-${item.id}`}
            size="sm"
            variant="outline"
            aria-label="换一道简单题试试"
            onClick={() => void onDerive(item.id)}
            disabled={!aiActionsEnabled || derivingId === item.id}
            className="h-8 rounded-full border-amber-300 bg-amber-50 px-3 font-semibold text-amber-900 shadow-none transition-all hover:-translate-y-0.5 hover:border-amber-400 hover:bg-amber-100 hover:text-amber-950 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 disabled:border-muted disabled:bg-muted disabled:text-muted-foreground"
          >
            {derivingId === item.id ? (
              <><Sparkles className="mr-1.5 size-3.5 animate-pulse" />正在准备…</>
            ) : (
              <><RotateCcw className="mr-1.5 size-3.5" />再试一题</>
            )}
          </Button>
        </div>
      </div>

      <div className="grid gap-2 rounded-xl bg-muted/20 p-3 text-xs leading-relaxed sm:grid-cols-2">
        <div>
          <p className="text-muted-foreground">你当时写的是</p>
          <p className="mt-1 font-medium text-foreground">{item.user_answer || "没有填写答案"}</p>
        </div>
        <div>
          <p className="text-muted-foreground">可以这样回答</p>
          <p className="mt-1 font-medium text-success">{item.correct_answer || "看看下面的解析"}</p>
        </div>
        {item.explanation ? (
          <div className="sm:col-span-2 border-t border-border/60 pt-2">
            <p className="text-muted-foreground">想一想</p>
            <p className="mt-1 text-foreground/85">{item.explanation}</p>
          </div>
        ) : null}
      </div>

      {draft ? (
        <div className="rounded-xl bg-muted/30 p-3.5 space-y-2" data-testid={`diagnostic-${item.id}`}>
          <div>
            <p className="text-xs font-semibold text-brand">小小检查站</p>
            <p className="mt-0.5 text-xs text-muted-foreground">换个简单问法，看看你卡在知识点还是审题步骤。</p>
          </div>
          <p className="text-sm font-medium">{draft.question}</p>
          {optionKeys.map((key) => (
            <button
              key={key}
              type="button"
              data-testid={`diagnostic-${item.id}-${key}`}
              className="w-full rounded-xl border px-3.5 py-2.5 text-left text-sm hover:border-primary/50"
              onClick={() => void onDiagnosticAnswer(item.id, key)}
              disabled={!aiActionsEnabled || draft.pending}
            >
              {draft.options?.[key]}
            </button>
          ))}
          {draft.selectedAnswer ? (
            <div
              className={`rounded-xl border p-3 text-xs leading-relaxed ${draft.isCorrect ? "border-success/30 bg-success/10" : "border-warning/30 bg-warning/10"}`}
              data-testid={`diagnosis-${item.id}`}
            >
              <p className="font-semibold">{draft.isCorrect ? "答对啦！方法已经掌握 🎉" : "没关系，我们找到需要练习的地方了"}</p>
              {!draft.isCorrect && draft.correctAnswer ? <p className="mt-1">正确答案：{draft.correctAnswer}</p> : null}
              {draft.explanation ? <p className="mt-1">{draft.explanation}</p> : null}
              {draft.interpretation ? <p className="mt-2 font-medium">下一步：{draft.interpretation}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
