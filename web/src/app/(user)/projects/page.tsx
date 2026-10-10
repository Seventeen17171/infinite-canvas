"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Input, Pagination, Spin } from "antd";
import Link from "next/link";
import dayjs from "dayjs";
import { ProjectIcon } from "@/components/ui/project-icon";
import { ApiError } from "@/services/api/request";
import { fetchProductionProjects } from "@/services/api/production-projects";
import { useUserStore } from "@/stores/use-user-store";
import { ProjectHeader } from "./project-header";
import { ProjectDialog } from "./project-dialog";
import styles from "./projects.module.css";

export default function ProjectsPage() {
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const queryClient = useQueryClient();
    const [search, setSearch] = useState("");
    const [keyword, setKeyword] = useState("");
    const [page, setPage] = useState(1);
    const [creating, setCreating] = useState(false);
    const canCreate = Boolean(user && user.role !== "guest");
    const query = useQuery({
        queryKey: ["production", "projects", token, keyword, page],
        queryFn: () => fetchProductionProjects(token, { keyword, page, pageSize: 12 }),
        enabled: Boolean(token),
        retry: false,
        staleTime: 0,
        gcTime: 0,
        refetchOnMount: "always",
    });
    useEffect(() => {
        if (query.error instanceof ApiError && query.error.status === 401 && useUserStore.getState().token === token) useUserStore.getState().clearSession();
    }, [query.error, token]);
    const projects = query.data?.items || [];

    return (
        <>
            <ProjectHeader />
            <main className={styles.content}>
                <div className={styles.headingRow}>
                    <div>
                        <h1 className={styles.heading}>项目库</h1>
                        <p className={styles.description}>从项目进入画面创作与资产创意，内容随项目分别管理。</p>
                    </div>
                    {canCreate && (
                        <Button type="primary" size="large" icon={<ProjectIcon name="plus" />} onClick={() => setCreating(true)}>
                            创建项目
                        </Button>
                    )}
                </div>
                <div className={styles.toolbar}>
                    <Input.Search
                        className={styles.search}
                        aria-label="搜索项目"
                        placeholder="搜索项目名称"
                        value={search}
                        allowClear
                        onChange={(event) => setSearch(event.target.value)}
                        onSearch={(value) => {
                            setKeyword(value.trim());
                            setPage(1);
                        }}
                    />
                    <div className={styles.actions}>
                        <span className={styles.count}>{query.data ? `${query.data.total} 个获授权项目` : ""}</span>
                        <Button type="text" aria-label="刷新项目" icon={<ProjectIcon name="reload" />} loading={query.isFetching} onClick={() => void query.refetch()} />
                    </div>
                </div>
                {query.isError ? (
                    <Alert type="error" title={query.error.message} description="项目尚未载入，请重试。" showIcon action={<Button onClick={() => void query.refetch()}>重试</Button>} />
                ) : query.isPending ? (
                    <div className={styles.empty}>
                        <Spin aria-label="正在加载项目" />
                    </div>
                ) : projects.length ? (
                    <div className={styles.directory}>
                        <div className={styles.columnLabels} aria-hidden>
                            <span>项目</span>
                            <span>制作负责人</span>
                            <span>创建人员</span>
                            <span>最近更新</span>
                            <span />
                        </div>
                        {projects.map((project) => (
                            <article key={project.id} className={styles.projectRow} data-project-id={project.id}>
                                <div className={styles.projectIdentity}>
                                    <span className={styles.folderIcon}>
                                        <ProjectIcon name="projects" />
                                    </span>
                                    <div style={{ minWidth: 0, flex: 1 }}>
                                        <Link className={styles.projectTitle} href={`/projects/${encodeURIComponent(project.id)}`}>
                                            {project.title}
                                        </Link>
                                        <p className={styles.projectSummary}>{project.summary || "未填写项目说明"}</p>
                                    </div>
                                </div>
                                <span className={styles.cell} title={project.producerName}>
                                    {project.producerName}
                                </span>
                                <span className={styles.cell}>{project.creatorName}</span>
                                <span className={styles.cell}>{dayjs(project.updatedAt).format("YYYY-MM-DD HH:mm")}</span>
                                <Button type="text" href={`/projects/${encodeURIComponent(project.id)}`} icon={<ProjectIcon name="enter" />} aria-label={`进入项目 ${project.title}`}>
                                    进入
                                </Button>
                            </article>
                        ))}
                    </div>
                ) : (
                    <div className={styles.directory}>
                        <div className={styles.empty}>
                            <div className={styles.emptyIcon}>
                                <ProjectIcon name="projects" />
                            </div>
                            <h2>{keyword ? "没有找到相关项目" : canCreate ? "开始第一个制作项目" : "暂无项目"}</h2>
                            <p>{keyword ? "尝试其他关键词，或清除搜索查看全部获授权项目。" : canCreate ? "创建项目后，你将默认担任制作组长，可开始筹备并申请项目积分。" : "登录有效账号后可创建项目。"}</p>
                        </div>
                    </div>
                )}
                {(query.data?.total || 0) > 12 && (
                    <div className={styles.footer}>
                        <Pagination current={page} pageSize={12} total={query.data?.total} showSizeChanger={false} onChange={setPage} />
                    </div>
                )}
            </main>
            {canCreate && (
                <ProjectDialog
                    open={creating}
                    onClose={() => setCreating(false)}
                    onSaved={() => {
                        setCreating(false);
                        void queryClient.invalidateQueries({ queryKey: ["production", "projects", token] });
                    }}
                />
            )}
        </>
    );
}
