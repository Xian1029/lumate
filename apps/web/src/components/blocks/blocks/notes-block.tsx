"use client";

import { t } from "@/lib/i18n";
import { NotesSection } from "@/components/sections/notes-section";
import type { BlockComponentProps } from "@/lib/block-system/registry";

export default function NotesBlock({ courseId, blockId, aiActionsEnabled }: BlockComponentProps) {
  return (
    <div role="region" aria-label={t("ui.notes")} className="min-h-0 flex flex-col">
      <NotesSection courseId={courseId} blockId={blockId} aiActionsEnabled={aiActionsEnabled} />
    </div>
  );
}
