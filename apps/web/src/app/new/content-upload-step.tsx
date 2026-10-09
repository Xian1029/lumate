"use client";

import { useCallback, useRef, useState } from "react";
import type { Mode, FileItem } from "./types";
import type { UploadPlan } from "@/lib/api";
import { formatSize } from "./types";
import { StepIndicator } from "./step-indicator";

interface ContentUploadStepProps {
  mode: Mode;
  projectName: string;
  onProjectNameChange: (value: string) => void;
  nameError: string | null;
  onValidateName: (value: string) => void;
  files: FileItem[];
  onFilesChange: (files: FileItem[]) => void;
  onBack: () => void;
  onStartParsing: () => void;
  uploadPlan?: UploadPlan | null;
  fileAssignments: Record<string, string>;
  onFileAssignmentChange: (filename: string, target: string) => void;
  onCombineAll: () => void;
  onResetGrouping: () => void;
  t: (key: string) => string;
}

export function ContentUploadStep({
  mode,
  projectName,
  onProjectNameChange,
  nameError,
  onValidateName,
  files,
  onFilesChange,
  onBack,
  onStartParsing,
  uploadPlan,
  fileAssignments,
  onFileAssignmentChange,
  onCombineAll,
  onResetGrouping,
  t,
}: ContentUploadStepProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const hasUploadErrors = nameError !== null;


  function handleFileAdd(e: React.ChangeEvent<HTMLInputElement>): void {
    const selected = e.target.files;
    if (!selected) return;
    const newFiles = Array.from(selected).map((f) => ({
      file: f,
      name: f.name,
      size: formatSize(f.size),
    }));
    onFilesChange([...files, ...newFiles]);
    e.target.value = "";
  }

  function removeFile(idx: number): void {
    onFilesChange(files.filter((_, i) => i !== idx));
  }

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const droppedFiles = e.dataTransfer.files;
    if (!droppedFiles || droppedFiles.length === 0) return;
    const newFiles = Array.from(droppedFiles).map((f) => ({
      file: f,
      name: f.name,
      size: formatSize(f.size),
    }));
    onFilesChange([...files, ...newFiles]);
  }, [files, onFilesChange]);

  function getModeLabel(): string {
    if (mode === "upload") return t("new.mode.upload");
    if (mode === "url") return t("new.mode.url");
    return t("new.mode.upload");
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-7 p-4 animate-in fade-in duration-300 sm:p-8 lg:p-12">
      {/* Top nav */}
      <div className="flex items-center gap-3">
        <button type="button" data-testid="new-back-mode" onClick={onBack} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          &larr; {t("settings.back")}
        </button>
        <div className="w-px h-4 bg-border" />
        <span className="font-semibold text-sm text-foreground">{t("new.createTitle")}</span>
        <div className="flex-1" />
        <StepIndicator currentStep="upload" t={t} />
      </div>

      <div className="flex items-center gap-2">
        <span className="px-2 py-1 bg-brand-muted text-brand text-[11px] font-medium rounded">
          {getModeLabel()}
        </span>
      </div>

      {/* Project Name */}
      <div className="flex flex-col gap-2">
        <label className="font-semibold text-sm text-foreground">
          {t("new.projectName")}
          <span className="text-muted-foreground font-normal text-xs ml-1.5">{t("new.projectNameHint")}</span>
        </label>
        <input
          data-testid="project-name-input"
          className={`w-full h-11 px-4 border rounded-lg bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-brand/20 focus:border-brand ${nameError ? "border-destructive" : "border-border"}`}
          value={projectName}
          onChange={(e) => {
            onProjectNameChange(e.target.value);
            onValidateName(e.target.value);
          }}
          onBlur={() => onValidateName(projectName)}
          placeholder={t("new.projectNamePlaceholder")}
          maxLength={100}
        />
        {nameError && <p className="text-xs text-destructive mt-1">{nameError}</p>}
      </div>

      {/* Upload Section */}
      {mode === "upload" && (
        <UploadSection
          files={files}
          dragging={dragging}
          fileInputRef={fileInputRef}
          onFileAdd={handleFileAdd}
          onRemoveFile={removeFile}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          t={t}
        />
      )}

      {/* Multi-subject split preview */}
      {uploadPlan && (uploadPlan.groups.length > 1 || uploadPlan.unclassified.length > 0) && (
        <div className="flex flex-col gap-3 rounded-xl border border-brand/30 bg-brand-muted/20 p-4">
          <h3 className="text-sm font-semibold text-foreground">检测到 {uploadPlan.groups.length} 个学科分组</h3>
          <div className="flex flex-wrap gap-2"><button type="button" onClick={onCombineAll} className="rounded-md border border-brand/40 bg-background px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand-muted">全部放入同一学习空间</button><button type="button" onClick={onResetGrouping} className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted">恢复自动分组</button></div>
          {files.length > 0 && files.every((file) => fileAssignments[file.name] === "__all__") && <p className="rounded-lg bg-brand-muted/40 px-3 py-2 text-xs text-brand">已选择合并：所有资料会进入同一个学习空间，不再按学科拆分。</p>}
          <div className="space-y-2">
            {uploadPlan.groups.map((group) => (
              <div key={group.key} className="rounded-lg bg-card px-3 py-2">
                <div className="flex items-center justify-between gap-3"><span className="text-sm font-medium text-foreground">
                  {group.grade ?? ""}{group.subject ?? "未知学科"}
                  {group.publisher ? ` · ${group.publisher}` : ""}
                </span><span className="text-xs text-muted-foreground">建议创建「{group.suggested_name}」</span></div>
                <div className="mt-2 space-y-1">{group.files.map((file) => <label key={file.filename} className="grid grid-cols-[1fr_auto] items-center gap-3 text-xs"><span className="truncate">{file.filename}</span><select value={fileAssignments[file.filename] ?? group.key} onChange={(event) => onFileAssignmentChange(file.filename, event.target.value)} className="h-7 max-w-52 rounded border border-border bg-background px-1.5"><option value={group.key}>保留在此空间</option>{uploadPlan.groups.filter((target) => target.key !== group.key).map((target) => <option key={target.key} value={target.key}>移动到「{target.suggested_name}」</option>)}<option value="__all__">合并到同一学习空间</option><option value="__separate__">单独创建学习空间</option></select></label>)}</div>
              </div>
            ))}
          </div>
          {uploadPlan.unclassified.length > 0 && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 space-y-2">
              <p className="text-xs font-medium text-amber-800">以下资料无法可靠识别，需由你确认后才能继续；系统不会自动混入其他学科。</p>
              {uploadPlan.unclassified.map((file) => (
                <label key={file.filename} className="grid grid-cols-[1fr_auto] items-center gap-3 text-xs text-foreground">
                  <span className="truncate">{file.filename}</span>
                  <select
                    value={fileAssignments[file.filename] ?? ""}
                    onChange={(event) => onFileAssignmentChange(file.filename, event.target.value)}
                    className="h-8 max-w-52 rounded-md border border-amber-300 bg-white px-2"
                  >
                    <option value="">选择归属…</option>
                    {uploadPlan.groups.map((group) => <option key={group.key} value={group.key}>加入「{group.suggested_name}」</option>)}
                    <option value="__all__">合并到同一学习空间</option>
                    <option value="__separate__">单独创建学习空间</option>
                  </select>
                </label>
              ))}
            </div>
          )}
          {uploadPlan.groups.length > 1 && (
            <p className="text-xs text-muted-foreground">确认后将分别创建 {uploadPlan.groups.length} 个学习空间。</p>
          )}
        </div>
      )}

      <div className="w-full h-px bg-border" />

      <div className="flex justify-end gap-4">
        <button type="button" data-testid="new-cancel-upload" onClick={onBack} className="h-11 px-6 border border-border rounded-lg text-muted-foreground font-medium text-sm hover:border-foreground/20">
          {t("new.cancel")}
        </button>
        <button
          type="button"
          onClick={onStartParsing}
          data-testid="start-parsing"
          disabled={hasUploadErrors}
          className={`h-11 px-7 text-brand-foreground rounded-lg flex items-center gap-2 font-semibold text-sm ${hasUploadErrors ? "bg-brand/50 cursor-not-allowed" : "bg-brand hover:opacity-90"}`}
        >
          {t("new.startParsing")} &rarr;
        </button>
      </div>
    </div>
  );
}

/* ---------- Sub-sections ---------- */

interface UploadSectionProps {
  files: FileItem[];
  dragging: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onFileAdd: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveFile: (idx: number) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  t: (key: string) => string;
}

function UploadSection({
  files,
  dragging,
  fileInputRef,
  onFileAdd,
  onRemoveFile,
  onDragOver,
  onDragLeave,
  onDrop,
  t,
}: UploadSectionProps) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-base font-semibold text-foreground">{t("new.uploadMaterials")}</h3>
      <div
        data-testid="upload-dropzone"
        className={`w-full h-40 border-2 border-dashed rounded-lg flex flex-col items-center justify-center gap-3 cursor-pointer transition-colors ${
          dragging
            ? "border-brand bg-brand-muted"
            : "border-border bg-muted hover:border-brand hover:bg-brand-muted"
        }`}
        onClick={() => fileInputRef.current?.click()}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span className={`text-sm ${dragging ? "text-brand font-medium" : "text-muted-foreground"}`}>
          {dragging ? t("new.dropFiles") : t("new.dragFiles")}
        </span>
        <span className="text-xs text-muted-foreground">{t("new.supportedFormats")}</span>
      </div>
      <input
        ref={fileInputRef}
        data-testid="project-file-input"
        type="file"
        accept=".pdf,.pptx,.ppt,.docx,.doc,.html,.htm,.txt,.md"
        multiple
        title={t("new.uploadTitle")}
        className="hidden"
        onChange={onFileAdd}
      />
      {files.length > 0 && (
        <div className="flex flex-col gap-2">
          {files.map((f, idx) => (
            <div key={idx} className="flex items-center gap-3 px-4 py-2.5 bg-muted border border-border rounded-lg">
              <span className="text-[13px] flex-1 text-foreground">{f.name}</span>
              <span className="text-xs text-muted-foreground">{f.size}</span>
              <button type="button" onClick={() => onRemoveFile(idx)} className="text-xs text-muted-foreground hover:text-foreground">
                x
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
