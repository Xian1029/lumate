"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getLearningPlan, planAction, updateLearningPlan, type LearningPlan } from "@/lib/api";
import { toast } from "sonner";

export default function EditLearningPlanPage() {
  const { planId } = useParams<{ planId: string }>(); const router = useRouter(); const [plan, setPlan] = useState<LearningPlan | null>(null); const [saving, setSaving] = useState(false);
  useEffect(() => { void getLearningPlan(planId).then(setPlan).catch((e) => toast.error((e as Error).message || "计划加载失败")); }, [planId]);
  const save = async (form: FormData) => { if (!plan) return; setSaving(true); try { const updated = await updateLearningPlan(plan.id, { title: String(form.get("title") || plan.title), target_date: String(form.get("targetDate") || "") || null, available_minutes_per_day: Number(form.get("minutes")) || null, study_days_of_week: Array.from(form.getAll("weekday")).map(Number) }); await planAction(updated.id, "submit"); toast.success("调整已保存，请再次确认计划。"); router.push(`/learning-plans/${updated.id}/review`); } catch (e) { toast.error((e as Error).message || "保存失败，请重试"); } finally { setSaving(false); } };
  if (!plan) return <main className="p-8 text-sm text-muted-foreground">正在加载可调整的计划…</main>;
  return <main className="mx-auto min-h-screen max-w-xl bg-background px-4 py-8"><h1 className="text-2xl font-bold">调整学习计划</h1><p className="mt-2 text-sm text-muted-foreground">调整后需要再次确认，原有进行中计划不会被直接覆盖。</p><form action={save} className="mt-6 space-y-5 rounded-2xl border border-border/70 bg-card p-5"><label className="block text-sm font-medium">计划名称<Input name="title" className="mt-2" defaultValue={plan.title} /></label><label className="block text-sm font-medium">目标日期<Input name="targetDate" type="date" className="mt-2" defaultValue={plan.target_date || ""} /></label><label className="block text-sm font-medium">每日建议分钟<Input name="minutes" type="number" min="1" className="mt-2" defaultValue={plan.available_minutes_per_day || ""} /></label><fieldset><legend className="text-sm font-medium">每周学习日</legend><div className="mt-2 flex flex-wrap gap-3">{["日","一","二","三","四","五","六"].map((name, index) => <label key={index} className="flex items-center gap-1 text-sm"><input type="checkbox" name="weekday" value={index} defaultChecked={plan.study_days_of_week?.includes(index)} />周{name}</label>)}</div></fieldset><div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => router.back()}>取消</Button><Button disabled={saving}>{saving ? "保存中…" : "保存并重新确认"}</Button></div></form></main>;
}
