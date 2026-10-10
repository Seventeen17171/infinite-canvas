"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Alert, Button, Input, Modal, Pagination, Spin } from "antd";
import { useQuery } from "@tanstack/react-query";
import { ProjectIcon } from "@/components/ui/project-icon";
import { ApiError } from "@/services/api/request";
import { createCanvasDocument, emptyCanvasContent, fetchCanvasDocuments, type CanvasDocumentInput } from "@/services/api/production-canvas-documents";
import { useUserStore } from "@/stores/use-user-store";
import styles from "./documents.module.css";

export function DocumentList({ projectId }: { projectId: string }) {
    const token = useUserStore((state) => state.token);
    const revision = useUserStore((state) => state.sessionRevision);
    const router = useRouter();
    const [page, setPage] = useState(1);
    const [open, setOpen] = useState(false);
    const [title, setTitle] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const pending = useRef<CanvasDocumentInput | undefined>(undefined);
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const query = useQuery({ queryKey: ["production", "canvas-documents", token, projectId, page], queryFn: () => fetchCanvasDocuments(token, projectId, page), enabled: Boolean(token), retry: false, staleTime: 0, gcTime: 0 });
    const blocked = query.error instanceof ApiError && [401, 403, 404].includes(query.error.status);
    useEffect(() => {
        if (query.error instanceof ApiError && query.error.status === 401 && useUserStore.getState().token === token) useUserStore.getState().clearSession();
    }, [query.error, token]);
    async function create() {
        if (busy || !title.trim() || blocked) return;
        pending.current ||= { title: title.trim(), content: emptyCanvasContent(), requestId: crypto.randomUUID() };
        const active = () => mounted.current && useUserStore.getState().token === token && useUserStore.getState().sessionRevision === revision;
        setBusy(true);
        setError("");
        try {
            const document = await createCanvasDocument(token, projectId, pending.current);
            if (!active()) return;
            pending.current = undefined;
            router.push(`/projects/${encodeURIComponent(projectId)}/canvas/documents/${encodeURIComponent(document.id)}`);
        } catch (error) {
            if (!active()) return;
            if (error instanceof ApiError && error.status >= 400 && error.status < 500) pending.current = undefined;
            if (error instanceof ApiError && error.status === 401) useUserStore.getState().clearSession();
            setError((error instanceof Error ? error.message : "创建失败") + (pending.current ? "。提交结果尚未确认，请使用相同内容重试。" : ""));
        } finally {
            if (active()) setBusy(false);
        }
    }
    return (
        <section aria-label="项目画布文档">
            <div className={styles.listToolbar}>
                <span className={styles.muted}>{query.data ? `${query.data.total} 份画布文档` : "画布文档"}</span>
                <Button type="primary" icon={<ProjectIcon name="plus" />} disabled={blocked} onClick={() => setOpen(true)}>
                    新建画布
                </Button>
            </div>
            {query.isPending ? (
                <div className={styles.empty}>
                    <Spin aria-label="正在加载画布文档" />
                </div>
            ) : query.isError ? (
                <Alert type="error" title={query.error.message} action={<Button onClick={() => void query.refetch()}>重试</Button>} />
            ) : !query.data?.items.length ? (
                <div className={styles.empty}>
                    <ProjectIcon name="canvas" style={{ fontSize: 32 }} />
                    <h2>暂无画布文档</h2>
                    <p>新建画布，开始整理画面文本、分组与连接关系。</p>
                </div>
            ) : (
                <div className={styles.directory}>
                    <div className={styles.columns} aria-hidden>
                        <span>画布名称</span>
                        <span>最后保存</span>
                        <span />
                    </div>
                    {query.data.items.map((item) => (
                        <div key={item.id} className={styles.row} data-document-id={item.id}>
                            <Link className={styles.name} title={item.title} href={`/projects/${encodeURIComponent(projectId)}/canvas/documents/${encodeURIComponent(item.id)}`}>
                                <span className={styles.documentIcon}><ProjectIcon name="canvas" /></span>
                                <span className={styles.documentTitle}>{item.title}</span>
                            </Link>
                            <time className={styles.muted} dateTime={item.updatedAt}>
                                {new Date(item.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}
                            </time>
                            <Button type="text" href={`/projects/${encodeURIComponent(projectId)}/canvas/documents/${encodeURIComponent(item.id)}`} aria-label={`打开${item.title}`}>
                                打开
                            </Button>
                        </div>
                    ))}
                </div>
            )}
            {(query.data?.total || 0) > 20 && (
                <div className={styles.pagination}>
                    <Pagination current={page} pageSize={20} total={query.data?.total} showSizeChanger={false} onChange={setPage} />
                </div>
            )}
            <Modal
                title="新建画布"
                open={open && !blocked}
                onCancel={() => {
                    if (!busy) setOpen(false);
                }}
                footer={null}
                destroyOnHidden
            >
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        void create();
                    }}
                >
                    <label className={styles.label} htmlFor="canvas-document-name">
                        画布名称
                    </label>
                    <Input id="canvas-document-name" autoFocus maxLength={80} value={title} disabled={busy || Boolean(pending.current)} placeholder="例如：第一集画面规划" onChange={(event) => setTitle(event.target.value)} />
                    <p className={styles.formNote}>画布保存在当前项目中，项目创建者和当前制作负责人可以访问。</p>
                    {error && <Alert type="error" title={error} />}
                    <div className={styles.modalActions}>
                        <Button disabled={busy} onClick={() => setOpen(false)}>
                            取消
                        </Button>
                        <Button type="primary" htmlType="submit" loading={busy} disabled={!title.trim()}>
                            {pending.current ? "重试创建" : "创建画布"}
                        </Button>
                    </div>
                </form>
            </Modal>
        </section>
    );
}
