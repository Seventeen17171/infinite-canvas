"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { Alert, Button, Spin } from "antd";
import Link from "next/link";
import dayjs from "dayjs";
import { useQueryClient } from "@tanstack/react-query";
import { ProjectBudgetSection } from "@/components/production-budget/project-budget";
import { ApiError } from "@/services/api/request";
import { ProjectIcon } from "@/components/ui/project-icon";
import { ProjectDialog } from "../project-dialog";
import { useProject } from "../use-project";
import styles from "../projects.module.css";

export default function ProjectPage() {
    const { id } = useParams<{ id: string }>();
    const query = useProject(id);
    const queryClient = useQueryClient();
    const [assigning, setAssigning] = useState(false);
    const project = query.data?.project;
    if (query.isPending)
        return (
            <>
                <div className={styles.empty}>
                    <Spin aria-label="正在加载项目" />
                </div>
            </>
        );
    const denied = query.error instanceof ApiError && [401, 403, 404].includes(query.error.status);
    if (!project || denied)
        return (
            <>
                <main className={styles.error}>
                    <Alert type="error" title={query.error?.message || "项目无法访问"} description="返回项目库查看当前获授权的项目。" showIcon action={<Button href="/projects">返回项目库</Button>} />
                    <Button style={{ marginTop: 18 }} onClick={() => void query.refetch()}>
                        重试
                    </Button>
                </main>
            </>
        );
    const base = `/projects/${encodeURIComponent(project.id)}`;
    return (
        <>
            <main className={styles.content}>
                {query.isError && <Alert style={{ marginBottom: 22 }} type="warning" title="暂时无法刷新项目" description="已保留当前预算申请输入，请在连接恢复后刷新。" action={<Button onClick={() => void query.refetch()}>重试</Button>} />}
                <section className={styles.projectIntro}>
                    <div className={styles.headingRow} style={{ marginBottom: 0 }}>
                        <h1 className={`${styles.heading} ${styles.projectHeading}`} title={project.title}>{project.title}</h1>
                        {project.canAssign && (
                            <Button icon={<ProjectIcon name="user" />} onClick={() => setAssigning(true)}>
                                改派负责人
                            </Button>
                        )}
                    </div>
                    {project.summary && <p className={styles.summary}>{project.summary}</p>}
                    <div className={styles.projectMeta}>
                        <span title={project.producerName}>制作组长：{project.producerName}</span>
                        <span title={project.creatorName}>创建人员：{project.creatorName}</span>
                        <span>创建于 {dayjs(project.createdAt).format("YYYY-MM-DD")}</span>
                    </div>
                </section>
                <ProjectBudgetSection projectId={project.id} />
                <section className={styles.workspaceGrid} aria-label="项目工作台">
                    <Link href={`${base}/canvas`} className={styles.workspaceLink}>
                        <span className={styles.workspaceIcon}>
                            <ProjectIcon name="canvas" />
                        </span>
                        <div className={styles.workspaceInfo}>
                            <h2>画面创作</h2>
                            <p>整理画面规划与画布文档。</p>
                        </div>
                        <span className={styles.workspaceEnter}>
                            进入画面创作 <ProjectIcon name="enter" />
                        </span>
                    </Link>
                    <Link href={`${base}/assets`} className={styles.workspaceLink}>
                        <span className={styles.workspaceIcon}>
                            <ProjectIcon name="assets" />
                        </span>
                        <div className={styles.workspaceInfo}>
                            <h2>资产创意</h2>
                            <p>角色、场景与道具的创意空间。</p>
                        </div>
                        <span className={styles.workspaceEnter}>
                            进入资产创意 <ProjectIcon name="enter" />
                        </span>
                    </Link>
                </section>
            </main>
            {project.canAssign && (
                <ProjectDialog
                    open={assigning}
                    project={project}
                    onClose={() => setAssigning(false)}
                    onReload={async () => {
                        const result = await query.refetch();
                        if (result.isError) throw result.error;
                        return result.data?.project;
                    }}
                    onSaved={() => {
                        setAssigning(false);
                        void queryClient.invalidateQueries({ queryKey: ["production"] });
                    }}
                />
            )}
        </>
    );
}
