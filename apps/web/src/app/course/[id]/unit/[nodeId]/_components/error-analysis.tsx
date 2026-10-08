import type { WrongAnswer } from "@/lib/api";
import { getDiagnosisTypeLabel, getErrorSignalLabel } from "@/lib/display-mappers";
import type { ErrorPatternSummary } from "./unit-utils";
import { buildErrorPatternRadar, buildWrongAnswerFocus, type ErrorRadarDimension } from "./unit-utils";

type TranslateFn = (key: string) => string;

function signalLabel(value: string): string {
  return getErrorSignalLabel(value);
}

export function ErrorAnalysis({ items, t }: { items: WrongAnswer[]; t: TranslateFn }) {
  if (items.length === 0) {
    return <p className="rounded-2xl bg-emerald-50/65 px-4 py-3 text-sm text-emerald-800">本小节目前没有已确认需要订正的错题。错题分析只收录被明确判定为错误的作答；答案部分正确或暂时无法确认时，不会直接记为错题。</p>;
  }
  const focus = buildWrongAnswerFocus(items);
  const unresolved = items.filter((item) => !item.mastered).length;
  const recovered = items.length - unresolved;
  const recurring = focus.filter((item) => item.count >= 2 && item.unresolvedCount > 0);
  const topFocus = recurring[0] ?? focus.find((item) => item.unresolvedCount > 0) ?? focus[0];
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-2xl bg-rose-50 px-3 py-2.5"><p className="text-[11px] text-rose-700">待巩固</p><p className="mt-0.5 text-lg font-bold text-rose-900">{unresolved} 题</p></div>
        <div className="rounded-2xl bg-emerald-50 px-3 py-2.5"><p className="text-[11px] text-emerald-700">已订正</p><p className="mt-0.5 text-lg font-bold text-emerald-900">{recovered} 题</p></div>
        <div className="rounded-2xl bg-amber-50 px-3 py-2.5"><p className="text-[11px] text-amber-700">重复出现的模式</p><p className="mt-0.5 text-lg font-bold text-amber-900">{recurring.length} 项</p></div>
      </div>

      {topFocus ? <div className="rounded-2xl border border-amber-200 bg-amber-50/55 p-3.5">
        <p className="text-xs font-semibold text-amber-900">建议优先处理</p>
        <p className="mt-1 text-sm font-semibold text-foreground">{topFocus.label}</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {topFocus.count >= 2 ? `在 ${topFocus.count} 道错题中反复出现` : "目前只有一次作答记录，先订正并再做一道同类题确认"}
          {topFocus.type ? `；主要表现为：${signalLabel(topFocus.type)}` : "。"}
          {topFocus.recoveredCount > 0 ? ` 已订正 ${topFocus.recoveredCount} 道。` : ""}
        </p>
      </div> : null}

      <div className="space-y-2">
        {focus.map((item) => (
          <details key={`${item.label}-${item.type ?? "unknown"}`} className="group rounded-2xl border border-border/70 bg-muted/20 px-3.5 py-3">
            <summary className="cursor-pointer list-none flex items-center justify-between gap-3">
              <div className="min-w-0"><p className="text-sm font-medium text-foreground truncate">{item.label}</p><p className="mt-0.5 text-xs text-muted-foreground">{item.count >= 2 ? `重复 ${item.count} 次` : "一次记录"}{item.type ? ` · ${signalLabel(item.type)}` : ""}</p></div>
              <span className={item.unresolvedCount > 0 ? "rounded-full bg-rose-100 px-2 py-1 text-[11px] font-medium text-rose-700" : "rounded-full bg-emerald-100 px-2 py-1 text-[11px] font-medium text-emerald-700"}>{item.unresolvedCount > 0 ? `待巩固 ${item.unresolvedCount}` : "已订正"}</span>
            </summary>
            <div className="mt-3 border-t border-border/60 pt-3 text-xs leading-5 text-muted-foreground">
              <p className="text-foreground">例题：{item.representative.question ?? t("unit.questionFallback")}</p>
              <p className="mt-1"><span className="text-rose-700">你的答案：</span>{item.representative.user_answer || "—"}　<span className="text-emerald-700">正确答案：</span>{item.representative.correct_answer ?? "—"}</p>
              {item.representative.diagnosis ? <p className="mt-1">订正提示：{getDiagnosisTypeLabel(item.representative.diagnosis)}</p> : <p className="mt-1">下一步：对照解析重新完成这道题，再用一道同类题检查是否真正掌握。</p>}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

export function ErrorPatternSection({
  wrongAnswers,
  errorPatterns,
  t,
}: {
  wrongAnswers: WrongAnswer[];
  errorPatterns: ErrorPatternSummary;
  t: TranslateFn;
}) {
  const radar = buildErrorPatternRadar(wrongAnswers);
  return (
    <div className="rounded-2xl bg-card card-shadow p-4">
      <h2 className="text-base font-semibold">{t("unit.errorPattern.title")}</h2>
      <p className="text-xs text-muted-foreground mt-0.5">{t("unit.errorPattern.desc")}</p>

      {wrongAnswers.length === 0 ? (
        <p className="text-sm text-muted-foreground mt-3">本小节目前没有已确认错题，因此暂不生成错因模式。完成并提交练习后，明确判错的作答会自动显示在这里。</p>
      ) : (
        <div className="mt-3 space-y-3">
          <ErrorRadar radar={radar} t={t} />
          <div>
            <p className="text-[11px] text-muted-foreground mb-1">{t("unit.errorPattern.diagnosis")}</p>
            <div className="flex flex-wrap gap-1.5">
              {errorPatterns.diagnoses.length > 0 ? errorPatterns.diagnoses.map((item) => (
                <span
                  key={`diag-${item.label}`}
                  className="text-[11px] px-2 py-1 rounded-full bg-destructive/10 text-destructive"
                >
                  {signalLabel(item.label)} · {item.count}
                </span>
              )) : (
                <span className="text-[11px] text-muted-foreground">{t("unit.none")}</span>
              )}
            </div>
          </div>

          <div>
            <p className="text-[11px] text-muted-foreground mb-1">{t("unit.errorPattern.category")}</p>
            <div className="flex flex-wrap gap-1.5">
              {errorPatterns.categories.length > 0 ? errorPatterns.categories.map((item) => (
                <span
                  key={`cat-${item.label}`}
                  className="text-[11px] px-2 py-1 rounded-full bg-warning/10 text-warning"
                >
                  {signalLabel(item.label)} · {item.count}
                </span>
              )) : (
                <span className="text-[11px] text-muted-foreground">{t("unit.none")}</span>
              )}
            </div>
          </div>

          <div>
            <p className="text-[11px] text-muted-foreground mb-1">{t("unit.errorPattern.knowledgePoint")}</p>
            <div className="flex flex-wrap gap-1.5">
              {errorPatterns.knowledgePoints.length > 0 ? errorPatterns.knowledgePoints.map((item) => (
                <span
                  key={`kp-${item.label}`}
                  className="text-[11px] px-2 py-1 rounded-full bg-brand/10 text-brand"
                >
                  {item.label} · {item.count}
                </span>
              )) : (
                <span className="text-[11px] text-muted-foreground">{t("unit.none")}</span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const RADAR_LABEL_KEYS: Record<ErrorRadarDimension["id"], string> = {
  conceptual: "wrongAnswer.category.conceptual",
  procedural: "wrongAnswer.category.procedural",
  computational: "wrongAnswer.category.computational",
  reading: "wrongAnswer.category.reading",
  careless: "wrongAnswer.category.careless",
};

function ErrorRadar({ radar, t }: { radar: ErrorRadarDimension[] | null; t: TranslateFn }) {
  if (!radar) {
    return <p className="rounded-xl bg-muted/35 px-3 py-2.5 text-xs leading-5 text-muted-foreground">还需要更多带有错因标记的错题，才能形成可靠的错因模式雷达。</p>;
  }
  const max = Math.max(...radar.map((item) => item.count), 1);
  const center = 74;
  const radius = 48;
  const points = radar.map((item, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / radar.length;
    const value = item.count / max;
    return `${center + Math.cos(angle) * radius * value},${center + Math.sin(angle) * radius * value}`;
  }).join(" ");

  return (
    <div className="rounded-xl border border-brand/15 bg-brand-muted/15 p-3">
      <div className="flex flex-wrap items-start gap-3">
        <svg viewBox="0 0 148 148" className="size-32 shrink-0" role="img" aria-label="错因模式雷达">
          {[0.34, 0.67, 1].map((scale) => (
            <polygon key={scale} points={radar.map((_, index) => {
              const angle = -Math.PI / 2 + (Math.PI * 2 * index) / radar.length;
              return `${center + Math.cos(angle) * radius * scale},${center + Math.sin(angle) * radius * scale}`;
            }).join(" ")} fill="none" stroke="#bfd0c4" strokeWidth="1" />
          ))}
          {radar.map((_, index) => {
            const angle = -Math.PI / 2 + (Math.PI * 2 * index) / radar.length;
            return <line key={index} x1={center} y1={center} x2={center + Math.cos(angle) * radius} y2={center + Math.sin(angle) * radius} stroke="#d8e3da" strokeWidth="1" />;
          })}
          <polygon points={points} fill="#7c9a84" fillOpacity="0.32" stroke="#4f765a" strokeWidth="2" />
        </svg>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-foreground">错因模式雷达</p>
          <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">每一项是本小节真实错题中出现的次数，不是预测分数。</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {radar.map((item) => <span key={item.id} className="rounded-full bg-card px-2 py-1 text-[11px] text-foreground shadow-sm">{t(RADAR_LABEL_KEYS[item.id])} · {item.count} 次</span>)}
          </div>
        </div>
      </div>
    </div>
  );
}
