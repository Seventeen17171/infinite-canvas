"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/services/api/request";
import { createProductionAsset, fetchProductionAsset, fetchProductionAssets, saveProductionAsset, type AssetCategory, type AssetInput, type AssetSaveInput, type ProductionAsset } from "@/services/api/production-assets";
import { useUserStore } from "@/stores/use-user-store";

type TextDraft = { name: string; description: string };
type Phase = "loading" | "ready" | "saving" | "error" | "conflict" | "blocked";
type Draft = TextDraft & { schema: 1; actorId: string; projectId: string; selection: string; category: AssetCategory; revision: number; dirty: boolean; pending?: AssetInput | AssetSaveInput; backup?: TextDraft };
type View = TextDraft & { scope: string; phase: Phase; authorized: boolean; asset?: ProductionAsset; revision: number; dirty: boolean; message: string; storageError: boolean; retryPending: boolean; restored: boolean; backup?: TextDraft };
type Session = { view: View; alive: boolean; busy: boolean; pending?: AssetInput | AssetSaveInput; edit: (patch: Partial<TextDraft>) => void; save: () => Promise<void>; reload: () => Promise<void>; restoreBackup: () => void };

// Small text-only drafts are written synchronously before navigation. This is deliberately
// tab-local; it neither stores credentials nor races another tab's independent edit.
const fallbackDrafts = new Map<string, Draft>();
const unsafeDraftKeys = new Set<string>();
const warnBeforeDraftLoss = (event: BeforeUnloadEvent) => {
    if (unsafeDraftKeys.size) { event.preventDefault(); event.returnValue = ""; }
};
function protectDraftLoss(key: string, needed: boolean) {
    if (needed) unsafeDraftKeys.add(key);
    else unsafeDraftKeys.delete(key);
    // A browser-back navigation can unmount the editor even when storage is full.
    // Keep protecting its in-memory fallback until it has been saved or discarded.
    if (unsafeDraftKeys.size) window.addEventListener("beforeunload", warnBeforeDraftLoss);
    else window.removeEventListener("beforeunload", warnBeforeDraftLoss);
}
const draftPrefix = (actorId: string, projectId: string) => `production-asset-draft:${actorId}:${projectId}:`;
const fingerprint = (draft: TextDraft) => JSON.stringify([draft.name.trim(), draft.description]);
const errorText = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试";
const denied = (error: unknown) => error instanceof ApiError && [401, 403, 404].includes(error.status);

export function useAssetSession(projectId: string, selection: string, category: AssetCategory, enabled: boolean, onSaved: (asset: ProductionAsset) => void, onDenied: () => void) {
    const token = useUserStore((state) => state.token);
    const actorId = useUserStore((state) => state.user?.id || "");
    const sessionRevision = useUserStore((state) => state.sessionRevision);
    const scope = `${sessionRevision}:${actorId}:${projectId}:${selection}:${category}:${enabled}`;
    const initial: View = { scope, phase: "loading", authorized: false, name: "", description: "", revision: 0, dirty: false, message: "", storageError: false, retryPending: false, restored: false };
    const [view, setView] = useState<View>(initial);
    const ref = useRef<Session | null>(null);
    const identity = useRef({ scope, token });
    identity.current = { scope, token };
    const callbacks = useRef({ onSaved, onDenied });
    callbacks.current = { onSaved, onDenied };

    useEffect(() => {
        setView(initial);
        if (!enabled || !token || !actorId || !selection) return;
        const isNew = selection === "new";
        const key = `${draftPrefix(actorId, projectId)}${isNew ? `new:${category}` : selection}`;
        let base = fingerprint(initial);
        let epoch = 0;
        let seenRevision = 0;
        const active = () => session.alive && identity.current.scope === scope && identity.current.token === token && useUserStore.getState().token === token && useUserStore.getState().sessionRevision === sessionRevision;
        const publish = () => { if (active()) setView({ ...session.view }); };
        const persist = () => {
            if (session.view.phase === "blocked") return;
            const current = session.view;
            const draft: Draft = { schema: 1, actorId, projectId, selection, category, name: current.name, description: current.description, revision: current.revision, dirty: current.dirty, pending: session.pending, backup: current.backup };
            fallbackDrafts.set(key, draft);
            try {
                sessionStorage.setItem(key, JSON.stringify(draft));
                session.view.storageError = false;
                protectDraftLoss(key, false);
            } catch {
                session.view.storageError = true;
                protectDraftLoss(key, Boolean(draft.dirty || draft.pending || draft.backup));
            }
        };
        const update = (patch: Partial<View>, write = false) => {
            session.view = { ...session.view, ...patch };
            if (write) persist();
            publish();
        };
        function block(error: unknown) {
            epoch++;
            // Denied data must not be revived by a later offline visit.
            const prefix = draftPrefix(actorId, projectId);
            for (const item of fallbackDrafts.keys()) if (item.startsWith(prefix)) { fallbackDrafts.delete(item); protectDraftLoss(item, false); }
            try {
                for (let index = sessionStorage.length - 1; index >= 0; index--) {
                    const item = sessionStorage.key(index);
                    if (item?.startsWith(prefix)) sessionStorage.removeItem(item);
                }
            } catch { /* Remain blocked; authorization is required before every future restore. */ }
            session.pending = undefined;
            update({ ...initial, phase: "blocked", message: errorText(error) });
            callbacks.current.onDenied();
            if (error instanceof ApiError && error.status === 401 && active()) useUserStore.getState().clearSession();
        }
        function restore(asset?: ProductionAsset) {
            const clean = asset ? { name: asset.name, description: asset.description } : { name: "", description: "" };
            seenRevision = asset?.revision || 0;
            base = fingerprint(clean);
            update({ ...clean, asset, revision: asset?.revision || 0, phase: "ready", authorized: true });
            let previous = fallbackDrafts.get(key);
            try {
                if (!previous) {
                    const raw = sessionStorage.getItem(key);
                    if (raw) previous = JSON.parse(raw) as Draft;
                }
            } catch {
                update({ storageError: true, message: "本页草稿无法读取。请保留当前页面，确认内容后再保存。" });
                return;
            }
            if (previous?.schema === 1 && previous.actorId === actorId && previous.projectId === projectId && previous.selection === selection && previous.category === category && typeof previous.name === "string" && typeof previous.description === "string" && (previous.dirty || previous.pending || previous.backup)) {
                session.pending = previous.pending;
                const conflict = Boolean(asset && previous.revision !== asset.revision && !previous.pending);
                update({ name: previous.name, description: previous.description, revision: previous.revision, dirty: previous.dirty || Boolean(previous.pending), backup: previous.backup, retryPending: Boolean(previous.pending), restored: true, phase: conflict ? "conflict" : previous.pending ? "error" : "ready", message: conflict ? "已恢复本页草稿，服务器已有更新版本。" : previous.pending ? "上次提交结果尚未确认，请重试确认后继续编辑。" : "已恢复本页草稿。" }, true);
            }
        }
        async function open() {
            const currentEpoch = ++epoch;
            update({ phase: "loading", message: "" });
            try {
                const asset = isNew ? (await fetchProductionAssets(token, projectId, { category, page: 1, pageSize: 1 }), undefined) : await fetchProductionAsset(token, projectId, selection);
                if (!active() || currentEpoch !== epoch) return;
                if (asset && asset.category !== category) {
                    update({ phase: "error", message: "此资产不属于当前分类，请从左侧列表重新选择。" });
                    return;
                }
                restore(asset);
            } catch (error) {
                if (!active() || currentEpoch !== epoch) return;
                if (denied(error)) block(error);
                else update({ phase: "error", message: errorText(error) });
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
                const name = session.view.name.trim();
                if (!name || Array.from(name).length > 80 || Array.from(session.view.description).length > 8000) {
                    update({ message: "名称需为 1–80 字，描述最多 8000 字。" });
                    return;
                }
                if (!session.view.dirty && !session.pending) return;
                session.busy = true;
                const currentEpoch = ++epoch;
                session.pending ||= isNew ? { category, name, description: session.view.description, requestId: crypto.randomUUID() } : { name, description: session.view.description, revision: session.view.revision, requestId: crypto.randomUUID() };
                const input = session.pending;
                update({ phase: "saving", retryPending: true, message: "" }, true);
                try {
                    let asset: ProductionAsset;
                    if (isNew) asset = await createProductionAsset(token, projectId, input as AssetInput);
                    else {
                        const receipt = await saveProductionAsset(token, projectId, selection, input as AssetSaveInput);
                        if (!active() || currentEpoch !== epoch) return;
                        if (seenRevision > receipt.revision) {
                            session.pending = undefined;
                            update({ revision: receipt.revision, phase: "conflict", dirty: true, retryPending: false, message: "上次提交已确认，但服务器已有更新版本。你的草稿已保留，请载入最新版本后对照。" }, true);
                            return;
                        }
                        asset = { ...session.view.asset!, name: input.name, description: input.description, revision: receipt.revision, updatedAt: receipt.updatedAt, updatedBy: actorId };
                    }
                    if (!active() || currentEpoch !== epoch) return;
                    session.pending = undefined;
                    seenRevision = asset.revision;
                    base = fingerprint(asset);
                    update({ asset, name: asset.name, description: asset.description, revision: asset.revision, phase: "ready", dirty: false, retryPending: false, restored: false, backup: undefined, message: "已保存到项目资产库" }, true);
                    if (isNew) {
                        fallbackDrafts.delete(key);
                        protectDraftLoss(key, false);
                        try { sessionStorage.removeItem(key); } catch { /* The saved result remains in the list. */ }
                    }
                    callbacks.current.onSaved(asset);
                } catch (error) {
                    if (!active() || currentEpoch !== epoch) return;
                    if (denied(error)) block(error);
                    else if (error instanceof ApiError && error.status === 409) {
                        session.pending = undefined;
                        update({ phase: isNew ? "error" : "conflict", dirty: true, retryPending: false, message: isNew ? error.message : "其他页面已保存新版本。你的修改已保留，载入最新版本后再决定如何合并。" }, true);
                    } else {
                        const uncertain = !(error instanceof ApiError) || error.status < 400 || error.status >= 500;
                        if (!uncertain) session.pending = undefined;
                        update({ phase: "error", retryPending: uncertain, message: `${errorText(error)}${uncertain ? "。提交结果尚未确认，请重试确认，避免重复创建或保存。" : ""}` }, true);
                    }
                } finally {
                    session.busy = false;
                    publish();
                }
            },
            async reload() {
                if (!active() || session.busy || session.pending) return;
                if (!session.view.asset || isNew) { await open(); return; }
                session.busy = true;
                const currentEpoch = ++epoch;
                const backup = session.view.dirty ? { name: session.view.name, description: session.view.description } : session.view.backup;
                update({ phase: "loading", message: "" });
                try {
                    const asset = await fetchProductionAsset(token, projectId, selection);
                    if (!active() || currentEpoch !== epoch) return;
                    seenRevision = asset.revision;
                    base = fingerprint(asset);
                    update({ asset, name: asset.name, description: asset.description, revision: asset.revision, dirty: false, phase: "ready", backup, restored: false, message: backup ? "已载入服务器版本。你的草稿保留在下方，可对照后继续编辑。" : "已载入最新版本" }, true);
                } catch (error) {
                    if (!active() || currentEpoch !== epoch) return;
                    if (denied(error)) block(error);
                    else update({ phase: "error", message: errorText(error) });
                } finally { session.busy = false; publish(); }
            },
            restoreBackup() {
                if (!active() || session.busy || session.pending || !session.view.backup || session.view.phase !== "ready") return;
                update({ ...session.view.backup, backup: undefined, dirty: true, message: "已将你的草稿放回编辑区。请对照最新内容调整后保存。" }, true);
            },
        };
        ref.current = session;
        let checking = false;
        const revalidate = async () => {
            if (!active() || checking || session.busy || !session.view.authorized || ["loading", "blocked"].includes(session.view.phase)) return;
            checking = true;
            const currentEpoch = epoch;
            try {
                const asset = isNew ? (await fetchProductionAssets(token, projectId, { pageSize: 1 }), undefined) : await fetchProductionAsset(token, projectId, selection);
                if (!active() || currentEpoch !== epoch || session.busy || !asset) return;
                seenRevision = Math.max(seenRevision, asset.revision);
                if (asset.revision <= session.view.revision) return;
                if (session.view.dirty || session.pending) update({ phase: session.pending ? "error" : "conflict", message: "服务器已有新版本，你的草稿已保留。" });
                else { base = fingerprint(asset); update({ asset, name: asset.name, description: asset.description, revision: asset.revision }, true); }
            } catch (error) {
                if (active() && currentEpoch === epoch && denied(error)) block(error);
            } finally { checking = false; }
        };
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (session.view.storageError || session.busy) { event.preventDefault(); event.returnValue = ""; }
        };
        const beforeLink = (event: MouseEvent) => {
            const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
            if (anchor && session.view.storageError && session.view.dirty && !window.confirm("本页草稿未能写入浏览器。离开前请先保存；仍要离开吗？")) { event.preventDefault(); event.stopPropagation(); }
        };
        window.addEventListener("focus", revalidate);
        window.addEventListener("beforeunload", beforeUnload);
        document.addEventListener("click", beforeLink, true);
        void open();
        return () => {
            session.alive = false;
            window.removeEventListener("focus", revalidate);
            window.removeEventListener("beforeunload", beforeUnload);
            document.removeEventListener("click", beforeLink, true);
            if (ref.current === session) ref.current = null;
        };
        // A changed identity or selection invalidates every earlier response and callback.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scope, token]);

    const current = view.scope === scope ? view : initial;
    const currentSession = () => ref.current?.view.scope === scope ? ref.current : null;
    return { ...current, edit: (patch: Partial<TextDraft>) => currentSession()?.edit(patch), save: () => currentSession()?.save(), reload: () => currentSession()?.reload(), restoreBackup: () => currentSession()?.restoreBackup() };
}
