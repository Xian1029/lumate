"use client";

import { useState } from "react";
import { ArrowRight, BookOpen, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { Course } from "@/lib/api";
import { ModeBadge } from "@/components/course/mode-selector";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DashSection } from "./dash-section";
import {
  CARD_COLORS,
  formatDate,
  getInitials,
  getCourseMode,
  getFriendlySceneLabel,
} from "./dashboard-utils";

export function CourseSpacesSection({
  courses,
  locale,
  onNavigate,
  onDelete,
  showPendingApprovals = true,
  t,
}: {
  courses: Course[];
  locale: string;
  onNavigate: (path: string) => void;
  onDelete: (courseId: string) => Promise<void>;
  showPendingApprovals?: boolean;
  t: (key: string) => string;
}) {
  const [deleteTarget, setDeleteTarget] = useState<Course | null>(null);
  const [deleting, setDeleting] = useState(false);

  const confirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await onDelete(deleteTarget.id);
      setDeleteTarget(null);
      toast.success(t("home.spaceDelete.success"));
    } catch (error) {
      toast.error(t("home.spaceDelete.failed"), {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <DashSection title={t("home.yourSpaces")} icon={BookOpen}>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {courses.map((course, idx) => {
          const color = CARD_COLORS[idx % CARD_COLORS.length];
          const initials = getInitials(course.name);
          const hasPending = showPendingApprovals && (course.pending_approval_count ?? 0) > 0;
          return (
            <div key={course.id} className="relative rounded-2xl card-lift bg-card group">
              <button
                type="button"
                onClick={() => onNavigate(`/course/${course.id}`)}
                aria-label={t("home.spaceOpen").replace("{name}", course.name)}
                className="flex w-full flex-col gap-3 rounded-2xl p-5 text-left"
              >
                <div className="flex items-center gap-3 w-full">
                  <div className={`w-10 h-10 ${color.bg} rounded-xl flex items-center justify-center shrink-0`}>
                    <span className={`font-bold text-xs ${color.text}`}>{initials}</span>
                  </div>
                  <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                    <span className="font-semibold text-sm text-foreground truncate group-hover:text-brand transition-colors">{course.name}</span>
                    <span className="text-[11px] text-muted-foreground">{formatDate(course.updated_at ?? course.created_at)}</span>
                  </div>
                  <ArrowRight className="mr-7 size-4 shrink-0 text-muted-foreground/0 transition-all group-hover:text-muted-foreground" />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground line-clamp-1 flex-1">
                    {course.description || `${t("dashboard.recentActivity")}：${getFriendlySceneLabel(course.last_scene_id, t)}`}
                  </span>
                  <ModeBadge mode={getCourseMode(course)} />
                </div>
                {hasPending && (
                  <span className="inline-flex w-fit rounded-full px-2.5 py-0.5 text-[11px] font-medium bg-warning-muted text-warning">
                    {locale === "zh"
                      ? `${course.pending_approval_count}${t("dashboard.pendingApprovalsBadge")}`
                      : `${course.pending_approval_count} ${t("dashboard.pendingApprovalsBadge")}`}
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setDeleteTarget(course)}
                aria-label={t("home.spaceDelete.action").replace("{name}", course.name)}
                title={t("general.delete")}
                className="absolute right-4 top-4 rounded-lg p-1.5 text-muted-foreground opacity-70 transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/30 sm:opacity-0 sm:group-hover:opacity-100"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          );
        })}
      </div>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("home.spaceDelete.title")}</DialogTitle>
            <DialogDescription>
              {deleteTarget
                ? t("home.spaceDelete.description").replace("{name}", deleteTarget.name)
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleting}
            >
              {t("general.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {deleting ? t("home.spaceDelete.deleting") : t("home.spaceDelete.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashSection>
  );
}

export function DashboardEmptyState({
  onNavigate,
  t,
}: {
  onNavigate: (path: string) => void;
  t: (key: string) => string;
}) {
  return (
    <div className="text-center py-24 flex flex-col items-center gap-5 animate-fade-in">
      <div className="size-16 rounded-2xl bg-brand-muted flex items-center justify-center">
        <BookOpen className="size-7 text-brand" />
      </div>
      <h2 className="text-lg font-bold text-foreground">{t("dashboard.empty")}</h2>
      <p className="text-sm text-muted-foreground max-w-sm leading-relaxed">{t("dashboard.emptyDescription")}</p>
      <button type="button" onClick={() => onNavigate("/setup?step=content")} className="h-11 px-7 bg-brand text-brand-foreground rounded-full text-sm font-medium hover:opacity-90 transition-all hover:shadow-md">
        {t("dashboard.create")}
      </button>
    </div>
  );
}
