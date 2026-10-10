"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Alert, Button, Dropdown, Input, Modal, Spin } from "antd";
import { ProjectIcon } from "@/components/ui/project-icon";
import { ApiError } from "@/services/api/request";
import { useDocumentSession } from "@/components/production-canvas/use-document-session";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { useProject } from "../../../../use-project";
import styles from "@/components/production-canvas/documents.module.css";

const DocumentEditor = dynamic(() => import("@/components/production-canvas/document-editor").then((module) => module.DocumentEditor), {
    ssr: false,
    loading: () => (
        <div className={styles.loading}>
            <Spin aria-label="正在加载编辑器" />
        </div>
    ),
});
export default function CanvasDocumentPage() {
    const { id, kind, documentId } = useParams<{ id: string; kind: string; documentId: string }>();
    const router = useRouter();
    const query = useProject(kind === "canvas" ? id : "", "canvas");
    const project = query.data?.project;
    const projectDenied = query.error instanceof ApiError && [401, 403, 404].includes(query.error.status);
    const allowed = kind === "canvas" && Boolean(project) && !projectDenied;
    const session = useDocumentSession(id, documentId, allowed);
    const [modal, modalContext] = Modal.useModal();
    const busy = ["saving", "reloading", "copying"].includes(session.phase);
    const conflict = session.phase === "conflict";
    const listURL = `/projects/${encodeURIComponent(id)}/canvas`;
    const navigate = async (destination: string) => {
        if (session.dirty && (session.draftPending || session.draftError)) {
            const saved = await session.flush();
            if (saved === undefined) return;
            if (!saved) {
                modal.confirm({ title: "草稿尚未备份", content: "离开可能丢失当前修改。建议取消并保存到服务器。", okText: "仍然离开", cancelText: "留在画布", onOk: () => router.push(destination) });
                return;
            }
        }
        router.push(destination);
    };
    const reload = () => {
        if (session.dirty || session.retryPending)
            modal.confirm({ title: "载入最新版本？", content: "这将放弃当前页面的草稿和未确认提交，读取服务器保存的内容。需要保留修改时，请先将草稿另存为新画布。", okText: "放弃草稿并载入", cancelText: "继续编辑", onOk: () => session.reload() });
        else void session.reload();
    };
    useEffect(() => {
        const key = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                void session.save();
            }
        };
        window.addEventListener("keydown", key);
        return () => window.removeEventListener("keydown", key);
    }, [session.save]);
    const status =
        session.phase === "saving"
            ? "保存中…"
            : conflict
              ? "保存冲突 · 草稿已保留"
              : session.phase === "copying"
                ? "正在另存草稿…"
                : session.phase === "reloading"
                  ? "正在载入…"
                  : session.dirty
                    ? "未保存到服务器"
                    : session.document
                      ? "已保存到服务器"
                      : "";
    const error = kind !== "canvas" ? "画布工作台不存在" : query.isError && !allowed ? query.error.message : session.phase === "blocked" || (!session.content && session.phase === "error") ? session.message : "";
    const header = (
        <div className={styles.documentBar} data-document-id={documentId} data-document-revision={session.revision}>
            <Dropdown
                trigger={["click"]}
                menu={{
                    items: [
                        { key: "projects", label: "项目库", icon: <ProjectIcon name="projects" />, onClick: () => void navigate("/projects") },
                        { key: "overview", label: "项目概览", icon: <ProjectIcon name="overview" />, onClick: () => void navigate(`/projects/${encodeURIComponent(id)}`) },
                        { key: "documents", label: "画布列表", icon: <ProjectIcon name="canvas" />, onClick: () => void navigate(listURL) },
                        { type: "divider" },
                        { key: "assets", label: "资产创意", icon: <ProjectIcon name="assets" />, onClick: () => void navigate(`/projects/${encodeURIComponent(id)}/assets`) },
                    ],
                }}
            >
                <Button type="text" aria-label="打开画布菜单" icon={<ProjectIcon name="menu" />} />
            </Dropdown>
            <Button type="text" className={styles.projectName} title={project?.title} aria-label="返回项目概览" onClick={() => void navigate(`/projects/${encodeURIComponent(id)}`)}>
                {project?.title}
            </Button>
            <span className={styles.titleSeparator}>/</span>
            <Button type="text" aria-label="返回画布列表" onClick={() => void navigate(listURL)}>画面创作</Button>
            <span className={styles.titleSeparator}>/</span>
            <Input
                aria-label="画布名称"
                variant="borderless"
                className={styles.title}
                maxLength={80}
                value={session.title}
                disabled={session.retryCopyPending || session.phase === "copying" || session.phase === "reloading"}
                onChange={(event) => session.setTitle(event.target.value)}
            />
            <div className={styles.status} role="status" data-testid="document-save-status" data-dirty={session.dirty}>
                <div>{status}</div>
                {session.dirty && <div>{session.draftError ? "本地草稿未备份" : session.draftPending ? "正在备份本页草稿…" : "本页草稿已备份"}</div>}
            </div>
            <Button type="text" disabled={busy} aria-label="载入最新版本" icon={<ProjectIcon name="reload" />} onClick={reload} />
            <Button type="text" disabled={busy || conflict || (!session.dirty && !session.retryPending)} loading={session.phase === "saving"} onClick={() => void session.save()}>
                {session.retryPending && !busy ? "重试保存" : "保存画布"}
            </Button>
        </div>
    );
    const notice =
        session.message || session.draftError ? (
            <div className={styles.notice}>
                <Alert
                    type={conflict || session.phase === "error" || session.draftError ? "warning" : "info"}
                    showIcon
                    title={session.draftError || session.message}
                    action={
                        conflict ? (
                            <div className={styles.noticeActions}>
                                <Button size="small" disabled={busy} onClick={reload}>
                                    载入最新版本
                                </Button>
                                <Button
                                    size="small"
                                    disabled={busy}
                                    onClick={async () => {
                                        const copyId = await session.copy();
                                        if (copyId) router.push(`/projects/${encodeURIComponent(id)}/canvas/documents/${encodeURIComponent(copyId)}`);
                                    }}
                                >
                                    草稿另存为新画布
                                </Button>
                            </div>
                        ) : undefined
                    }
                />
            </div>
        ) : undefined;
    return (
        <div className={styles.page}>
            {modalContext}
            {error ? (
                <WorkspaceShell project={allowed && session.phase !== "blocked" ? project : undefined}>
                    <main className={styles.error}>
                        <Alert type="error" title={error} description="返回项目库查看当前获授权的项目。" action={<Button href="/projects">返回项目库</Button>} />
                        <Button
                            style={{ marginTop: 16 }}
                            onClick={() => {
                                if (query.isError) void query.refetch();
                                else void session.reload();
                            }}
                        >
                            重试
                        </Button>
                    </main>
                </WorkspaceShell>
            ) : !allowed || !session.content || session.phase === "loading" ? (
                <div className={styles.loading}>
                    <Spin aria-label="正在加载画布" />
                </div>
            ) : (
                <main className={styles.editor} data-project-id={id} data-workspace-id={query.data?.workspace?.id} data-workspace-kind="canvas">
                    <DocumentEditor
                        key={`${id}:${documentId}:${session.loadEpoch}`}
                        content={session.content}
                        onChange={session.setContent}
                        disabled={session.retryCopyPending || session.phase === "copying" || session.phase === "reloading"}
                        header={header}
                        notice={notice}
                    />
                </main>
            )}
        </div>
    );
}
