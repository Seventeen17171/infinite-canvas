"use client";

import { useParams } from "next/navigation";
import { Alert, Button, Spin } from "antd";
import { ProjectIcon } from "@/components/ui/project-icon";
import { DocumentList } from "@/components/production-canvas/document-list";
import { AssetWorkbench } from "@/components/production-assets/asset-workbench";
import type { WorkspaceKind } from "@/services/api/production-projects";
import { useProject } from "../../use-project";
import styles from "../../projects.module.css";

export default function ProjectWorkspacePage() {
    const { id, kind } = useParams<{ id: string; kind: string }>();
    const valid = kind === "canvas" || kind === "assets";
    const query = useProject(valid ? id : "", valid ? (kind as WorkspaceKind) : undefined);
    const project = query.data?.project;
    const workspace = query.data?.workspace;
    if (!valid)
        return (
            <>
                <main className={styles.error}>
                    <Alert type="error" title="工作台不存在" action={<Button href="/projects">返回项目库</Button>} />
                </main>
            </>
        );
    if (query.isPending)
        return (
            <>
                <div className={styles.empty}>
                    <Spin aria-label="正在加载工作台" />
                </div>
            </>
        );
    if (!project || !workspace || query.isError)
        return (
            <>
                <main className={styles.error}>
                    <Alert type="error" title={query.error?.message || "工作台无法访问"} description="返回项目库查看当前获授权的项目。" showIcon action={<Button href="/projects">返回项目库</Button>} />
                    <Button style={{ marginTop: 18 }} onClick={() => void query.refetch()}>
                        重试
                    </Button>
                </main>
            </>
        );
    const canvas = workspace.kind === "canvas";
    if (!canvas) return <AssetWorkbench project={project} />;
    return (
        <>
            <main className={styles.content} data-project-id={project.id} data-workspace-id={workspace.id} data-workspace-kind={workspace.kind}>
                <div className={styles.spaceTop}>
                    <span className={styles.workspaceIcon}>
                        <ProjectIcon name={canvas ? "canvas" : "assets"} />
                    </span>
                    <div>
                        <h1 className={styles.heading}>{canvas ? "画面创作" : "资产创意"}</h1>
                        <p className={styles.description}>
                            {canvas ? "项目画布集中管理，打开文档继续创作。" : "项目内的角色、场景与道具资产空间。"}
                        </p>
                    </div>
                </div>
                <DocumentList key={project.id} projectId={project.id} />
            </main>
        </>
    );
}
