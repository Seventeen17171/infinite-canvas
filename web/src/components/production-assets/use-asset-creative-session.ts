"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/services/api/request";
import { emptyCreative, fetchAssetCreative, saveAssetCreative, validCreativeFields, type AssetCreative, type CreativeFields, type CreativeModel, type CreativeResponse, type CreativeSaveInput } from "@/services/api/production-asset-creative";
import { useUserStore } from "@/stores/use-user-store";

type Phase = "loading" | "ready" | "saving" | "error" | "conflict" | "blocked";
type Draft = CreativeFields & { schema: 1; actorId: string; projectId: string; assetId: string; revision: number; dirty: boolean; pending?: CreativeSaveInput; backup?: CreativeFields };
type View = CreativeFields & { scope: string; phase: Phase; authorized: boolean; creative?: AssetCreative; models: CreativeModel[]; revision: number; dirty: boolean; message: string; storageError: boolean; retryPending: boolean; refreshing: boolean; modelMessage: string; backup?: CreativeFields };
type Session = { view: View; alive: boolean; busy: boolean; pending?: CreativeSaveInput; edit: (patch: Partial<CreativeFields>) => void; save: () => Promise<void>; reload: () => Promise<void>; refresh: () => Promise<void>; restoreBackup: () => void };

// Prompt drafts stay in this tab, with a namespace independent of asset metadata.
const fallbackDrafts = new Map<string, Draft>();
const unsafeDraftKeys = new Set<string>();
const prefix = (actorId: string, projectId: string) => `production-asset-creative-draft:${actorId}:${projectId}:`;
const warnBeforeLoss = (event: BeforeUnloadEvent) => { if (unsafeDraftKeys.size) { event.preventDefault(); event.returnValue = ""; } };
function protectDraft(key: string, needed: boolean) {
    if (needed) unsafeDraftKeys.add(key); else unsafeDraftKeys.delete(key);
    if (unsafeDraftKeys.size) window.addEventListener("beforeunload", warnBeforeLoss); else window.removeEventListener("beforeunload", warnBeforeLoss);
}
export function clearAssetCreativeDrafts(actorId: string, projectId: string) {
    const start = prefix(actorId, projectId);
    for (const key of fallbackDrafts.keys()) if (key.startsWith(start)) { fallbackDrafts.delete(key); protectDraft(key, false); }
    try {
        for (let index = sessionStorage.length - 1; index >= 0; index--) {
            const key = sessionStorage.key(index);
            if (key?.startsWith(start)) sessionStorage.removeItem(key);
        }
    } catch { /* Future restoration still requires fresh server authorization. */ }
}
const fields = (value: CreativeFields): CreativeFields => ({ prompt: value.prompt, modelChannelId: value.modelChannelId, modelName: value.modelName, aspectRatio: value.aspectRatio, resolution: value.resolution, imageCount: value.imageCount });
const fingerprint = (value: CreativeFields) => JSON.stringify(fields(value));
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试";
const denied = (error: unknown) => error instanceof ApiError && [401, 403, 404].includes(error.status);
const validRevision = (value: number) => Number.isSafeInteger(value) && value >= 0;
const validPending = (value: CreativeSaveInput | undefined) => !value || (validCreativeFields(value) && validRevision(value.revision) && typeof value.requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.requestId));

export function useAssetCreativeSession(projectId: string, assetId: string, enabled: boolean, onDenied: () => void) {
    const token = useUserStore((state) => state.token);
    const actorId = useUserStore((state) => state.user?.id || "");
    const sessionRevision = useUserStore((state) => state.sessionRevision);
    const scope = `${sessionRevision}:${actorId}:${projectId}:${assetId}:${enabled}`;
    const initial: View = { ...emptyCreative, scope, phase: "loading", authorized: false, models: [], revision: 0, dirty: false, message: "", storageError: false, retryPending: false, refreshing: false, modelMessage: "" };
    const [view, setView] = useState<View>(initial);
    const ref = useRef<Session | null>(null);
    const identity = useRef({ scope, token });
    identity.current = { scope, token };
    const callbacks = useRef({ onDenied });
    callbacks.current = { onDenied };

    useEffect(() => {
        setView(initial);
        if (!enabled || !token || !actorId || !assetId || assetId === "new") return;
        const key = `${prefix(actorId, projectId)}${assetId}`;
        let base = fingerprint(initial);
        let epoch = 0;
        let seenRevision = 0;
        let checking = false;
        const active = () => session.alive && identity.current.scope === scope && identity.current.token === token && useUserStore.getState().token === token && useUserStore.getState().sessionRevision === sessionRevision;
        const publish = () => { if (active()) setView({ ...session.view }); };
        const persist = () => {
            if (session.view.phase === "blocked") return;
            const current = session.view;
            const draft: Draft = { ...fields(current), schema: 1, actorId, projectId, assetId, revision: current.revision, dirty: current.dirty, pending: session.pending, backup: current.backup };
            fallbackDrafts.set(key, draft);
            try {
                sessionStorage.setItem(key, JSON.stringify(draft));
                session.view.storageError = false;
                protectDraft(key, false);
            } catch {
                session.view.storageError = true;
                protectDraft(key, Boolean(draft.dirty || draft.pending || draft.backup));
            }
        };
        const update = (patch: Partial<View>, write = false) => { session.view = { ...session.view, ...patch }; if (write) persist(); publish(); };
        function block(error: unknown) {
            epoch++;
            clearAssetCreativeDrafts(actorId, projectId);
            session.pending = undefined;
            update({ ...initial, phase: "blocked", message: errorText(error) });
            callbacks.current.onDenied();
            if (error instanceof ApiError && error.status === 401 && active()) useUserStore.getState().clearSession();
        }
        function restore({ creative, models }: CreativeResponse) {
            seenRevision = creative.revision;
            base = fingerprint(creative);
            update({ ...fields(creative), creative, models, revision: creative.revision, phase: "ready", authorized: true });
            let previous = fallbackDrafts.get(key);
            try {
                if (!previous) { const raw = sessionStorage.getItem(key); if (raw) previous = JSON.parse(raw) as Draft; }
            } catch {
                update({ storageError: true, message: "创意草稿无法读取，请保留当前页面，确认内容后再保存。" });
                return;
            }
            if (previous?.schema === 1 && previous.actorId === actorId && previous.projectId === projectId && previous.assetId === assetId && validCreativeFields(previous) && validRevision(previous.revision) && validPending(previous.pending) && (!previous.backup || validCreativeFields(previous.backup)) && (previous.dirty || previous.pending || previous.backup)) {
                session.pending = previous.pending;
                const conflict = previous.revision !== creative.revision && !previous.pending;
                update({ ...fields(previous), revision: previous.revision, dirty: previous.dirty || Boolean(previous.pending), backup: previous.backup, retryPending: Boolean(previous.pending), phase: conflict ? "conflict" : previous.pending ? "error" : "ready", message: conflict ? "已恢复创意草稿，服务器已有更新版本。" : previous.pending ? "上次创意提交结果尚未确认，请重试确认后继续编辑。" : "已恢复本页创意草稿。" }, true);
            }
        }
        async function open() {
            const currentEpoch = ++epoch;
            update({ phase: "loading", message: "" });
            try {
                const result = await fetchAssetCreative(token, projectId, assetId);
                if (active() && currentEpoch === epoch) restore(result);
            } catch (error) {
                if (!active() || currentEpoch !== epoch) return;
                if (denied(error)) block(error); else update({ phase: "error", message: errorText(error) });
            }
        }
        const session: Session = {
            alive: true, busy: false, view: { ...initial },
            edit(patch) {
                if (!active() || !session.view.authorized || session.busy || session.pending || ["loading", "blocked"].includes(session.view.phase)) return;
                const next = { ...session.view, ...patch };
                update({ ...patch, dirty: fingerprint(next) !== base, message: session.view.phase === "conflict" ? session.view.message : "" }, true);
            },
            async save() {
                if (!active() || !session.view.authorized || session.busy || ["loading", "blocked", "conflict"].includes(session.view.phase)) return;
                if (!validCreativeFields(session.view)) { update({ message: "提示词最多 8000 字，仅支持换行和制表符；请检查创意参数。" }); return; }
                if (!session.view.dirty && !session.pending) return;
                session.busy = true;
                const currentEpoch = ++epoch;
                session.pending ||= { ...fields(session.view), revision: session.view.revision, requestId: crypto.randomUUID() };
                const input = session.pending;
                update({ phase: "saving", retryPending: true, message: "" }, true);
                try {
                    const receipt = await saveAssetCreative(token, projectId, assetId, input);
                    if (!active() || currentEpoch !== epoch) return;
                    session.pending = undefined;
                    if (seenRevision > receipt.revision) {
                        update({ revision: receipt.revision, phase: "conflict", dirty: true, retryPending: false, message: "上次创意提交已确认，但服务器已有更新版本。草稿已保留，请载入最新版本后对照。" }, true);
                        return;
                    }
                    const creative: AssetCreative = { ...fields(input), projectId, assetId, revision: receipt.revision, updatedAt: receipt.updatedAt };
                    seenRevision = creative.revision;
                    base = fingerprint(creative);
                    update({ ...fields(creative), creative, revision: creative.revision, phase: "ready", dirty: false, retryPending: false, backup: undefined, message: "创意已保存" }, true);
                } catch (error) {
                    if (!active() || currentEpoch !== epoch) return;
                    if (denied(error)) block(error);
                    else if (error instanceof ApiError && error.status === 409) {
                        session.pending = undefined;
                        update({ phase: "conflict", dirty: true, retryPending: false, message: "其他页面已保存新创意。你的修改已保留，载入最新版本后再决定如何合并。" }, true);
                    } else {
                        const uncertain = !(error instanceof ApiError) || error.status < 400 || error.status >= 500;
                        if (!uncertain) session.pending = undefined;
                        update({ phase: "error", retryPending: uncertain, message: `${errorText(error)}${uncertain ? "。提交结果尚未确认，请重试确认。" : ""}` }, true);
                    }
                } finally { session.busy = false; publish(); }
            },
            async reload() {
                if (!active() || session.busy || session.pending) return;
                if (!session.view.authorized) { await open(); return; }
                session.busy = true;
                const currentEpoch = ++epoch;
                const backup = session.view.dirty ? fields(session.view) : session.view.backup;
                update({ phase: "loading", message: "" });
                try {
                    const { creative, models } = await fetchAssetCreative(token, projectId, assetId);
                    if (!active() || currentEpoch !== epoch) return;
                    seenRevision = creative.revision;
                    base = fingerprint(creative);
                    update({ ...fields(creative), creative, models, revision: creative.revision, dirty: false, phase: "ready", backup, message: backup ? "已载入服务器创意，你的草稿保留在下方。" : "已载入最新创意" }, true);
                } catch (error) {
                    if (!active() || currentEpoch !== epoch) return;
                    if (denied(error)) block(error); else update({ phase: "error", message: errorText(error) });
                } finally { session.busy = false; publish(); }
            },
            async refresh() {
                if (!active() || checking || session.busy || !session.view.authorized || ["loading", "blocked"].includes(session.view.phase)) return;
                checking = true;
                const currentEpoch = epoch;
                update({ refreshing: true, modelMessage: "" });
                try {
                    const { creative, models } = await fetchAssetCreative(token, projectId, assetId);
                    if (!active() || currentEpoch !== epoch || session.busy) return;
                    seenRevision = Math.max(seenRevision, creative.revision);
                    update({ models });
                    if (creative.revision <= session.view.revision) return;
                    if (session.view.dirty || session.pending) update({ phase: session.pending ? "error" : "conflict", message: "服务器已有新创意，你的草稿已保留。" });
                    else { base = fingerprint(creative); update({ ...fields(creative), creative, revision: creative.revision }, true); }
                } catch (error) {
                    if (!active() || currentEpoch !== epoch) return;
                    if (denied(error)) block(error); else update({ modelMessage: "可选模型暂时无法刷新，可继续编辑，稍后重试。" });
                } finally { checking = false; update({ refreshing: false }); }
            },
            restoreBackup() {
                if (!active() || session.busy || session.pending || !session.view.backup || session.view.phase !== "ready") return;
                update({ ...session.view.backup, backup: undefined, dirty: true, message: "已放回你的创意草稿，请对照最新内容调整后保存。" }, true);
            },
        };
        ref.current = session;
        const focus = () => { void session.refresh(); };
        const beforeUnload = (event: BeforeUnloadEvent) => { if (session.view.storageError || session.busy) { event.preventDefault(); event.returnValue = ""; } };
        const beforeLink = (event: MouseEvent) => {
            const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
            if (anchor && session.view.storageError && session.view.dirty && !window.confirm("创意草稿未能写入浏览器。离开前请先保存；仍要离开吗？")) { event.preventDefault(); event.stopPropagation(); }
        };
        window.addEventListener("focus", focus);
        window.addEventListener("beforeunload", beforeUnload);
        document.addEventListener("click", beforeLink, true);
        void open();
        return () => {
            session.alive = false;
            window.removeEventListener("focus", focus);
            window.removeEventListener("beforeunload", beforeUnload);
            document.removeEventListener("click", beforeLink, true);
            if (ref.current === session) ref.current = null;
        };
        // Identity changes synchronously invalidate old callbacks before effect cleanup.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scope, token]);

    const current = view.scope === scope ? view : initial;
    const currentSession = () => ref.current?.view.scope === scope ? ref.current : null;
    return { ...current, edit: (patch: Partial<CreativeFields>) => currentSession()?.edit(patch), save: () => currentSession()?.save(), reload: () => currentSession()?.reload(), refresh: () => currentSession()?.refresh(), restoreBackup: () => currentSession()?.restoreBackup() };
}

export type AssetCreativeSession = ReturnType<typeof useAssetCreativeSession>;
