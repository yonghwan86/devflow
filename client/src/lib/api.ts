// Fetch wrapper with consistent error envelope handling.
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T = unknown>(
  path: string,
  opts: RequestInit = {},
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    // X-DevFlow-CSRF: 세션 인증 mutating 요청의 CSRF 방어 헤더(R0-3, 서버 middleware/csrf.ts)
    headers: { "Content-Type": "application/json", "X-DevFlow-CSRF": "1", ...(opts.headers ?? {}) },
    ...opts,
  });
  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : null;
  if (!res.ok) {
    const e = body?.error ?? { code: "error", message: `요청 실패 (${res.status})` };
    throw new ApiError(res.status, e.code, e.message);
  }
  return body as T;
}

export const get = <T>(p: string) => api<T>(p);
export const post = <T>(p: string, data?: unknown) =>
  api<T>(p, { method: "POST", body: data ? JSON.stringify(data) : undefined });
export const patch = <T>(p: string, data?: unknown) =>
  api<T>(p, { method: "PATCH", body: data ? JSON.stringify(data) : undefined });
export const put = <T>(p: string, data?: unknown) =>
  api<T>(p, { method: "PUT", body: data ? JSON.stringify(data) : undefined });
export const del = <T>(p: string) => api<T>(p, { method: "DELETE" });

// Multipart upload (files). Does not set JSON content-type (browser sets boundary).
export async function upload<T = unknown>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "X-DevFlow-CSRF": "1" }, // R0-3
    body: form,
  });
  const body = res.headers.get("content-type")?.includes("application/json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? "error", body?.error?.message ?? "업로드 실패");
  return body as T;
}
