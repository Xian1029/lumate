"use client";
import { useParams } from "next/navigation";
import { PlanDetail } from "@/components/learning-plans/plan-detail";
export default function LearningPlanReviewPage() { const params = useParams(); return <PlanDetail planId={params.planId as string} review />; }
