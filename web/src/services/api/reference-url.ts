import { resolveMediaUrl, uploadRemoteMediaToServer } from "@/services/file-storage";
import { resolveImageUrl } from "@/services/image-storage";
import { getStorageObjectInfo } from "./storage";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export async function autoDLReferenceURL(reference: ReferenceImage | ReferenceVideo | ReferenceAudio, providerName = "AutoDL") {
    for (const value of [reference.url, "dataUrl" in reference ? reference.dataUrl : ""]) {
        const url = publicReferenceURL(value);
        if (url) return url;
    }
    const storedUrl = await storedReferenceURL(reference.storageKey);
    if (storedUrl) return storedUrl;
    if (reference.storageKey?.startsWith("server:")) throw new Error(`${providerName} 参考素材需要云存储提供可公开访问的地址`);
    const source = "dataUrl" in reference ? await resolveImageUrl(reference.storageKey, reference.dataUrl || reference.url || "") : await resolveMediaUrl(reference.storageKey, reference.url);
    if (!source) throw new Error("参考素材不可用");
    const uploaded = await uploadRemoteMediaToServer(source, reference.name || "reference");
    const url = publicReferenceURL(uploaded.url) || (await storedReferenceURL(uploaded.storageKey));
    if (!url) throw new Error(`${providerName} 参考素材需要云存储提供可公开访问的地址`);
    return url;
}

async function storedReferenceURL(storageKey?: string) {
    if (!storageKey?.startsWith("server:") || storageKey.startsWith("server:webdav:")) return "";
    const info = await getStorageObjectInfo(storageKey.slice("server:".length));
    return publicReferenceURL(info.publicUrl);
}

function publicReferenceURL(value?: string) {
    if (!value || !/^https?:\/\//i.test(value)) return "";
    try {
        const url = new URL(value);
        return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ? "" : url.href;
    } catch {
        return "";
    }
}
