// Teacher registry. To add a teacher: drop config/teachers/<id>.json and add one line below.
import professorWhiskers from "../../../config/teachers/professor-whiskers.json";
import templateTeacher from "../../../config/teachers/template-teacher.json";
import { validateTeacher, type TeacherConfig } from "./teacher";

export const TEACHER_FILES: Record<string, unknown> = {
  "professor-whiskers": professorWhiskers,
  "template-teacher": templateTeacher,
};

export const DEFAULT_TEACHER = "professor-whiskers";

/** Loads and validates a teacher by id. Unknown or invalid ids fall back to Professor Whiskers. */
export function loadTeacher(id: string): TeacherConfig {
  const raw = TEACHER_FILES[id] ?? TEACHER_FILES[DEFAULT_TEACHER];
  const v = validateTeacher(raw);
  if (v.ok) return v.teacher;
  const fallback = validateTeacher(TEACHER_FILES[DEFAULT_TEACHER]);
  if (!fallback.ok) throw new Error(`default teacher invalid: ${fallback.errors.join("; ")}`);
  console.error(JSON.stringify({ level: "error", message: "teacher config invalid, using default", id, errors: v.errors }));
  return fallback.teacher;
}
