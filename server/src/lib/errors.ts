// Consistent error envelope (§8: stable contract for MCP wrapping later).
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const err = {
  unauthorized: (m = "인증이 필요합니다.") => new ApiError(401, "unauthorized", m),
  forbidden: (m = "권한이 없습니다.") => new ApiError(403, "forbidden", m),
  notFound: (m = "찾을 수 없습니다.") => new ApiError(404, "not_found", m),
  badRequest: (m = "잘못된 요청입니다.") => new ApiError(400, "bad_request", m),
  conflict: (m = "충돌이 발생했습니다.") => new ApiError(409, "conflict", m),
  tooMany: (m = "요청이 너무 많습니다.") => new ApiError(429, "rate_limited", m),
};
