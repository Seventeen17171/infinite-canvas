"use client";

import { useEffect, useRef, useState } from "react";
import localforage from "localforage";
import { ApiError } from "@/services/api/request";
import { createCanvasDocument, fetchCanvasDocument, saveCanvasDocument, type CanvasDocumentInput, type CanvasSaveInput, type ProductionCanvasContent, type ProductionCanvasDocument } from "@/services/api/production-canvas-documents";
import { useUserStore } from "@/stores/use-user-store";

const drafts = localforage.createInstance({ name: "production-canvas-drafts", storeName: "documents" });
type Phase = "loading" | "ready" | "saving" | "conflict" | "error" | "blocked" | "reloading" | "copying";
type Draft = { schema: 1; actorId: string; projectId: string; documentId: string; title: string; content: ProductionCanvasContent; revision: number; dirty: boolean; pending?: CanvasSaveInput; copyPending?: CanvasDocumentInput };
type View = {
    scope: string;
    phase: Phase;
    document?: ProductionCanvasDocument;
    title: string;
    content?: ProductionCanvasContent;
    revision: number;
    dirty: boolean;
    message: string;
    draftError: string;
    draftPending: boolean;
    restored: boolean;
    loadEpoch: number;
    retryPending: boolean;
    retryCopyPending: boolean;
};
type Session = {
    alive: boolean;
    view: View;
    writerKey: string;
    version: number;
    durableVersion: number;
    base: string;
    seenRevision: number;
    pending?: CanvasSaveInput;
    copyPending?: CanvasDocumentInput;
    queue: Promise<void>;
    timer?: ReturnType<typeof setTimeout>;
    busy: boolean;
    update: (patch: Partial<View>, persist?: boolean) => void;
    persist: () => Promise<boolean>;
    flush: () => Promise<boolean | undefined>;
    save: () => Promise<void>;
    reload: () => Promise<void>;
    copy: () => Promise<string | undefined>;
};
const fingerprint = (title: string, content: ProductionCanvasContent) => JSON.stringify([title.trim(), content]);
const errorText = (error: unknown) => (error instanceof Error ? error.message : "操作失败，请重试");
const denied = (error: unknown) => error instanceof ApiError && [401, 403, 404].includes(error.status);

export function useDocumentSession(projectId: string, documentId: string, enabled: boolean) {
    const token = useUserStore((state) => state.token);
    const actorId = useUserStore((state) => state.user?.id || "");
    const sessionRevision = useUserStore((state) => state.sessionRevision);
    const scope = `${sessionRevision}:${actorId}:${projectId}:${documentId}:${enabled}`;
    const initial: View = { scope, phase: "loading", title: "", revision: 0, dirty: false, message: "", draftError: "", draftPending: false, restored: false, loadEpoch: 0, retryPending: false, retryCopyPending: false };
    const [view, setView] = useState<View>(initial);
    const ref = useRef<Session | null>(null);

    useEffect(() => {
        setView(initial);
        if (!enabled || !token || !actorId) return;
        const pointer = `production-canvas-draft:${actorId}:${projectId}:${documentId}`;
        const writerKey = `${pointer}:${crypto.randomUUID()}`;
        let authorizationEpoch = 0;
        const active = () => session.alive && useUserStore.getState().token === token && useUserStore.getState().sessionRevision === sessionRevision;
        const publish = () => {
            if (active()) setView({ ...session.view });
        };
        const session: Session = {
            alive: true,
            view: { ...initial },
            writerKey,
            version: 0,
            durableVersion: 0,
            base: "",
            seenRevision: 0,
            queue: Promise.resolve(),
            busy: false,
            update(patch, persist = false) {
                session.view = { ...session.view, ...patch };
                if (persist) {
                    session.version++;
                    session.view.draftPending = true;
                    clearTimeout(session.timer);
                    session.timer = setTimeout(() => void session.persist(), 180);
                }
                publish();
            },
            async persist() {
                clearTimeout(session.timer);
                const current = session.view;
                if (!current.content || current.phase === "blocked") return false;
                const version = session.version;
                const record: Draft = { schema: 1, actorId, projectId, documentId, title: current.title, content: current.content, revision: current.revision, dirty: current.dirty, pending: session.pending, copyPending: session.copyPending };
                let success = false;
                session.queue = session.queue.then(async () => {
                    try {
                        await drafts.setItem(writerKey, record);
                        if (active() && session.view.phase !== "blocked") sessionStorage.setItem(pointer, writerKey);
                        session.durableVersion = Math.max(session.durableVersion, version);
                        success = true;
                        session.view.draftError = "";
                    } catch {
                        session.view.draftError = "浏览器草稿保存失败，请保持页面打开并保存到服务器。";
                    }
                    session.view.draftPending = session.durableVersion < session.version;
                    publish();
                });
                await session.queue;
                return success;
            },
            async flush() {
                const unavailable = () => !active() || session.view.phase === "blocked";
                do {
                    if (unavailable()) return;
                    if (!(await session.persist())) return active() ? false : undefined;
                    if (unavailable()) return;
                } while (session.durableVersion < session.version);
                return !session.view.draftError;
            },
            async save() {
                if (!active() || session.busy || !session.view.content || ["blocked", "conflict", "loading"].includes(session.view.phase)) return;
                if (!session.view.title.trim()) {
                    session.update({ message: "请填写画布名称" });
                    return;
                }
                if (!session.view.dirty && !session.pending) return;
                session.busy = true;
                const epoch = authorizationEpoch;
                session.pending ||= { title: session.view.title.trim(), content: session.view.content, revision: session.view.revision, requestId: crypto.randomUUID() };
                const input = session.pending;
                session.update({ phase: "saving", message: "", retryPending: true }, true);
                await session.persist();
                if (!active() || epoch !== authorizationEpoch) {
                    session.busy = false;
                    return;
                }
                try {
                    const receipt = await saveCanvasDocument(token, projectId, documentId, input);
                    if (!active() || epoch !== authorizationEpoch) return;
                    session.pending = undefined;
                    session.base = fingerprint(input.title, input.content);
                    const conflict = session.seenRevision > receipt.revision;
                    const dirty = conflict || fingerprint(session.view.title, session.view.content!) !== session.base;
                    session.update(
                        {
                            revision: receipt.revision,
                            dirty,
                            phase: conflict ? "conflict" : "ready",
                            retryPending: false,
                            message: conflict ? "提交已确认，但服务器已有更新版本。请保留草稿或载入最新版本。" : dirty ? "上一份内容已保存，当前仍有新修改。" : "",
                            restored: false,
                            document: session.view.document ? { ...session.view.document, revision: receipt.revision, updatedAt: receipt.updatedAt } : undefined,
                        },
                        true,
                    );
                } catch (error) {
                    if (!active() || epoch !== authorizationEpoch) return;
                    if (denied(error)) block(error);
                    else if (error instanceof ApiError && error.status === 409) {
                        session.pending = undefined;
                        session.update({ phase: "conflict", dirty: true, retryPending: false, message: "其他页面已保存新版本。你的修改已保留，请选择载入最新版本或另存草稿。" }, true);
                    } else {
                        // A transport/server failure has an unknown commit outcome: keep the exact request for replay.
                        const uncertain = !(error instanceof ApiError) || error.status < 400 || error.status >= 500;
                        if (!uncertain) session.pending = undefined;
                        session.update({ phase: "error", message: errorText(error), retryPending: uncertain }, true);
                    }
                } finally {
                    session.busy = false;
                    if (active()) await session.persist();
                }
            },
            async reload() {
                if (!active() || session.busy) return;
                session.busy = true;
                if (!session.view.content) {
                    session.update({ phase: "loading", message: "" });
                    try {
                        await open();
                    } finally {
                        session.busy = false;
                    }
                    return;
                }
                const epoch = ++authorizationEpoch;
                session.update({ phase: "reloading", message: "" });
                try {
                    const document = await fetchCanvasDocument(token, projectId, documentId);
                    if (!active() || epoch !== authorizationEpoch) return;
                    session.pending = undefined;
                    session.copyPending = undefined;
                    session.base = fingerprint(document.title, document.content);
                    session.seenRevision = document.revision;
                    session.update(
                        { document, title: document.title, content: document.content, revision: document.revision, dirty: false, phase: "ready", retryPending: false, retryCopyPending: false, restored: false, loadEpoch: session.view.loadEpoch + 1 },
                        true,
                    );
                } catch (error) {
                    if (!active() || epoch !== authorizationEpoch) return;
                    if (denied(error)) block(error);
                    else session.update({ phase: session.view.dirty ? "conflict" : "error", message: errorText(error) });
                } finally {
                    session.busy = false;
                }
            },
            async copy() {
                if (!active() || session.busy || !session.view.content || session.view.phase === "blocked") return;
                session.busy = true;
                const epoch = authorizationEpoch;
                session.copyPending ||= { title: `${session.view.title.trim().slice(0, 70) || "未命名画布"}（草稿副本）`, content: session.view.content, requestId: crypto.randomUUID() };
                session.update({ phase: "copying", message: "", retryCopyPending: true }, true);
                await session.persist();
                if (!active() || epoch !== authorizationEpoch) {
                    session.busy = false;
                    return;
                }
                try {
                    const copy = await createCanvasDocument(token, projectId, session.copyPending);
                    if (!active() || epoch !== authorizationEpoch) return;
                    session.copyPending = undefined;
                    // The original draft remains available; the new route reads the committed copy.
                    session.update({ phase: "copying", message: "草稿副本已创建，正在打开…", retryCopyPending: true }, true);
                    await session.persist();
                    return active() && epoch === authorizationEpoch ? copy.id : undefined;
                } catch (error) {
                    if (active() && epoch === authorizationEpoch) {
                        if (denied(error)) block(error);
                        else {
                            if (error instanceof ApiError && error.status >= 400 && error.status < 500) session.copyPending = undefined;
                            session.update({ phase: "conflict", retryCopyPending: Boolean(session.copyPending), message: `${errorText(error)}。可重试另存草稿；提交结果未确认时暂停编辑，避免遗失后续修改。` }, true);
                        }
                    }
                } finally {
                    session.busy = false;
                }
            },
        };
        ref.current = session;
        function block(error: unknown) {
            authorizationEpoch++;
            clearTimeout(session.timer);
            session.update({ phase: "blocked", content: undefined, title: "", document: undefined, message: errorText(error), draftPending: false });
            if (error instanceof ApiError && error.status === 401 && active()) useUserStore.getState().clearSession();
        }
        async function open() {
            const epoch = ++authorizationEpoch;
            try {
                // Authorization must succeed before even reading the tab's draft pointer.
                const document = await fetchCanvasDocument(token, projectId, documentId);
                if (!active() || epoch !== authorizationEpoch) return;
                session.base = fingerprint(document.title, document.content);
                session.seenRevision = document.revision;
                session.update({ document, title: document.title, content: document.content, revision: document.revision });
                let previous: Draft | null = null;
                try {
                    const priorKey = sessionStorage.getItem(pointer);
                    if (priorKey?.startsWith(`${pointer}:`)) previous = await drafts.getItem<Draft>(priorKey);
                    if (!active() || epoch !== authorizationEpoch) return;
                } catch {
                    session.update({ phase: "error", content: undefined, message: "本页草稿暂时无法读取，请重试；旧草稿入口已保留。" });
                    return;
                }
                if (!active() || epoch !== authorizationEpoch) return;
                if (previous?.schema === 1 && previous.actorId === actorId && previous.projectId === projectId && previous.documentId === documentId && (previous.dirty || previous.pending || previous.copyPending)) {
                    session.pending = previous.pending;
                    session.copyPending = previous.copyPending;
                    const conflict = Boolean(previous.copyPending) || (previous.revision !== document.revision && !previous.pending);
                    session.update(
                        {
                            title: previous.title,
                            content: previous.content,
                            revision: previous.revision,
                            dirty: true,
                            restored: true,
                            retryPending: Boolean(previous.pending),
                            retryCopyPending: Boolean(previous.copyPending),
                            phase: conflict ? "conflict" : previous.pending ? "error" : "ready",
                            message: previous.copyPending
                                ? "草稿副本的提交结果尚未确认，请重试另存草稿。"
                                : conflict
                                  ? "已恢复本页草稿；服务器已有新版本。"
                                  : previous.pending
                                    ? "已恢复草稿及未确认的提交，请重试保存以确认结果。"
                                    : "已恢复本页未保存的草稿。",
                        },
                        true,
                    );
                } else session.update({ phase: "ready" }, true);
                await session.persist();
            } catch (error) {
                if (!active() || epoch !== authorizationEpoch) return;
                if (denied(error)) block(error);
                else session.update({ phase: "error", message: errorText(error) });
            }
        }
        let checking = false;
        const revalidate = async () => {
            if (!active() || checking || session.busy || !session.view.content || ["blocked", "loading"].includes(session.view.phase)) return;
            checking = true;
            const epoch = authorizationEpoch;
            try {
                const document = await fetchCanvasDocument(token, projectId, documentId);
                if (!active() || epoch !== authorizationEpoch || session.view.phase === "blocked") return;
                session.seenRevision = Math.max(session.seenRevision, document.revision);
                if (session.busy || document.revision <= session.view.revision) return;
                if (session.view.dirty || session.pending) session.update({ phase: session.pending ? "error" : "conflict", message: "服务器已有新版本，你的草稿已保留。" });
                else {
                    session.base = fingerprint(document.title, document.content);
                    session.update({ document, title: document.title, content: document.content, revision: document.revision, loadEpoch: session.view.loadEpoch + 1 }, true);
                }
            } catch (error) {
                if (active() && epoch === authorizationEpoch && denied(error)) block(error);
            } finally {
                checking = false;
            }
        };
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (session.view.content && (session.version > session.durableVersion || session.view.draftError || session.busy)) {
                event.preventDefault();
                event.returnValue = "";
            }
        };
        const leave = () => {
            if (session.version > session.durableVersion) void session.persist();
        };
        window.addEventListener("focus", revalidate);
        window.addEventListener("beforeunload", beforeUnload);
        window.addEventListener("pagehide", leave);
        void open();
        return () => {
            session.alive = false;
            clearTimeout(session.timer);
            leave();
            window.removeEventListener("focus", revalidate);
            window.removeEventListener("beforeunload", beforeUnload);
            window.removeEventListener("pagehide", leave);
            if (ref.current === session) ref.current = null;
        };
        // Session identity deliberately resets all async work and local pointers on account/document changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scope, token]);

    const current = view.scope === scope ? view : initial;
    const edit = (patch: Partial<Pick<View, "title" | "content">>) => {
        const session = ref.current;
        if (!session || session.copyPending || session.view.scope !== scope || !session.view.content || ["loading", "blocked", "reloading", "copying"].includes(session.view.phase)) return;
        const next = { ...session.view, ...patch };
        session.update({ ...patch, dirty: Boolean(session.pending) || fingerprint(next.title, next.content!) !== session.base, message: session.view.phase === "ready" ? "" : session.view.message }, true);
    };
    return {
        ...current,
        setTitle: (title: string) => edit({ title }),
        setContent: (content: ProductionCanvasContent) => edit({ content }),
        save: () => ref.current?.save(),
        reload: () => ref.current?.reload(),
        copy: () => ref.current?.copy(),
        flush: () => ref.current?.flush(),
    };
}
