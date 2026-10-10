"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/services/api/request";
import { fetchCanvasDocument, type ProductionCanvasContent } from "@/services/api/production-canvas-documents";
import { fetchProductionFile, fetchProductionFileBlob } from "@/services/api/production-files";
import { useUserStore } from "@/stores/use-user-store";
import { decodeReferenceImage, imageReferenceKey, visibleImageReferences } from "./image-reference";

type ImageView = { phase: "loading" | "ready" | "error"; url?: string; message?: string };
export const imageReadError = (error: unknown) => error instanceof Error ? error.message : "图片读取失败，请重新加载";
export async function checkImageAccess(error: unknown, token: string, projectId: string, documentId: string) {
    if (!(error instanceof ApiError) || ![401, 403, 404].includes(error.status)) return;
    if (error.status === 401) throw error;
    // A missing file must not erase a readable document. Recheck the document before blocking it.
    await fetchCanvasDocument(token, projectId, documentId);
}

export function useCanvasImages(projectId: string, documentId: string, content: ProductionCanvasContent, size: { width: number; height: number }, enabled: boolean, onDenied: (error: unknown) => void) {
    const token = useUserStore((state) => state.token);
    const actor = useUserStore((state) => state.user?.id || "");
    const revision = useUserStore((state) => state.sessionRevision);
    const [preferred, setPreferred] = useState("");
    const [epoch, setEpoch] = useState(0);
    const [visible, setVisible] = useState(true);
    const references = visibleImageReferences(content.nodes, content.viewport, size, preferred);
    const keys = references.map(imageReferenceKey).join("|");
    const scope = `${revision}:${actor}:${projectId}:${documentId}:${enabled}:${visible}:${epoch}:${keys}`;
    const identity = useRef({ scope, token });
    identity.current = { scope, token };
    const callbacks = useRef(onDenied);
    callbacks.current = onDenied;
    const [view, setView] = useState<{ scope: string; token: string; images: Record<string, ImageView> }>({ scope, token, images: {} });
    const release = useRef<() => void>(() => {});

    useEffect(() => {
        const hide = () => { release.current(); setVisible(false); };
        const refresh = () => { release.current(); setEpoch((value) => value + 1); setVisible(document.visibilityState === "visible"); };
        const visibility = () => document.visibilityState === "hidden" ? hide() : refresh();
        document.addEventListener("visibilitychange", visibility);
        window.addEventListener("focus", refresh);
        window.addEventListener("pagehide", hide);
        return () => { document.removeEventListener("visibilitychange", visibility); window.removeEventListener("focus", refresh); window.removeEventListener("pagehide", hide); };
    }, []);

    useEffect(() => {
        let alive = true;
        const controller = new AbortController();
        const urls = new Set<string>();
        const images: Record<string, ImageView> = {};
        const active = () => alive && !controller.signal.aborted && identity.current.scope === scope && identity.current.token === token && useUserStore.getState().token === token && useUserStore.getState().sessionRevision === revision && document.visibilityState === "visible";
        const publish = () => { if (active()) setView({ scope, token, images: { ...images } }); };
        const cleanup = () => {
            alive = false; controller.abort(); urls.forEach((url) => URL.revokeObjectURL(url)); urls.clear();
            setView((current) => current.scope === scope && current.token === token ? { scope, token, images: {} } : current);
        };
        release.current = cleanup;
        setView({ scope, token, images: {} });
        if (!enabled || !visible || !token || !actor || !active()) return cleanup;
        references.forEach((reference) => { images[imageReferenceKey(reference)] = { phase: "loading" }; });
        publish();
        let next = 0;
        async function worker() {
            while (active() && next < references.length) {
                const reference = references[next++], key = imageReferenceKey(reference);
                let url = "";
                try {
                    const file = await fetchProductionFile(token, projectId, reference.assetId, reference.fileId, controller.signal);
                    if (!active()) return;
                    const blob = await fetchProductionFileBlob(token, projectId, reference.assetId, file, false, controller.signal);
                    if (!active()) return;
                    url = URL.createObjectURL(blob); urls.add(url);
                    await decodeReferenceImage(url, controller.signal);
                    if (!active()) return;
                    images[key] = { phase: "ready", url };
                } catch (error) {
                    if (url) { URL.revokeObjectURL(url); urls.delete(url); }
                    if (!active()) return;
                    try { await checkImageAccess(error, token, projectId, documentId); }
                    catch (denial) {
                        if (active()) {
                            cleanup();
                            if (denial instanceof ApiError && [401, 403, 404].includes(denial.status)) callbacks.current(denial);
                            else setView({ scope, token, images: Object.fromEntries(references.map((item) => [imageReferenceKey(item), { phase: "error", message: "暂时无法确认图片访问权限，请重新加载" }])) });
                        }
                        return;
                    }
                    if (!active()) return;
                    images[key] = { phase: "error", message: imageReadError(error) };
                }
                publish();
            }
        }
        void worker(); void worker();
        return cleanup;
    }, [scope, token]);

    return {
        images: view.scope === scope && view.token === token && visible && enabled ? view.images : {},
        load: (key: string) => { release.current(); setPreferred(key); setEpoch((value) => value + 1); },
        failed: (key: string) => {
            if (identity.current.scope !== scope || identity.current.token !== token) return;
            release.current();
            setView({ scope, token, images: { [key]: { phase: "error", message: "图片显示失败，请重新加载" } } });
        },
    };
}
