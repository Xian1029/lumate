"use client";

import { useState } from "react";
import Link from "next/link";
import { BookOpen, Check, ChevronDown, ChevronRight, Pin, PinOff } from "lucide-react";
import type { ContentNode } from "@/lib/api";
import { getPreferredLearningNode } from "@/lib/content-tree";

type TranslateFn = (key: string) => string;
type TranslateFormatFn = (key: string, vars?: Record<string, string | number | null | undefined>) => string;

export function resolveChapterNavigationNodes(node: ContentNode, parentNode: ContentNode | null, courseRoot?: ContentNode): ContentNode[] {
  const nodes = courseRoot?.children?.length
    ? courseRoot.children
    : node.children?.length
      ? node.children
      : parentNode?.children?.length
        ? parentNode.children
        : [node];
  return [...nodes].sort((a, b) => a.order_index - b.order_index);
}

function findDirectoryNode(nodes: ContentNode[], nodeId: string): ContentNode | undefined {
  for (const node of nodes) {
    if (node.id === nodeId) return node;
    const nested = findDirectoryNode(node.children ?? [], nodeId);
    if (nested) return nested;
  }
  return undefined;
}

function flattenDirectoryNodes(nodes: ContentNode[], depth = 0): Array<{ node: ContentNode; depth: number }> {
  return [...nodes]
    .sort((a, b) => a.order_index - b.order_index)
    .flatMap((node) => [
      { node, depth },
      ...flattenDirectoryNodes(node.children ?? [], depth + 1),
    ]);
}

interface UnitNavigationProps {
  courseId: string;
  nodePath: ContentNode[];
  parentNode: ContentNode | null;
  siblingNodes: ContentNode[];
  focusTerms: string[];
  wrongAnswerCount: number;
  reviewItemCount: number;
  t: TranslateFn;
  tf: TranslateFormatFn;
}

export function UnitNavigation({
  courseId,
  nodePath,
  parentNode,
  siblingNodes,
  focusTerms,
  wrongAnswerCount,
  reviewItemCount,
  t,
  tf,
}: UnitNavigationProps) {
  const isChapterPage = nodePath.length === 2;
  return (
    <section className="rounded-2xl border border-border/60 bg-card card-shadow p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-brand">{t("unit.learningPath")}</span>
        {nodePath.map((item, idx) => (
          <span key={item.id} className="inline-flex items-center gap-2">
            {idx > 0 ? <span className="text-muted-foreground">/</span> : null}
            {idx === nodePath.length - 1 ? (
              <span className="rounded-full bg-brand/10 px-3 py-1 font-semibold text-brand">{item.title}</span>
            ) : (
              <Link
                href={`/course/${courseId}/unit/${item.id}`}
                className="text-brand hover:underline"
              >
                {idx === 0 && nodePath.length > 1 ? t("unit.bookHome") : item.title}
              </Link>
            )}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="rounded-2xl border border-emerald-100 bg-emerald-50/45 p-4">
          <p className="mb-2 text-sm font-semibold text-emerald-900">
            {isChapterPage ? t("unit.chooseAnotherChapter") : t("unit.chooseAnotherSection")}
          </p>
          {parentNode ? (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                {isChapterPage ? t("unit.backToBook") : t("unit.backToChapter")}:{" "}
                <Link href={`/course/${courseId}/unit/${parentNode.id}`} className="text-brand hover:underline">
                  {isChapterPage ? t("unit.bookHome") : parentNode.title}
                </Link>
              </p>
              {siblingNodes.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {siblingNodes.slice(0, 8).map((sibling) => (
                    <Link
                      key={sibling.id}
                      href={`/course/${courseId}/unit/${sibling.id}`}
                      className="text-[11px] px-2 py-1 rounded-full bg-muted text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {sibling.title}
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t("unit.noSiblings")}</p>
              )}
            </div>
          ) : (
            <div>
              <p className="text-sm font-semibold text-foreground">{t("unit.whereToStart")}</p>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">{t("unit.chooseFromDirectory")}</p>
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-amber-100 bg-amber-50/45 p-4">
          <p className="mb-2 text-sm font-semibold text-amber-900">
            {parentNode ? (isChapterPage ? t("unit.thisChapterFocus") : t("unit.thisSectionFocus")) : t("unit.threeStudySteps")}
          </p>
          {parentNode ? <div className="flex flex-wrap gap-2 mb-2">
            {focusTerms.slice(0, 6).map((term) => (
              <span key={term} className="text-[11px] px-2 py-1 rounded-full bg-brand/10 text-brand">
                {term}
              </span>
            ))}
          </div> : <div className="grid grid-cols-3 gap-2 text-center text-xs font-medium text-amber-900">
            <span className="rounded-xl bg-white/80 px-2 py-2">1. {t("unit.stepChoose")}</span>
            <span className="rounded-xl bg-white/80 px-2 py-2">2. {t("unit.stepRead")}</span>
            <span className="rounded-xl bg-white/80 px-2 py-2">3. {t("unit.stepPractice")}</span>
          </div>}
          {parentNode ? <p className="text-xs text-muted-foreground">{tf("unit.matchedSignals", { wrong: wrongAnswerCount, mastery: reviewItemCount })}</p> : null}
        </div>
      </div>
    </section>
  );
}

export function SubsectionsNav({
  courseId,
  currentNodeId,
  subsections,
  t,
}: {
  courseId: string;
  currentNodeId: string;
  subsections: ContentNode[];
  t: TranslateFn;
}) {
  const currentSection = findDirectoryNode(subsections, currentNodeId);
  const currentChapter = subsections.find((section) => section.id === currentNodeId || !!findDirectoryNode(section.children ?? [], currentNodeId));
  const [isPinned, setIsPinned] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [expandedChapterIds, setExpandedChapterIds] = useState<Set<string>>(
    () => new Set(currentChapter ? [currentChapter.id] : []),
  );
  const hasNestedSections = subsections.some((section) => section.children?.length);
  const directoryItemCount = flattenDirectoryNodes(subsections).length;

  return (
    <section className={`${isPinned ? "sticky top-[3.65rem] z-20" : "relative"} overflow-hidden rounded-2xl border border-emerald-100/90 bg-card/95 shadow-[0_16px_42px_-28px_rgba(16,81,57,0.55)] backdrop-blur-xl`} data-testid="chapter-navigation">
      <div className="flex items-center gap-3 bg-gradient-to-r from-brand-muted/55 via-card to-amber-50/45 px-5 py-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
          <BookOpen className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold text-foreground">{t("unit.chapterNavigation")}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{t("unit.chapterNavigationHint")}</p>
        </div>
        {currentSection ? (
          <span className="hidden max-w-52 truncate rounded-full bg-white/80 px-3 py-1 text-xs font-medium text-brand ring-1 ring-emerald-100 sm:block">
            {currentSection.title}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => {
            if (!isPinned) setIsCollapsed(true);
            setIsPinned((value) => !value);
          }}
          aria-pressed={isPinned}
          aria-label={isPinned ? t("unit.unpinDirectory") : t("unit.pinDirectory")}
          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 transition-colors ${isPinned ? "bg-emerald-50 text-emerald-700 ring-emerald-100 hover:bg-emerald-100" : "bg-background/80 text-muted-foreground ring-border hover:text-foreground"}`}
        >
          {isPinned ? <Pin className="size-3" /> : <PinOff className="size-3" />}
          {isPinned ? t("unit.unpinDirectoryShort") : t("unit.pinDirectoryShort")}
        </button>
        <span className="rounded-full bg-background/80 px-2.5 py-1 text-xs font-semibold text-brand shadow-sm">
          {directoryItemCount}
        </span>
        <button
          type="button"
          onClick={() => setIsCollapsed((value) => !value)}
          aria-expanded={!isCollapsed}
          className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {isCollapsed ? t("unit.viewDirectory") : t("unit.collapseDirectory")}
          <ChevronDown className={`size-4 transition-transform duration-200 ${isCollapsed ? "" : "rotate-180"}`} />
        </button>
      </div>
      {!isCollapsed ? <nav aria-label={t("unit.chapterNavigation")} className={`${isPinned ? "max-h-[min(42vh,22rem)]" : "max-h-[32rem]"} overflow-y-auto border-t border-border/50 px-4 py-3 scrollbar-thin sm:px-5`}>
        <div className="grid grid-cols-1 gap-2">
          {subsections.map((child, index) => {
            const isCurrent = child.id === currentNodeId;
            const nestedSections = flattenDirectoryNodes(child.children ?? []);
            const hasCurrentDescendant = !!findDirectoryNode(child.children ?? [], currentNodeId);
            const chapterExpanded = expandedChapterIds.has(child.id);
            const chapterLink = (
              <Link
                href={`/course/${courseId}/unit/${getPreferredLearningNode(child).id}`}
                aria-current={isCurrent ? "page" : undefined}
                className={`group/item flex min-w-0 items-center gap-3 rounded-xl border p-3 text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
                  isCurrent || hasCurrentDescendant
                    ? "border-brand/30 bg-brand-muted/65 shadow-sm"
                    : "border-transparent bg-muted/25 hover:border-brand/15 hover:bg-accent/45"
                }`}
              >
                <span className={`grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold shadow-sm ${
                  isCurrent || hasCurrentDescendant ? "bg-brand text-brand-foreground" : "bg-background text-brand"
                }`}>
                  {isCurrent || hasCurrentDescendant ? <Check className="size-3.5" /> : index + 1}
                </span>
                <span className={`min-w-0 flex-1 truncate ${isCurrent || hasCurrentDescendant ? "font-semibold text-brand" : "text-foreground"}`}>
                  {child.title}
                </span>
                {isCurrent ? (
                  <span className="shrink-0 text-[11px] font-medium text-brand">{t("unit.currentChapter")}</span>
                ) : (
                  <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-hover/item:translate-x-0.5" />
                )}
              </Link>
            );
            if (!hasNestedSections) return <div key={child.id}>{chapterLink}</div>;

            return (
              <section key={child.id} className={`min-w-0 rounded-2xl border p-2 transition-colors ${hasCurrentDescendant || isCurrent ? "border-emerald-200 bg-emerald-50/35" : "border-border/60 bg-muted/10"}`}>
                <div className="flex min-w-0 items-center gap-2">
                  <div className="min-w-0 flex-1">{chapterLink}</div>
                  <button
                    type="button"
                    onClick={() => setExpandedChapterIds((current) => {
                      const next = new Set(current);
                      if (next.has(child.id)) next.delete(child.id);
                      else next.add(child.id);
                      return next;
                    })}
                    aria-expanded={chapterExpanded}
                    aria-label={`${chapterExpanded ? t("unit.collapseChapter") : t("unit.expandChapter")}：${child.title}`}
                    className="inline-flex h-9 shrink-0 items-center gap-1 rounded-xl px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-white hover:text-foreground"
                  >
                    {chapterExpanded ? t("unit.hideSections") : t("unit.viewSections")}
                    <ChevronDown className={`size-4 transition-transform ${chapterExpanded ? "rotate-180" : ""}`} />
                  </button>
                </div>
                {chapterExpanded && nestedSections.length > 0 ? (
                  <div className="mt-2 grid grid-cols-1 gap-1 px-1 pb-1 sm:grid-cols-2">
                    {nestedSections.map(({ node: section, depth }, sectionIndex) => {
                      const sectionIsCurrent = section.id === currentNodeId;
                      return (
                        <Link
                          key={section.id}
                          href={`/course/${courseId}/unit/${section.id}`}
                          aria-current={sectionIsCurrent ? "page" : undefined}
                          className={`flex min-w-0 items-center gap-2 rounded-xl px-3 py-2 text-xs transition-colors ${sectionIsCurrent ? "bg-white font-semibold text-emerald-800 shadow-sm ring-1 ring-emerald-200" : "text-muted-foreground hover:bg-white/75 hover:text-foreground"}`}
                          style={{ paddingLeft: `${12 + Math.min(depth, 2) * 12}px` }}
                        >
                          <span className={`grid size-5 shrink-0 place-items-center rounded-full text-[10px] ${sectionIsCurrent ? "bg-emerald-600 text-white" : "bg-background text-muted-foreground ring-1 ring-border"}`}>
                            {sectionIsCurrent ? <Check className="size-3" /> : `${index + 1}.${sectionIndex + 1}`}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{section.title}</span>
                          {sectionIsCurrent ? <span className="shrink-0 text-[10px] text-emerald-700">{t("unit.currentSection")}</span> : null}
                        </Link>
                      );
                    })}
                  </div>
                ) : null}
              </section>
            );
          })}
        </div>
      </nav> : null}
    </section>
  );
}
