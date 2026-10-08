"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { emptyCourseTrash, listTrashedCourses, permanentlyDeleteCourse, restoreCourse, type Course } from "@/lib/api/courses";

export default function TrashPage() {
  const router = useRouter();
  const [courses, setCourses] = useState<Course[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => listTrashedCourses().then(setCourses).catch(() => setCourses([]));
  useEffect(() => { load(); }, []);
  const permanent = async (id: string) => {
    if (!window.confirm("永久删除后无法恢复，相关学习记录也会被清除。")) return;
    setBusy(id); try { await permanentlyDeleteCourse(id); await load(); } finally { setBusy(null); }
  };
  const empty = async () => {
    if (!window.confirm("永久删除后无法恢复，相关学习记录也会被清除。")) return;
    setBusy("all"); try { await emptyCourseTrash(); await load(); } finally { setBusy(null); }
  };
  return <main className="mx-auto max-w-3xl p-6"><div className="flex items-center justify-between gap-3"><div><h1 className="text-2xl font-bold">垃圾桶</h1><p className="mt-1 text-sm text-muted-foreground">已删除的学习空间可恢复；永久删除会同时清理关联学习数据。</p></div><button className="text-sm text-brand" onClick={() => router.push("/")}>返回首页</button></div><div className="mt-6 space-y-3">{courses.map((course) => <div key={course.id} className="flex items-center justify-between rounded-xl border p-4"><div><p className="font-medium">{course.name}</p><p className="text-xs text-muted-foreground">删除时间：{course.deleted_at ? new Date(course.deleted_at).toLocaleString() : "-"}</p></div><div className="flex gap-2"><button disabled={busy !== null} className="rounded-md border px-3 py-1.5 text-sm" onClick={async () => { setBusy(course.id); try { await restoreCourse(course.id); await load(); } finally { setBusy(null); } }}>恢复</button><button disabled={busy !== null} className="rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground" onClick={() => permanent(course.id)}>永久删除</button></div></div>)}{courses.length === 0 && <p className="py-12 text-center text-sm text-muted-foreground">垃圾桶为空</p>}</div>{courses.length > 0 && <button disabled={busy !== null} className="mt-5 rounded-md border border-destructive px-3 py-2 text-sm text-destructive" onClick={empty}>清空垃圾桶</button>}</main>;
}
