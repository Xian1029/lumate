"use client";
import { t, tf } from "@/lib/i18n";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles, ArrowRight, PlayCircle } from "lucide-react";
import { getLearningHomeOverview, type HomeLearningSpace } from "@/lib/api";

interface ContinueLearningCtaProps {
  courseId: string;
}

export function ContinueLearningCta({ courseId }: ContinueLearningCtaProps) {
  const [space, setSpace] = useState<HomeLearningSpace | null>(null);
  useEffect(() => {
    let live = true;
    void getLearningHomeOverview()
      .then((overview) => { if (live) setSpace(overview.learning_spaces.find((item) => item.id === courseId) ?? null); })
      .catch(() => { if (live) setSpace(null); });
    return () => { live = false; };
  }, [courseId]);

  if (!space) return null;
  const isResume = space.status === "IN_PROGRESS";

  return (
    <Link
      href={space.target_route}
      aria-label={tf(isResume ? "ui.continue_learning_aria" : "ui.start_learning_aria", { title: space.current_node_title || space.name })}
      className="flex items-center gap-4 p-4 rounded-2xl bg-primary/5 border border-primary/20 hover:bg-primary/10 transition-colors group card-lift"
    >
      <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10 shrink-0">
        {isResume ? <PlayCircle className="size-5 text-primary" /> : <Sparkles className="size-5 text-primary" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground">
          {isResume ? t("ui.continue_learning") : t("ui.start_learning")}
        </p>
        <p className="text-xs text-muted-foreground truncate">{space.current_node_title || "从第一个可学习内容开始"}</p>
      </div>
      <ArrowRight className="size-4 text-primary shrink-0 group-hover:translate-x-1 transition-transform" />
    </Link>
  );
}
