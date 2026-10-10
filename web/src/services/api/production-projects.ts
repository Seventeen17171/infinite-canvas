import { ApiError, apiGet, apiPost, compactApiParams } from "@/services/api/request";

export type WorkspaceKind = "canvas" | "assets";
export type ProductionWorkspace = { id: string; projectId: string; kind: WorkspaceKind; createdAt: string };
export type ProductionProject = {
    id: string;
    title: string;
    summary: string;
    createdBy: string;
    producerId: string;
    revision: number;
    createdAt: string;
    updatedAt: string;
    creatorName: string;
    producerName: string;
    canAssign: boolean;
    workspaces: ProductionWorkspace[];
};
export type Producer = { id: string; username: string; displayName: string };
export type ProjectInput = { title: string; summary: string; producerId: string; requestId: string };
const base = "/api/v1/production";

export function fetchProductionProjects(token: string, query: { keyword?: string; page?: number; pageSize?: number } = {}) {
    return apiGet<{ items: ProductionProject[]; total: number }>(`${base}/projects`, compactApiParams(query), token, 30_000);
}
export async function createProductionProject(token: string, input: ProjectInput) {
    const result = await apiPost<ProductionProject>(`${base}/projects`, input, token, 30_000);
    if (!result || typeof result.id !== "string" || !result.id || typeof result.producerId !== "string" || !result.producerId || !Number.isSafeInteger(result.revision) || result.revision < 1) throw new ApiError("创建回执不完整，请使用原请求重试", 502);
    return result;
}
export function fetchProducers(token: string) {
    return apiGet<{ items: Producer[] }>(`${base}/producers`, undefined, token, 30_000);
}
export function fetchProductionProject(token: string, id: string) {
    return apiGet<ProductionProject>(`${base}/projects/${encodeURIComponent(id)}`, undefined, token, 30_000);
}
export function fetchProductionWorkspace(token: string, id: string, kind: WorkspaceKind) {
    return apiGet<{ project: ProductionProject; workspace: ProductionWorkspace }>(`${base}/projects/${encodeURIComponent(id)}/workspaces/${kind}`, undefined, token, 30_000);
}
export function assignProductionProject(token: string, id: string, producerId: string, revision: number) {
    return apiPost<ProductionProject>(`${base}/projects/${encodeURIComponent(id)}/assignment`, { producerId, revision }, token, 30_000);
}
