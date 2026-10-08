import { updateCourseLayout } from "@/lib/api";
import type { SpaceLayout } from "./types";
import { updateUnlockContext } from "./feature-unlock";
import { saveStoredSpaceLayout } from "./layout-storage";

export function persistCourseSpaceLayoutLocally(courseId: string, layout: SpaceLayout): SpaceLayout {
  const persistedLayout = saveStoredSpaceLayout(courseId, layout);
  if (persistedLayout.mode) {
    updateUnlockContext(courseId, { mode: persistedLayout.mode });
  }
  return persistedLayout;
}

export async function syncCourseSpaceLayout(courseId: string, layout: SpaceLayout): Promise<SpaceLayout> {
  // The server owns the workspace. Cache only an acknowledged layout so a
  // failed optimistic edit can never overwrite the next server read.
  const response = await updateCourseLayout(courseId, layout);
  return persistCourseSpaceLayoutLocally(courseId, response.layout as unknown as SpaceLayout);
}
