"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { BookOpen, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { uploadFile } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ACCEPTED_FILE_TYPES } from "@/components/chat/chat-input-utils";
import { useCourseStore } from "@/store/course";

export function EmptyMaterialsPrompt({ courseId }: { courseId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    setUploading(true);
    let uploaded = 0;
    try {
      for (const file of files) {
        await uploadFile(courseId, file);
        uploaded += 1;
      }
      toast.success(uploaded > 1 ? `已添加 ${uploaded} 份教材` : "教材已添加", {
        description: "正在整理教材内容，完成后会自动显示课程章节。",
      });
      const store = useCourseStore.getState();
      void store.fetchIngestionJobs(courseId);
      void store.fetchContentTree(courseId);
    } catch (error) {
      toast.error("教材添加失败", {
        description: error instanceof Error ? error.message : "请稍后再试",
      });
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };

  return (
    <section className="rounded-2xl border border-dashed border-brand/30 bg-gradient-to-br from-brand/5 via-card to-amber-50/40 p-5 sm:flex sm:items-center sm:justify-between sm:gap-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-brand-muted text-brand">
          <BookOpen className="size-5" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-foreground">这个学习空间还没有教材</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">添加 PDF、Word 或课件后，我会帮你整理章节、笔记和练习。</p>
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED_FILE_TYPES}
        className="hidden"
        aria-label="选择要添加的教材"
        onChange={(event) => void handleFiles(event)}
      />
      <Button className="mt-4 w-full shrink-0 sm:mt-0 sm:w-auto" disabled={uploading} onClick={() => inputRef.current?.click()}>
        {uploading ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Upload className="mr-2 size-4" />}
        {uploading ? "正在添加…" : "添加教材"}
      </Button>
    </section>
  );
}
