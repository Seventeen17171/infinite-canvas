"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/services/api/request";
import { fetchAssetFiles, fetchProductionFileUpload, productionImageError, uploadProductionFile, validProductionUpload, type ProductionFileUploadRequest } from "@/services/api/production-files";
import { useUserStore } from "@/stores/use-user-store";

type View = { scope: string; token: string; phase: "idle" | "selected" | "uploading" | "checking" | "pending" | "blocked"; selected?: { name: string; bytes: number }; pending?: ProductionFileUploadRequest; message: string };
type Session = { alive: boolean; view: View; file?: File; select: (file?: File) => void; submit: () => Promise<void>; check: (resend: boolean) => Promise<void>; discard: () => void; confirmLeave: () => boolean };
const prefix = (actorId: string, projectId: string) => `production-asset-file-upload:${actorId}:${projectId}:`;
const errorText = (error: unknown) => error instanceof Error ? error.message : "图片上传未能确认，请稍后重试";
const denied = (error: unknown) => error instanceof ApiError && [401, 403, 404].includes(error.status);

export function clearAssetUploadRequests(actorId: string, projectId: string) {
    try {
        for (let index = sessionStorage.length - 1; index >= 0; index--) {
            const key = sessionStorage.key(index);
            if (key?.startsWith(prefix(actorId, projectId))) sessionStorage.removeItem(key);
        }
    } catch { /* Reading a retained descriptor still requires fresh project authorization. */ }
}

export function useAssetUpload(projectId: string, assetId: string, enabled: boolean, onDenied: () => void, onUploaded: () => void) {
    const token = useUserStore((state) => state.token);
    const actorId = useUserStore((state) => state.user?.id || "");
    const revision = useUserStore((state) => state.sessionRevision);
    const scope = `${revision}:${actorId}:${projectId}:${assetId}:${enabled}`;
    const initial: View = { scope, token, phase: "idle", message: "" };
    const [view, setView] = useState<View>(initial);
    const identity = useRef({ scope, token });
    identity.current = { scope, token };
    const callbacks = useRef({ onDenied, onUploaded });
    callbacks.current = { onDenied, onUploaded };
    const ref = useRef<Session | null>(null);

    useEffect(() => {
        setView(initial);
        // The containing asset session has freshly authorized this identity before enabling uploads.
        if (!enabled || !token || !actorId || !assetId || assetId === "new") return;
        const key = `${prefix(actorId, projectId)}${assetId}`;
        let epoch = 0;
        let controller: AbortController | undefined;
        const active = () => session.alive && identity.current.scope === scope && identity.current.token === token && useUserStore.getState().token === token && useUserStore.getState().sessionRevision === revision;
        const update = (patch: Partial<View>) => { session.view = { ...session.view, ...patch }; if (active()) setView({ ...session.view }); };
        const busy = () => ["uploading", "checking"].includes(session.view.phase);
        const cancel = () => { epoch++; controller?.abort(); controller = undefined; };
        const clear = () => { try { sessionStorage.removeItem(key); return true; } catch { return false; } };
        function block(error: unknown) {
            cancel();
            session.file = undefined;
            clearAssetUploadRequests(actorId, projectId);
            update({ phase: "blocked", selected: undefined, pending: undefined, message: errorText(error) });
            callbacks.current.onDenied();
            if (error instanceof ApiError && error.status === 401 && active()) useUserStore.getState().clearSession();
        }
        function success() {
            const removed = clear();
            session.file = undefined;
            update({ phase: "idle", selected: undefined, pending: undefined, message: `图片已保存到当前资产。${removed ? "" : "本页确认记录暂未清除，重新打开时会再次核对。"}` });
            callbacks.current.onUploaded();
        }
        function failure(error: unknown, firstAttempt: boolean) {
            if (denied(error)) { block(error); return; }
            // Rejection of a retry cannot establish the outcome of an earlier in-flight request.
            if (firstAttempt && error instanceof ApiError && [400, 413, 415, 422].includes(error.status)) {
                if (!clear()) { update({ phase: "pending", message: `${errorText(error)}；确认记录暂未清除，请稍后重试确认。` }); return; }
                update({ phase: session.file ? "selected" : "idle", pending: undefined, message: errorText(error) });
            } else update({ phase: "pending", message: `${errorText(error)}。已保留原上传请求，请重试确认。` });
        }
        async function send(request: ProductionFileUploadRequest, file: File, current: number, firstAttempt = false) {
            update({ phase: "uploading", message: "正在上传图片，请保持当前页面。" });
            try {
                await uploadProductionFile(token, request, file, controller!.signal);
                if (active() && current === epoch) success();
            } catch (error) { if (active() && current === epoch) failure(error, firstAttempt); }
        }
        const session: Session = {
            alive: true, view: { ...initial },
            select(file) {
                if (!active() || busy() || session.view.phase === "blocked") return;
                if (!file) { if (!session.view.pending) { session.file = undefined; update({ selected: undefined, phase: "idle", message: "" }); } return; }
                const error = productionImageError(file);
                const pending = session.view.pending;
                if (error || (pending && (file.name.trim() !== pending.name || file.size !== pending.bytes))) {
                    session.file = undefined;
                    update({ selected: undefined, phase: pending ? "pending" : "idle", message: error || "请选择原来同名、同大小的图片；上传时会再次核对原始内容。" });
                    return;
                }
                session.file = file;
                update({ selected: { name: file.name.trim(), bytes: file.size }, phase: pending ? "pending" : "selected", message: pending ? "已选择原图片，可用原请求重试确认。" : "" });
            },
            async submit() {
                if (!active() || busy() || session.view.phase === "blocked" || !session.file) return;
                if (session.view.pending) { await session.check(true); return; }
                const file = session.file;
                let request: ProductionFileUploadRequest;
                try {
                    request = { requestId: crypto.randomUUID(), projectId, assetId, name: file.name.trim(), bytes: file.size };
                    // Store only bounded recovery text, before sending any bytes. Never persist File or media.
                    sessionStorage.setItem(key, JSON.stringify(request));
                } catch {
                    update({ message: "本页无法保留上传确认信息，尚未上传。请恢复浏览器存储后再试。" });
                    return;
                }
                cancel();
                const current = epoch;
                controller = new AbortController();
                update({ pending: request });
                await send(request, file, current, true);
            },
            async check(resend) {
                const request = session.view.pending;
                if (!active() || busy() || !request) return;
                cancel();
                const current = epoch;
                controller = new AbortController();
                update({ phase: "checking", message: "正在核对原上传结果。" });
                try {
                    await fetchProductionFileUpload(token, request, controller.signal);
                    if (active() && current === epoch) success();
                } catch (error) {
                    if (!active() || current !== epoch) return;
                    if (error instanceof ApiError && error.status === 404) {
                        // A missing receipt may mean an earlier upload is still committing. Recheck access.
                        try {
                            await fetchAssetFiles(token, projectId, assetId, 1, controller.signal);
                            if (!active() || current !== epoch) return;
                            if (resend && session.file) { await send(request, session.file, current); return; }
                            update({ phase: "pending", message: "尚未查到上传结果，原请求可能仍在完成。可重新选择同名、同大小的原图片，用原请求重试确认。" });
                        } catch (accessError) {
                            if (!active() || current !== epoch) return;
                            if (denied(accessError)) block(accessError);
                            else update({ phase: "pending", message: "暂时无法确认项目权限，已保留原请求，请稍后重试确认。" });
                        }
                    } else if (denied(error)) block(error);
                    else update({ phase: "pending", message: `${errorText(error)}。已保留原请求，请稍后重试确认。` });
                }
            },
            discard() {
                if (!active() || busy()) return;
                if (session.view.pending && !window.confirm("服务器可能已保存这张图片。请先刷新图片列表核对，以免重复上传。仍要放弃本次确认吗？")) return;
                if (session.view.pending && !clear()) { update({ message: "确认记录暂时无法清除，请稍后重试。" }); return; }
                session.file = undefined;
                update({ phase: "idle", selected: undefined, pending: undefined, message: "" });
            },
            confirmLeave() {
                if (!active() || (!session.file && !busy())) return true;
                return window.confirm(session.view.pending ? "上传结果尚未确认。离开会停止等待，服务器仍可能保存图片；回到此资产后可核对原请求。仍要离开吗？" : "已选择的图片尚未上传，离开后需重新选择。仍要离开吗？");
            },
        };
        ref.current = session;
        const beforeUnload = (event: BeforeUnloadEvent) => { if (session.file || busy()) { event.preventDefault(); event.returnValue = ""; } };
        const beforeLink = (event: MouseEvent) => {
            if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
            if (!anchor || anchor.download || anchor.target === "_blank" || !/^https?:/.test(anchor.href) || anchor.href === window.location.href) return;
            if (!session.confirmLeave()) { event.preventDefault(); event.stopPropagation(); }
        };
        window.addEventListener("beforeunload", beforeUnload);
        document.addEventListener("click", beforeLink, true);
        try {
            const raw = sessionStorage.getItem(key);
            if (raw) {
                if (raw.length > 2000) throw new Error("确认信息超过限制");
                const pending: unknown = JSON.parse(raw);
                if (!validProductionUpload(pending, projectId, assetId)) throw new Error("确认信息无效");
                update({ pending, phase: "pending", message: "已恢复本页待确认上传，正在核对结果。" });
                void session.check(false);
            }
        } catch { update({ phase: "blocked", message: "本页上传确认信息无法读取。请先恢复浏览器存储，再重新打开此资产。" }); }
        return () => {
            session.alive = false;
            cancel();
            session.file = undefined;
            window.removeEventListener("beforeunload", beforeUnload);
            document.removeEventListener("click", beforeLink, true);
            if (ref.current === session) ref.current = null;
        };
    }, [scope, token]);

    const current = () => ref.current?.view.scope === scope && ref.current.view.token === token ? ref.current : null;
    return {
        ...(view.scope === scope && view.token === token ? view : initial),
        select: (file?: File) => current()?.select(file),
        upload: () => current()?.submit(),
        retry: () => current()?.check(true),
        discard: () => current()?.discard(),
        confirmLeave: () => current()?.confirmLeave() ?? true,
    };
}
export type AssetUploadSession = ReturnType<typeof useAssetUpload>;
