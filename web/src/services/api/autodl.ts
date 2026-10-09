import { apiPost } from "@/services/api/request";

export type AutoDLInputRule = {
    type: string;
    required?: boolean;
    default?: string | number;
    min?: number;
    max?: number;
};

export type AutoDLWorkflow = {
    uuid: string;
    name: string;
    kind: "video" | "audio" | "unsupported";
    input_rules?: Record<string, AutoDLInputRule>;
};

export async function fetchAutoDLWorkflows(token: string, channelId: string) {
    if (!token || !channelId.trim()) throw new Error("请登录并选择后台已开放的 AutoDL 渠道");
    return apiPost<AutoDLWorkflow[]>("/api/v1/model-channels/autodl/workflows", { channelId }, token);
}

export async function fetchAutoDLWorkflow(token: string, channelId: string, workflowId: string) {
    if (!token || !channelId.trim() || !workflowId.trim()) throw new Error("请登录并选择后台已开放的 AutoDL 模型");
    return apiPost<AutoDLWorkflow>("/api/v1/model-channels/autodl/workflows", { channelId, workflowId }, token);
}
