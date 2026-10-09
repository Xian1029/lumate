"use client";

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  type IngestionJobSummary,
  type UploadPlan,
  listIngestionJobs,
  planUploadSpaces,
  activateCourse,
  cancelSetupCourse,
  updateCourse,
  listAuthSessions,
  canvasBrowserLogin,
  fetchCanvasCourseInfo,
} from "@/lib/api";
import { ApiError } from "@/lib/api/client";
import { useT } from "@/lib/i18n-context";
import { persistCourseSpaceLayoutLocally } from "@/lib/block-system/layout-sync";
import { useCourseStore } from "@/store/course";
import { useWorkspaceStore } from "@/store/workspace";
import { buildLayoutFromMode } from "@/lib/block-system/templates";
import type { LearningMode } from "@/lib/block-system/types";

import type { Mode, Step, FileItem, ParseLog } from "./types";
import { isCanvasUrl, FEATURE_CARDS, deriveParseSteps, deriveParseProgress } from "./types";
import { submitSources, buildMetadata, friendlySourceError } from "./parse-actions";

export function useNewProject() {
  const router = useRouter();
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const { addCourse, fetchContentTree } = useCourseStore();

  /* ---------- State ---------- */
  const [step, setStep] = useState<Step>("mode");
  // New learning spaces accept uploaded materials only. URL ingestion and
  // periodic scraping are intentionally disabled at the source, not merely
  // hidden from the form.
  const [mode] = useState<Mode>("upload");
  const [learningMode, setLearningMode] = useState<LearningMode>("course_following");
  const [projectName, setProjectName] = useState("");
  const projectNameRef = useRef(projectName);
  projectNameRef.current = projectName;
  const [files, setFiles] = useState<FileItem[]>([]);
  const [url, setUrl] = useState("");
  const [autoScrape] = useState(false);
  const [features, setFeatures] = useState<Record<string, boolean>>({
    notes: true, practice: true, study_plan: true, free_qa: true, wrong_answer: true,
  });
  const [nlInput, setNlInput] = useState("");
  const [createdCourseId, setCreatedCourseId] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [isCanvasDetected, setIsCanvasDetected] = useState(false);
  const [showCanvasLogin, setShowCanvasLogin] = useState(false);
  const [canvasLogging, setCanvasLogging] = useState(false);
  const [canvasLoginError, setCanvasLoginError] = useState<string | null>(null);
  const [canvasSessionValid, setCanvasSessionValid] = useState(false);
  const [ingestionJobs, setIngestionJobs] = useState<IngestionJobSummary[]>([]);
  const [uploadPlan, setUploadPlan] = useState<UploadPlan | null>(null);
  /** User overrides for the suggested subject grouping, keyed by filename. */
  const [fileAssignments, setFileAssignments] = useState<Record<string, string>>({});
  const [createdCourseIds, setCreatedCourseIds] = useState<string[]>([]);
  const [isSubmittingContent, setIsSubmittingContent] = useState(false);
  const [noSourcesSubmitted, setNoSourcesSubmitted] = useState(false);
  const [parseLogs, setParseLogs] = useState<ParseLog[]>([]);
  const seenJobStatesRef = useRef<Record<string, string>>({});
  const provisionalCourseIdsRef = useRef<string[]>([]);

  /* ---------- Derived values ---------- */
  const parseSteps = useMemo(
    () => deriveParseSteps(ingestionJobs, isSubmittingContent, noSourcesSubmitted, t),
    [ingestionJobs, isSubmittingContent, noSourcesSubmitted, t],
  );
  const parseProgress = useMemo(
    () => deriveParseProgress(ingestionJobs, isSubmittingContent, noSourcesSubmitted),
    [ingestionJobs, isSubmittingContent, noSourcesSubmitted],
  );
  // Only the current processing attempt is authoritative.  Historical failed
  // attempts remain inspectable server-side but must never turn a later
  // successful upload back into a failed creation flow.
  const currentJobs = ingestionJobs.filter((job) => job.is_current_attempt !== false);
  const hasCompletedJob = currentJobs.some((job) => job.status === "completed");
  const hasFailedJob = currentJobs.some((job) => job.status === "failed");
  const allJobsFailed = currentJobs.length > 0 && currentJobs.every((job) => job.status === "failed");
  // A completed source has a durable tree that can be previewed even while
  // other sources are processing or awaiting replacement.
  const canContinueToFeatures = noSourcesSubmitted || hasCompletedJob;
  const activeCourseIds = createdCourseIds.length ? createdCourseIds : createdCourseId ? [createdCourseId] : [];
  provisionalCourseIdsRef.current = activeCourseIds;
  const readyCourseIds = activeCourseIds.filter((courseId) => {
    const jobs = currentJobs.filter((job) => job.course_id === courseId);
    return jobs.some((job) => job.workflow_state === "READY" || job.status === "completed");
  });
  const processingState = useMemo(() => {
    if (noSourcesSubmitted) return "READY" as const;
    if (!ingestionJobs.length) return isSubmittingContent ? "UPLOADED" as const : "CLASSIFYING" as const;
    const hasUnfinishedJob = currentJobs.some((job) => job.status !== "completed" && job.status !== "failed" && job.workflow_state !== "READY");
    if (readyCourseIds.length && (readyCourseIds.length < activeCourseIds.length || hasFailedJob || hasUnfinishedJob)) return "PARTIALLY_READY" as const;
    if (readyCourseIds.length && readyCourseIds.length === activeCourseIds.length) return "READY" as const;
    if (hasFailedJob) return "FAILED_RETRYABLE" as const;
    return (ingestionJobs.find((job) => job.workflow_state && job.workflow_state !== "READY")?.workflow_state ?? "PARSING") as "CLASSIFYING" | "DETECTING_STRUCTURE" | "PARSING";
  }, [activeCourseIds.length, currentJobs, hasFailedJob, ingestionJobs, isSubmittingContent, noSourcesSubmitted, readyCourseIds.length]);

  /* ---------- Abandoned provisional attempt cleanup ---------- */
  useEffect(() => {
    const abandonUnconfirmed = () => {
      const ids = [...provisionalCourseIdsRef.current];
      provisionalCourseIdsRef.current = [];
      for (const id of ids) {
        // keepalive lets the request finish when the tab closes. The endpoint
        // only deletes SETUP courses, so a course activated by either confirm
        // action is protected even if this event races with navigation.
        void cancelSetupCourse(id, { keepalive: true, silent: true }).catch(() => undefined);
      }
    };
    window.addEventListener("pagehide", abandonUnconfirmed);
    window.addEventListener("beforeunload", abandonUnconfirmed);
    return () => {
      window.removeEventListener("pagehide", abandonUnconfirmed);
      window.removeEventListener("beforeunload", abandonUnconfirmed);
      abandonUnconfirmed();
    };
  }, []);

  /* ---------- Multi-subject upload plan ---------- */
  // Always classify picked files. A single ambiguous file still needs a human
  // decision; only grouping is conditional on the result size.
  useEffect(() => {
    if (files.length === 0) {
      setUploadPlan(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const plan = await planUploadSpaces(files.map((f) => f.name));
        if (!cancelled) setUploadPlan(plan);
      } catch {
        if (!cancelled) setUploadPlan(null);
      }
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [files]);

  /* ---------- Validation ---------- */
  function validateName(value: string): void {
    if (value.length > 100) {
      setNameError(t("new.projectNameTooLong"));
    } else {
      setNameError(null);
    }
  }

  function validateUrl(value: string): void {
    const trimmed = value.trim();
    if (trimmed && !/^https?:\/\//i.test(trimmed)) {
      setUrlError(t("new.urlInvalid"));
    } else {
      setUrlError(null);
    }
    setIsCanvasDetected(trimmed ? isCanvasUrl(trimmed) : false);
  }

  /* ---------- Feature toggle ---------- */
  function toggleFeature(id: string): void {
    const card = FEATURE_CARDS.find((c) => c.id === id);
    if (card?.phase) return;
    setFeatures((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  /* ---------- Ingestion job polling ---------- */
  useEffect(() => {
    const courseIds = createdCourseIds.length > 0
      ? createdCourseIds
      : (createdCourseId ? [createdCourseId] : []);
    if (step !== "parsing" || courseIds.length === 0 || noSourcesSubmitted) return;

    let cancelled = false;
    let pollingHalted = false;
    let lastPollError = "";

    const pollJobs = async () => {
      const newLogs: ParseLog[] = [];
      try {
        const jobsPerCourse = await Promise.all(courseIds.map((cid) => listIngestionJobs(cid)));
        const jobs = jobsPerCourse.flat();
        if (cancelled) return;
        setIngestionJobs(jobs.filter((job) => job.is_current_attempt !== false));

        for (const job of jobs) {
          const stateKey = `${job.status}:${job.embedding_status}:${job.error_message ?? ""}`;
          if (seenJobStatesRef.current[job.id] === stateKey) continue;
          seenJobStatesRef.current[job.id] = stateKey;

          const label = job.filename || tRef.current("new.untitledSource");
          if (job.error_message) {
            newLogs.push({ text: `${new Date().toLocaleTimeString()}  ${friendlySourceError(label)}`, color: "text-destructive" });
          } else if (job.phase_label) {
            newLogs.push({ text: `${new Date().toLocaleTimeString()}  ${label}: ${job.phase_label}`, color: "text-muted-foreground" });
          }
        }
      } catch (error) {
        if (!cancelled) {
          const message = (error as Error).message;
          // A cancelled/replaced provisional course is terminal for this
          // polling generation. Continuing would append the same 404 forever
          // and repeatedly surface a global toast.
          if (error instanceof ApiError && (error.status === 404 || error.status === 410)) {
            pollingHalted = true;
          }
          if (message !== lastPollError) {
            lastPollError = message;
            newLogs.push({ text: `${new Date().toLocaleTimeString()}  ${tRef.current("new.logRefreshFailed")}: ${message}`, color: "text-destructive" });
          }
        }
      }
      if (newLogs.length > 0 && !cancelled) {
        setParseLogs((prev) => [...prev, ...newLogs]);
      }
    };

    let interval = 2000;
    const maxInterval = 10000;
    let timer: number;
    const schedule = () => {
      timer = window.setTimeout(async () => {
        await pollJobs();
        if (!cancelled && !pollingHalted) {
          interval = Math.min(interval * 1.5, maxInterval);
          schedule();
        }
      }, interval);
    };
    void pollJobs();
    schedule();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [createdCourseId, createdCourseIds, noSourcesSubmitted, step]);

  /* ---------- Auto-fill project name from Canvas ---------- */
  const autoFillCanvasName = useCallback(async (canvasUrl: string) => {
    try {
      const info = await fetchCanvasCourseInfo(canvasUrl);
      if (info.name && !projectNameRef.current.trim()) {
        setProjectName(info.name);
      }
    } catch { /* non-critical */ }
  }, []);

  /* ---------- Canvas URL add handler ---------- */
  const handleAddUrl = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed || !isCanvasUrl(trimmed)) return;

    try {
      const sessions = await listAuthSessions();
      const domain = new URL(trimmed).hostname;
      const match = sessions.find((s) => s.is_valid && domain.includes(s.domain));
      if (match) {
        setCanvasSessionValid(true);
        void autoFillCanvasName(trimmed);
        return;
      }
    } catch { /* prompt login anyway */ }

    setCanvasLoginError(null);
    setShowCanvasLogin(true);
    setCanvasLogging(true);
    try {
      await canvasBrowserLogin(trimmed);
      setCanvasSessionValid(true);
      setShowCanvasLogin(false);
      void autoFillCanvasName(trimmed);
    } catch (err) {
      setCanvasLoginError((err as Error).message || t("new.loginFailed"));
    } finally {
      setCanvasLogging(false);
    }
  }, [t, url, autoFillCanvasName]);

  /* ---------- Start parsing ---------- */
  const startParsing = useCallback(async () => {
    const unresolved = (uploadPlan?.unclassified ?? []).filter((file) => !fileAssignments[file.filename]);
    if (unresolved.length > 0) {
      setParseLogs([{ text: `请先确认 ${unresolved.map((file) => `「${file.filename}」`).join("、")} 的学科归属。`, color: "text-destructive" }]);
      return;
    }
    setStep("parsing");
    setIngestionJobs([]);
    setParseLogs([]);
    setIsSubmittingContent(true);
    setNoSourcesSubmitted(false);
    seenJobStatesRef.current = {};

    const addLog = (text: string, color: string) => {
      setParseLogs((prev) => [...prev, { text, color }]);
    };
    let nextCourseId: string | null = null;
    const nextCourseIds: string[] = [];

    try {
      const baseMetadata = {
        ...buildMetadata(features, false, "", "upload"),
        learning_mode: learningMode,
      };

      // Multi-subject split: when the plan detected more than one subject
      // group, create one learning space per group and upload each file to
      // its own space instead of mixing everything into one course.
      const plannedGroups = uploadPlan?.groups ?? [];
      // Choosing the unified destination for any file is an intentional
      // switch of grouping mode, so the batch cannot accidentally lose the
      // remaining files between separate group buckets.
      const combineAllFiles = files.length > 0 && Object.values(fileAssignments).includes("__all__");
      if (combineAllFiles) {
        const course = await addCourse(projectName.trim() || "综合学习空间", nlInput.trim() || undefined, baseMetadata, "SETUP");
        nextCourseId = course.id;
        nextCourseIds.push(course.id);
        setCreatedCourseId(course.id);
        addLog(`${new Date().toLocaleTimeString()}  已按你的选择将全部资料放入同一学习空间`, "text-success");
        await submitSources({ course, files, url: "", mode: "upload", autoScrape: false, canvasSessionValid, projectName: projectName || "综合学习空间", addLog, setCanvasSessionValid, setShowCanvasLogin, setCanvasLogging, setCanvasLoginError, setNoSourcesSubmitted, t });
        setCreatedCourseIds(nextCourseIds);
        return;
      }
      const suggestedGroupByFile = Object.fromEntries(plannedGroups.flatMap((group) => group.files.map((file) => [file.filename, group.key])));
      const filesByTarget = files.reduce<Record<string, FileItem[]>>((result, file) => {
        const target = fileAssignments[file.name] ?? suggestedGroupByFile[file.name];
        if (target) result[target] = [...(result[target] ?? []), file];
        return result;
      }, {});
      const separateFiles = filesByTarget.__separate__ ?? [];
      const selectedGroups = plannedGroups.filter((group) => (filesByTarget[group.key] ?? []).length > 0);
      const multiGroups = selectedGroups.length > 0 || separateFiles.length > 0 ? selectedGroups : null;

      if (multiGroups) {
        for (const group of multiGroups) {
          const groupFiles = filesByTarget[group.key] ?? [];
          addLog(
            `${new Date().toLocaleTimeString()}  检测到「${group.subject ?? "未知学科"}」${groupFiles.length} 份资料，创建学习空间「${group.suggested_name}」`,
            "text-muted-foreground",
          );
          const metadata = {
            ...baseMetadata,
            subject: group.subject ?? undefined,
            grade: group.grade ?? undefined,
            publisher: group.publisher ?? undefined,
            volume: group.volume ?? undefined,
          };
          const course = await addCourse(group.suggested_name, undefined, metadata, "SETUP");
          nextCourseIds.push(course.id);
          setCreatedCourseIds([...nextCourseIds]);
          if (!nextCourseId) {
            nextCourseId = course.id;
            setCreatedCourseId(course.id);
          }
          addLog(`${new Date().toLocaleTimeString()}  ${t("new.logProjectCreated")}`, "text-success");
          await submitSources({
            course, files: groupFiles, url: "", mode: "upload", autoScrape: false, canvasSessionValid, projectName: group.suggested_name,
            addLog, setCanvasSessionValid, setShowCanvasLogin, setCanvasLogging,
            setCanvasLoginError, setNoSourcesSubmitted, t,
          });
        }
        if (separateFiles.length > 0) {
          const course = await addCourse("待确认资料", undefined, baseMetadata, "SETUP");
          nextCourseIds.push(course.id);
          setCreatedCourseIds([...nextCourseIds]);
          await submitSources({ course, files: separateFiles, url: "", mode: "upload", autoScrape: false, canvasSessionValid, projectName: "待确认资料", addLog, setCanvasSessionValid, setShowCanvasLogin, setCanvasLogging, setCanvasLoginError, setNoSourcesSubmitted, t });
        }
      } else {
        // Single group (or no plan): keep the original single-space flow,
        // enriching metadata with detected subject info when available.
        const group = uploadPlan?.groups[0];
        const metadata = {
          ...baseMetadata,
          subject: group?.subject ?? undefined,
          grade: group?.grade ?? undefined,
          publisher: group?.publisher ?? undefined,
          volume: group?.volume ?? undefined,
        };
        addLog(`${new Date().toLocaleTimeString()}  ${t("new.logCreatingProject")} "${projectName || t("new.untitled")}"...`, "text-muted-foreground");

        const description = nlInput.trim() || undefined;
        const course = await addCourse(projectName.trim() || t("new.untitledProject"), description, metadata, "SETUP");
        nextCourseId = course.id;
        nextCourseIds.push(course.id);
        setCreatedCourseId(course.id);
        setCreatedCourseIds([...nextCourseIds]);
        addLog(`${new Date().toLocaleTimeString()}  ${t("new.logProjectCreated")}`, "text-success");

        await submitSources({
          course, files, url: "", mode: "upload", autoScrape: false, canvasSessionValid, projectName,
          addLog, setCanvasSessionValid, setShowCanvasLogin, setCanvasLogging,
          setCanvasLoginError, setNoSourcesSubmitted, t,
        });
      }
      setCreatedCourseIds(nextCourseIds);
    } catch (err) {
      addLog(`${new Date().toLocaleTimeString()}  ${t("new.logError")}: ${(err as Error).message}`, "text-destructive");
    } finally {
      setIsSubmittingContent(false);
      if (nextCourseId) void fetchContentTree(nextCourseId).catch(() => undefined);
    }
  }, [
    addCourse,
    autoScrape,
    canvasSessionValid,
    features,
    fetchContentTree,
    files,
    learningMode,
    mode,
    nlInput,
    projectName,
    t,
    fileAssignments,
    uploadPlan,
    url,
  ]);

  /* ---------- Confirm parsing result, publish, then enter ---------- */
  const confirmParsedSpaces = useCallback(async () => {
    if (!createdCourseIds.length && !createdCourseId) return;
    const ids = createdCourseIds.length ? createdCourseIds : [createdCourseId!];
    const layout = buildLayoutFromMode(learningMode);
    await Promise.all(ids.map(async (id) => {
      const metadata = { ...buildMetadata(features, false, "", "upload"), learning_mode: learningMode, spaceLayout: layout };
      await updateCourse(id, { metadata });
      await activateCourse(id);
      provisionalCourseIdsRef.current = provisionalCourseIdsRef.current.filter((value) => value !== id);
    }));
    // A multi-subject upload has no arbitrary "first" destination. Return
    // to the dashboard where both newly published spaces are visible.
    router.push(ids.length === 1 ? `/course/${ids[0]}` : "/");
  }, [autoScrape, createdCourseId, createdCourseIds, features, learningMode, mode, router, url]);

  /* ---------- Enter workspace ---------- */
  const enterWorkspace = useCallback(async (courseId = createdCourseId) => {
    if (!courseId) return;
    const layout = buildLayoutFromMode(learningMode);
    const metadata = {
      ...buildMetadata(features, false, "", "upload"),
      learning_mode: learningMode,
      spaceLayout: layout,
    };

    // Prime workspace state so the first paint on /course is mode-correct.
    useWorkspaceStore.getState().loadBlocks(layout);
    persistCourseSpaceLayoutLocally(courseId, layout);

    try { await updateCourse(courseId, { metadata }); } catch { /* metadata can recover later */ }
    await activateCourse(courseId);
    provisionalCourseIdsRef.current = provisionalCourseIdsRef.current.filter((value) => value !== courseId);
    if (nlInput.trim()) try { localStorage.setItem(`course_init_prompt_${courseId}`, nlInput.trim()); } catch { /* quota */ }
    router.push(`/course/${courseId}`);
  }, [autoScrape, createdCourseId, features, learningMode, mode, nlInput, router, url]);

  return {
    router, t, step, setStep,
    mode,
    learningMode, setLearningMode,
    projectName, setProjectName, nameError, validateName,
    files, setFiles,
    url, setUrl, urlError, validateUrl, isCanvasDetected, canvasSessionValid, handleAddUrl,
    autoScrape,
    features, toggleFeature, nlInput, setNlInput,
    showCanvasLogin, setShowCanvasLogin, canvasLogging, canvasLoginError,
    parseSteps, parseProgress, parseLogs, ingestionJobs, canContinueToFeatures, allJobsFailed, hasFailedJob, processingState, readyCourseIds, createdCourseId,
    uploadPlan, fileAssignments, setFileAssignments, createdCourseIds,
    startParsing, confirmParsedSpaces, enterWorkspace,
    returnToUpload: async () => {
      const ids = createdCourseIds.length ? createdCourseIds : createdCourseId ? [createdCourseId] : [];
      // Returning to upload abandons this *unpublished* creation attempt.
      // Keeping a partially parsed SETUP course here caused every retry to
      // accumulate another hidden workspace, completed ingestion rows and
      // uploaded binaries.  The server-side cancel endpoint removes only the
      // provisional workspace and unreferenced processing artefacts; ACTIVE
      // learning spaces and learner data are never touched.
      await Promise.all(ids.map((id) => cancelSetupCourse(id).catch(() => undefined)));
      setCreatedCourseId(null); setCreatedCourseIds([]);
      setIngestionJobs([]); setParseLogs([]); setStep("upload");
    },
  };
}
