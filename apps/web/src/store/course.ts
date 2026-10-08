/**
 * Course store using Zustand.
 * Reference: lobe-chat Zustand patterns.
 */

import { t } from "@/lib/i18n";
import { create } from "zustand";
import {
  Course,
  CourseMetadata,
  ContentNode,
  IngestionJobSummary,
  listCourseOverview,
  createCourse,
  deleteCourse as deleteCourseRequest,
  getContentTree,
  listIngestionJobs,
} from "@/lib/api";
import { ttlCache } from "@/lib/cache";

/** Cache key & TTL for the course overview list (dashboard). */
const COURSES_CACHE_KEY = "courses:overview";
const COURSES_TTL_MS = 60_000; // 60 seconds

interface CourseState {
  courses: Course[];
  activeCourse: Course | null;
  contentTree: ContentNode[];
  /** Course owning contentTree; prevents a previous workspace tree validating a new deep link. */
  contentTreeCourseId: string | null;
  ingestionJobs: IngestionJobSummary[];
  loading: boolean;
  error: string | null;

  fetchCourses: () => Promise<void>;
  setActiveCourse: (course: Course | null) => void;
  addCourse: (name: string, description?: string, metadata?: CourseMetadata, status?: "ACTIVE" | "SETUP") => Promise<Course>;
  removeCourse: (courseId: string) => Promise<void>;
  fetchContentTree: (courseId: string) => Promise<void>;
  fetchIngestionJobs: (courseId: string) => Promise<void>;
}

export const useCourseStore = create<CourseState>((set, get) => ({
  courses: [],
  activeCourse: null,
  contentTree: [],
  contentTreeCourseId: null,
  ingestionJobs: [],
  loading: false,
  error: null,

  fetchCourses: async () => {
    // Return cached data immediately if still fresh.
    const cached = ttlCache.get<Course[]>(COURSES_CACHE_KEY);
    if (cached) {
      set({ courses: cached, loading: false, error: null });
      return;
    }

    set({ loading: true, error: null });
    try {
      const courses = await listCourseOverview();
      ttlCache.set(COURSES_CACHE_KEY, courses, COURSES_TTL_MS);
      set({ courses, loading: false, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("ui.failed_load_courses");
      set({ loading: false, error: message });
    }
  },

  setActiveCourse: (course) => {
    set({ activeCourse: course, contentTree: [], contentTreeCourseId: null, error: null });
    if (course) {
      get().fetchContentTree(course.id);
    }
  },

  addCourse: async (name, description, metadata, status) => {
    const course = await createCourse(name, description, metadata, status);
    ttlCache.invalidate(COURSES_CACHE_KEY);
    set((s) => ({ courses: [course, ...s.courses], error: null }));
    return course;
  },

  removeCourse: async (courseId) => {
    await deleteCourseRequest(courseId);
    ttlCache.invalidate(COURSES_CACHE_KEY);
    set((state) => ({
      courses: state.courses.filter((course) => course.id !== courseId),
      activeCourse: state.activeCourse?.id === courseId ? null : state.activeCourse,
      contentTree: state.activeCourse?.id === courseId ? [] : state.contentTree,
      contentTreeCourseId: state.activeCourse?.id === courseId ? null : state.contentTreeCourseId,
      ingestionJobs: state.activeCourse?.id === courseId ? [] : state.ingestionJobs,
      error: null,
    }));
  },

  fetchContentTree: async (courseId) => {
    try {
      const tree = await getContentTree(courseId);
      set({ contentTree: tree, contentTreeCourseId: courseId, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("ui.failed_load_content");
      set({ error: message });
    }
  },

  fetchIngestionJobs: async (courseId) => {
    try {
      const jobs = await listIngestionJobs(courseId);
      set({ ingestionJobs: jobs, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : t("ui.failed_load_jobs");
      set({ error: message });
    }
  },
}));
