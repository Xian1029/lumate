type TranslateFn = (key: string) => string;

interface StatsRowProps {
  subsectionCount: number;
  wrongAnswerCount: number;
  urgentReviewCount: number;
  t: TranslateFn;
}

export function StatsRow({ subsectionCount, wrongAnswerCount, urgentReviewCount, t }: StatsRowProps) {
  const items = [
    { label: t("unit.subsections"), value: subsectionCount, icon: "📚", tone: "border-emerald-100 bg-emerald-50/65 text-emerald-900" },
    { label: t("unit.wrongAnswers"), value: wrongAnswerCount, icon: "✏️", tone: "border-amber-100 bg-amber-50/65 text-amber-900" },
    { label: t("unit.urgentReviews"), value: urgentReviewCount, icon: "🌱", tone: "border-sky-100 bg-sky-50/65 text-sky-900" },
  ];
  return (
    <section className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label={t("unit.learningSnapshot")}>
      {items.map((item) => <div key={item.label} className={`flex items-center gap-3 rounded-2xl border p-4 shadow-sm ${item.tone}`}>
        <span className="grid size-10 place-items-center rounded-xl bg-white/80 text-xl shadow-sm" aria-hidden="true">{item.icon}</span>
        <div><p className="text-xs opacity-70">{item.label}</p><p className="mt-0.5 text-2xl font-bold tabular-nums">{item.value}</p></div>
      </div>)}
    </section>
  );
}
