"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/services/api/request";
import { fetchProductionProject, type ProductionProject, type WorkspaceKind } from "@/services/api/production-projects";
import { useUserStore } from "@/stores/use-user-store";

export function useProject(id: string, kind?: WorkspaceKind) {
    const token = useUserStore((state) => state.token);
    const sessionRevision = useUserStore((state) => state.sessionRevision);
    const queryClient = useQueryClient();
    const queryKey = ["production", "project", token, sessionRevision, id];
    const query = useQuery({
        queryKey,
        queryFn: async ({ signal }): Promise<ProductionProject | null> => {
            try {
                return await fetchProductionProject(token, id);
            } catch (error) {
                // A later network failure must not revive data whose access was denied.
                if (!signal.aborted && error instanceof ApiError && [401, 403, 404].includes(error.status)) {
                    queryClient.setQueryData(queryKey, null);
                }
                throw error;
            }
        },
        select: (project) => {
            if (!project) return { project: undefined, workspace: undefined };
            const workspace = kind ? project.workspaces.find((item) => item.kind === kind) : undefined;
            if (kind && !workspace) throw new ApiError("工作台不存在", 404);
            return { project, workspace };
        },
        enabled: Boolean(token && id),
        retry: false,
        staleTime: 0,
        gcTime: 0,
        refetchOnMount: "always",
    });
    useEffect(() => {
        if (query.error instanceof ApiError && query.error.status === 401 && useUserStore.getState().token === token && useUserStore.getState().sessionRevision === sessionRevision) useUserStore.getState().clearSession();
    }, [query.error, token, sessionRevision]);
    return query;
}
