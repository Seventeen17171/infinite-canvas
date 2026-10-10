import { ApiError, apiGet, apiPost, apiPut } from "./request";

export type AssetCategory = "character" | "scene";
export type ProductionAsset = {
    id: string;
    projectId: string;
    category: AssetCategory;
    name: string;
    description: string;
    revision: number;
    createdBy: string;
    updatedBy: string;
    createdAt: string;
    updatedAt: string;
};
export type AssetInput = { category: AssetCategory; name: string; description: string; requestId: string };
export type AssetSaveInput = { name: string; description: string; revision: number; requestId: string };
export type AssetReceipt = Pick<ProductionAsset, "id" | "projectId" | "revision" | "updatedAt"> & { requestId: string };
export type AssetList = { items: ProductionAsset[]; total: number; counts: Record<AssetCategory, number> };
const base = (projectId: string) => `/api/v1/production/projects/${encodeURIComponent(projectId)}/assets`;
const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function checkedAsset(asset: ProductionAsset, projectId: string, id?: string) {
    if (!asset || typeof asset.id !== "string" || !asset.id || (id && asset.id !== id) || asset.projectId !== projectId || !["character", "scene"].includes(asset.category) || typeof asset.name !== "string" || typeof asset.description !== "string" || !integer(asset.revision) || asset.revision < 1 || typeof asset.createdAt !== "string" || typeof asset.updatedAt !== "string") {
        throw new ApiError("资产响应异常，请重试确认结果", 502);
    }
    return asset;
}
export async function fetchProductionAssets(token: string, projectId: string, query: { category?: AssetCategory; q?: string; page?: number; pageSize?: number } = {}, signal?: AbortSignal) {
    const result = await apiGet<AssetList>(base(projectId), query, token, 30_000, signal);
    if (!result || !Array.isArray(result.items) || !integer(result.total) || !integer(result.counts?.character) || !integer(result.counts?.scene)) throw new ApiError("资产列表响应异常，请重试", 502);
    result.items.forEach((asset) => checkedAsset(asset, projectId));
    return result;
}
export async function fetchProductionAsset(token: string, projectId: string, id: string) {
    return checkedAsset(await apiGet<ProductionAsset>(`${base(projectId)}/${encodeURIComponent(id)}`, undefined, token, 30_000), projectId, id);
}
export async function createProductionAsset(token: string, projectId: string, input: AssetInput) {
    const asset = checkedAsset(await apiPost<ProductionAsset>(base(projectId), input, token, 30_000), projectId);
    if (asset.category !== input.category) throw new ApiError("创建回执异常，请使用原请求重试", 502);
    return asset;
}
export async function saveProductionAsset(token: string, projectId: string, id: string, input: AssetSaveInput) {
    const receipt = await apiPut<AssetReceipt>(`${base(projectId)}/${encodeURIComponent(id)}`, input, token, 30_000);
    if (!receipt || receipt.id !== id || receipt.projectId !== projectId || receipt.requestId !== input.requestId || !integer(receipt.revision) || receipt.revision !== input.revision + 1 || typeof receipt.updatedAt !== "string") throw new ApiError("保存回执异常，请使用原请求重试", 502);
    return receipt;
}
