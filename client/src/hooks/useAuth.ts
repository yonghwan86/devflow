import { useQuery } from "@tanstack/react-query";
import { get } from "../lib/api";

export interface Me {
  id: number;
  email: string;
  full_name: string | null;
  is_admin?: boolean;
}
export function useAuth() {
  const q = useQuery<{ user: Me | null }>({
    queryKey: ["me"],
    queryFn: () => get("/auth/me"),
  });
  return { user: q.data?.user ?? null, isLoading: q.isLoading, refetch: q.refetch };
}
