"use client";

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@/services/api/request";
import { fetchProductionProject, fetchProductionWorkspace, type WorkspaceKind } from "@/services/api/production-projects";
import { useUserStore } from "@/stores/use-user-store";

export function useProject(id: string, kind?: WorkspaceKind) {
    const token = useUserStore((state) => state.token);
    const query = useQuery({
        queryKey: ["production", "project", token, id, kind || "overview"],
        queryFn: async () => (kind ? fetchProductionWorkspace(token, id, kind) : { project: await fetchProductionProject(token, id), workspace: undefined }),
        enabled: Boolean(token && id),
        retry: false,
        staleTime: 0,
        gcTime: 0,
        refetchOnMount: "always",
    });
    useEffect(() => {
        if (query.error instanceof ApiError && query.error.status === 401 && useUserStore.getState().token === token) useUserStore.getState().clearSession();
    }, [query.error, token]);
    return query;
}
