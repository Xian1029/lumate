"use client";

import { useEffect, useState } from "react";
import { getLearningHomeOverview, type LearningHomeOverview } from "@/lib/api";
import { LEARNING_HOME_INVALIDATION_EVENT } from "@/lib/api/client";

/**
 * The home screen has exactly one read model. Do not add per-course calls in
 * this hook: ordering, review priority, plan status and upload state belong to
 * the server-side overview endpoint.
 */
export function useLearningHome() {
  const [overview, setOverview] = useState<LearningHomeOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    void getLearningHomeOverview()
      .then(setOverview)
      .catch((cause: Error) => setError(cause.message || "首页学习数据加载失败"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let active = true;
    const refresh = () => {
      setLoading(true);
      void getLearningHomeOverview()
        .then((data) => { if (active) setOverview(data); })
        .catch((cause: Error) => { if (active) setError(cause.message || "首页学习数据加载失败"); })
        .finally(() => { if (active) setLoading(false); });
    };
    refresh();
    window.addEventListener(LEARNING_HOME_INVALIDATION_EVENT, refresh);
    return () => { active = false; window.removeEventListener(LEARNING_HOME_INVALIDATION_EVENT, refresh); };
  }, []);
  return { overview, loading, error, reload: load };
}
