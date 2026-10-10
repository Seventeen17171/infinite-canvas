import { ApiError, apiGet, apiPost, compactApiParams } from "@/services/api/request";

export type BudgetStatus = "pending" | "approved" | "rejected";
export type BudgetApplication = {
    id: string; projectId: string; projectTitle: string; producerName: string;
    applicantId: string; applicantName: string; targetTotal: number; approvedTotal: number;
    reason: string; status: BudgetStatus; revision: number; decidedByName: string;
    decisionNote: string; createdAt: string; updatedAt: string;
};
export type ProjectBudget = { projectId: string; approvedTotal: number; revision: number; canApply: boolean; applications: BudgetApplication[]; totalApplications: number; applicationId?: string };
export type BudgetApplicationInput = { targetTotal: number; reason: string; requestId: string };
export type BudgetDecisionInput = { decision: "approved" | "rejected"; note: string; revision: number; requestId: string };
const projectBase = (id: string) => `/api/v1/production/projects/${encodeURIComponent(id)}`;
const adminBase = "/api/admin/production/budget-applications";
const timeout = 30_000;

function boundedInteger(value: number, min = 0, max = Number.MAX_SAFE_INTEGER) {
    return Number.isSafeInteger(value) && value >= min && value <= max;
}
function validApplication(value: BudgetApplication) {
    return value && typeof value.id === "string" && value.id.length > 0 && typeof value.projectId === "string" && value.projectId.length > 0
        && [value.projectTitle, value.producerName, value.applicantId, value.applicantName, value.reason, value.decidedByName, value.decisionNote, value.createdAt, value.updatedAt].every((item) => typeof item === "string")
        && ["pending", "approved", "rejected"].includes(value.status) && boundedInteger(value.targetTotal, 1, 1_000_000_000) && boundedInteger(value.approvedTotal, 0, 1_000_000_000) && boundedInteger(value.revision, 1);
}
function validateBudget(value: ProjectBudget, projectId: string) {
    if (!value || value.projectId !== projectId || !boundedInteger(value.approvedTotal, 0, 1_000_000_000) || !boundedInteger(value.revision) || typeof value.canApply !== "boolean" || !Array.isArray(value.applications) || !boundedInteger(value.totalApplications, value.applications.length) || !value.applications.every((item) => validApplication(item) && item.projectId === projectId)) throw new ApiError("预算回执不完整，请使用原申请重试", 502);
    return value;
}
export async function fetchProjectBudget(token: string, projectId: string) {
    return validateBudget(await apiGet<ProjectBudget>(`${projectBase(projectId)}/budget`, undefined, token, timeout), projectId);
}
export async function applyProjectBudget(token: string, projectId: string, input: BudgetApplicationInput) {
    const result = validateBudget(await apiPost<ProjectBudget>(`${projectBase(projectId)}/budget-applications`, input, token, timeout), projectId);
    if (typeof result.applicationId !== "string" || !result.applicationId) throw new ApiError("申请回执不完整，请使用原申请重试", 502);
    const application = result.applications.find((item) => item.id === result.applicationId);
    if (application && (application.targetTotal !== input.targetTotal || application.reason !== input.reason)) throw new ApiError("申请回执不匹配，请使用原申请重试", 502);
    return result;
}
export async function fetchBudgetApplications(token: string, query: { page: number; pageSize: number; status?: BudgetStatus }) {
    const result = await apiGet<{ items: BudgetApplication[]; total: number }>(adminBase, compactApiParams(query), token, timeout);
    if (!result || !Array.isArray(result.items) || !result.items.every(validApplication) || !boundedInteger(result.total, result.items.length)) throw new ApiError("申请列表返回异常，请重试", 502);
    return result;
}
export async function decideProjectBudget(token: string, projectId: string, id: string, input: BudgetDecisionInput) {
    const result = await apiPost<BudgetApplication>(`${adminBase}/${encodeURIComponent(id)}/decision`, input, token, timeout);
    if (!validApplication(result) || result.id !== id || result.projectId !== projectId || result.status !== input.decision || result.revision !== input.revision + 1 || result.decisionNote !== input.note) throw new ApiError("审批回执不完整，请使用原决定重试", 502);
    return result;
}
