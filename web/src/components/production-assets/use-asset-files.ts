"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/services/api/request";
import { fetchAssetFiles, fetchProductionFileBlob, type ProductionFile } from "@/services/api/production-files";
import { useUserStore } from "@/stores/use-user-store";

type View = { scope: string; token: string; phase: "loading" | "ready" | "error" | "blocked"; items: ProductionFile[]; total: number; page: number; message: string; busy: string; preview?: { file: ProductionFile; url: string } };
type Session = { alive: boolean; view: View; load: (page?: number, message?: string) => Promise<void>; transfer: (id: string, download: boolean) => Promise<void>; close: (message?: string) => void };
const errorText = (error: unknown) => error instanceof Error ? error.message : "图片读取失败，请重试";
const denied = (error: unknown) => error instanceof ApiError && [401, 403, 404].includes(error.status);

export function useAssetFiles(projectId: string, assetId: string, enabled: boolean, onDenied: () => void) {
    const token = useUserStore((state) => state.token);
    const actorId = useUserStore((state) => state.user?.id || "");
    const revision = useUserStore((state) => state.sessionRevision);
    const scope = `${revision}:${actorId}:${projectId}:${assetId}:${enabled}`;
    const initial: View = { scope, token, phase: "loading", items: [], total: 0, page: 1, message: "", busy: "" };
    const [view, setView] = useState<View>(initial);
    const identity = useRef({ scope, token });
    identity.current = { scope, token };
    const callbacks = useRef({ onDenied });
    callbacks.current = { onDenied };
    const ref = useRef<Session | null>(null);

    useEffect(() => {
        setView(initial);
        if (!enabled || !token || !actorId || !assetId || assetId === "new") return;
        let epoch = 0;
        let controller: AbortController | undefined;
        let downloadURL = "";
        let downloadTimer: ReturnType<typeof setTimeout> | undefined;
        const active = () => session.alive && identity.current.scope === scope && identity.current.token === token && useUserStore.getState().token === token && useUserStore.getState().sessionRevision === revision;
        const update = (patch: Partial<View>) => { session.view = { ...session.view, ...patch }; if (active()) setView({ ...session.view }); };
        const revokeDownload = () => { clearTimeout(downloadTimer); if (downloadURL) URL.revokeObjectURL(downloadURL); downloadURL = ""; };
        const close = (message?: string) => {
            if (session.view.preview) URL.revokeObjectURL(session.view.preview.url);
            update({ preview: undefined, ...(message !== undefined ? { message } : {}) });
        };
        const cancel = () => { epoch++; controller?.abort(); controller = undefined; revokeDownload(); };
        function block(error: unknown) {
            close(); cancel();
            update({ phase: "blocked", items: [], total: 0, busy: "", message: errorText(error) });
            callbacks.current.onDenied();
            if (error instanceof ApiError && error.status === 401 && active()) useUserStore.getState().clearSession();
        }
        const session: Session = {
            alive: true, view: { ...initial }, close,
            async load(page = session.view.page, message = "") {
                if (!active()) return;
                cancel(); close();
                const current = epoch;
                controller = new AbortController();
                update({ phase: "loading", items: [], total: 0, page, busy: "", message });
                try {
                    const result = await fetchAssetFiles(token, projectId, assetId, page, controller.signal);
                    if (!active() || current !== epoch) return;
                    if (!result.items.length && result.total && page > 1) { await session.load(Math.ceil(result.total / 20), message); return; }
                    update({ ...result, phase: "ready" });
                } catch (error) {
                    if (!active() || current !== epoch) return;
                    if (denied(error)) block(error); else update({ phase: "error", message: errorText(error) });
                }
            },
            async transfer(id, download) {
                if (!active() || session.view.phase !== "ready" || session.view.busy) return;
                const file = session.view.items.find((item) => item.id === id);
                if (!file) return;
                cancel();
                if (!download) close();
                const current = epoch;
                controller = new AbortController();
                update({ busy: `${download ? "download" : "preview"}:${id}`, message: "" });
                try {
                    const blob = await fetchProductionFileBlob(token, projectId, assetId, file, download, controller.signal);
                    if (!active() || current !== epoch) return;
                    const url = URL.createObjectURL(blob);
                    if (download) {
                        downloadURL = url;
                        const anchor = document.createElement("a");
                        anchor.href = url;
                        anchor.download = file.name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_");
                        document.body.appendChild(anchor);
                        anchor.click();
                        anchor.remove();
                        downloadTimer = setTimeout(revokeDownload, 1000);
                        update({ message: "已发起图片下载" });
                    } else update({ preview: { file, url } });
                } catch (error) {
                    if (!active() || current !== epoch) return;
                    close();
                    revokeDownload();
                    if (error instanceof ApiError && error.status === 401) block(error);
                    else if (denied(error)) { await session.load(session.view.page, "文件不可用，请重新选择图片或稍后重试。"); }
                    else update({ message: errorText(error) });
                } finally { if (active() && current === epoch) update({ busy: "" }); }
            },
        };
        ref.current = session;
        const refresh = () => { if (document.visibilityState === "visible") void session.load(); };
        const visibility = () => {
            if (document.visibilityState === "hidden") { cancel(); close(); update({ busy: "" }); }
            else refresh();
        };
        window.addEventListener("focus", refresh);
        document.addEventListener("visibilitychange", visibility);
        void session.load(1);
        return () => {
            session.alive = false;
            cancel(); close();
            window.removeEventListener("focus", refresh);
            document.removeEventListener("visibilitychange", visibility);
            if (ref.current === session) ref.current = null;
        };
    }, [scope, token]); // Scope includes every identity that owns in-memory image bytes.

    return {
        ...(view.scope === scope && view.token === token ? view : initial),
        reload: () => ref.current?.load(),
        changePage: (page: number) => ref.current?.load(page),
        previewFile: (id: string) => ref.current?.transfer(id, false),
        download: (id: string) => ref.current?.transfer(id, true),
        close: () => ref.current?.close(),
        imageFailed: () => ref.current?.close("图片无法显示，请重新预览或下载查看。"),
    };
}
export type AssetFilesSession = ReturnType<typeof useAssetFiles>;
