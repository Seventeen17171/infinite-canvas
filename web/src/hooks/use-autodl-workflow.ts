"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { autoDLChannelId } from "@/lib/autodl";
import { fetchAutoDLWorkflow, fetchAutoDLWorkflows } from "@/services/api/autodl";
import type { AiConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export function useAutoDLWorkflow(config: AiConfig, model = config.model) {
    const token = useUserStore((state) => state.token);
    const channelId = autoDLChannelId(config, model);
    const enabled = Boolean(token && channelId && model);
    return useQuery({
        queryKey: ["autodl", token, channelId, model],
        queryFn: () => fetchAutoDLWorkflow(token, channelId, model),
        enabled,
        staleTime: 0,
        gcTime: 0,
        refetchOnMount: "always",
    });
}

type AutoDLChannel = { id?: string; protocol?: string };

export function useAutoDLWorkflowNames(channels: AutoDLChannel[]) {
    const token = useUserStore((state) => state.token);
    const channelIds = [...new Set(channels.flatMap((channel) => channel.protocol === "autodl" && channel.id ? [channel.id] : []))];
    const queries = useQueries({ queries: channelIds.map((channelId) => ({
        queryKey: ["autodl", token, channelId, "workflows"],
        queryFn: () => fetchAutoDLWorkflows(token, channelId),
        enabled: Boolean(token && channelId),
        staleTime: 0,
        gcTime: 0,
        refetchOnMount: "always" as const,
    })) });
    return (model: string, channel?: AutoDLChannel | null) => {
        if (!token || channel?.protocol !== "autodl" || !channel.id) return model;
        return queries[channelIds.indexOf(channel.id)]?.data?.find((workflow) => workflow.uuid === model)?.name || model;
    };
}
