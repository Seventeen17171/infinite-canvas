import { ApiError, apiGet, apiPut } from "./request";

export const creativeAspectRatios = ["auto", "1:1", "4:3", "3:4", "16:9", "9:16"] as const;
export const creativeResolutions = ["auto", "1K", "2K", "4K"] as const;
export type CreativeFields = {
    prompt: string;
    modelChannelId: string;
    modelName: string;
    aspectRatio: typeof creativeAspectRatios[number];
    resolution: typeof creativeResolutions[number];
    imageCount: number;
};
export type AssetCreative = CreativeFields & { projectId: string; assetId: string; revision: number; updatedAt: string };
export type CreativeModel = { channelId: string; channelName: string; model: string; protocol: string };
export type CreativeResponse = { creative: AssetCreative; models: CreativeModel[] };
export type CreativeSaveInput = CreativeFields & { revision: number; requestId: string };
export type CreativeReceipt = Pick<AssetCreative, "projectId" | "assetId" | "revision" | "updatedAt"> & { requestId: string };
export const emptyCreative: CreativeFields = { prompt: "", modelChannelId: "", modelName: "", aspectRatio: "auto", resolution: "auto", imageCount: 1 };
const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const base = (projectId: string, assetId: string) => `/api/v1/production/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}/creative`;

export function validCreativeFields(value: unknown): value is CreativeFields {
    if (!value || typeof value !== "object") return false;
    const fields = value as CreativeFields;
    return typeof fields.prompt === "string" && Array.from(fields.prompt).length <= 8000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(fields.prompt)
        && typeof fields.modelChannelId === "string" && typeof fields.modelName === "string" && Boolean(fields.modelChannelId) === Boolean(fields.modelName)
        && creativeAspectRatios.includes(fields.aspectRatio) && creativeResolutions.includes(fields.resolution)
        && Number.isInteger(fields.imageCount) && fields.imageCount >= 1 && fields.imageCount <= 4;
}

export async function fetchAssetCreative(token: string, projectId: string, assetId: string) {
    const result = await apiGet<CreativeResponse>(base(projectId, assetId), undefined, token, 30_000);
    const creative = result?.creative;
    if (!creative || creative.projectId !== projectId || creative.assetId !== assetId || !validCreativeFields(creative) || !integer(creative.revision) || typeof creative.updatedAt !== "string" || !Array.isArray(result.models)
        || result.models.some((model) => !model || typeof model.channelId !== "string" || !model.channelId || typeof model.channelName !== "string" || typeof model.model !== "string" || !model.model || typeof model.protocol !== "string")) {
        throw new ApiError("创意响应异常，请重试打开", 502);
    }
    return result;
}

export async function saveAssetCreative(token: string, projectId: string, assetId: string, input: CreativeSaveInput) {
    const receipt = await apiPut<CreativeReceipt>(base(projectId, assetId), input, token, 30_000);
    if (!receipt || receipt.projectId !== projectId || receipt.assetId !== assetId || receipt.requestId !== input.requestId || !integer(receipt.revision) || receipt.revision !== input.revision + 1 || typeof receipt.updatedAt !== "string") {
        throw new ApiError("创意保存回执异常，请使用原请求重试", 502);
    }
    return receipt;
}
