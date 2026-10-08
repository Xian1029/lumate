import { t } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import { getGapTypeLabel } from "@/lib/display-mappers";
import type { LearningOverview } from "@/lib/api";

interface CourseSummariesProps {
  courseSummaries: LearningOverview["course_summaries"];
}

export function CourseSummaries({ courseSummaries }: CourseSummariesProps) {
  return (
    <section className="rounded-xl border border-border bg-card" data-testid="analytics-course-summaries">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="font-medium text-foreground">{t("ui.course_summaries")}</h2>
      </div>
      <div className="divide-y divide-border">
        {courseSummaries.map((course) => (
          <div
            key={course.course_id}
            className="p-4 flex flex-col gap-3 md:flex-row md:items-start md:justify-between"
            data-testid={`analytics-course-${course.course_id}`}
          >
            <div>
              <h3 className="font-medium text-foreground">{course.course_name}</h3>
              <p className="text-sm text-muted-foreground">
                掌握度 {(course.average_mastery * 100).toFixed(0)}% · 学习 {course.study_minutes} 分钟 · 错题 {course.wrong_answers} 道
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(course.gap_types).map(([gap, count]) => (
                <Badge key={gap} variant="secondary">
                  {getGapTypeLabel(gap)}：{count}
                </Badge>
              ))}
              {course.diagnosed_count > 0 && (
                <Badge variant="outline">已诊断：{course.diagnosed_count}</Badge>
              )}
            </div>
          </div>
        ))}
        {courseSummaries.length === 0 && (
          <div className="p-8 text-center text-sm text-muted-foreground">
            还没有学习分析数据，先进入课程开始练习吧。
          </div>
        )}
      </div>
    </section>
  );
}
