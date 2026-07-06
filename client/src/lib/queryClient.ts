import { QueryClient } from "@tanstack/react-query";
// refetchOnWindowFocus: PWA/탭을 다시 볼 때 서버 데이터로 자동 갱신.
// false였을 때 배포·외부 변경(MCP 등) 후 옛 화면이 계속 남아 보이는 문제가 있었음 (2026-07-07).
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 10_000 } },
});
