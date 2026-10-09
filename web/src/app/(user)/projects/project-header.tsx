"use client";

import { Button, Tooltip } from "antd";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ProjectIcon } from "@/components/ui/project-icon";
import type { ProductionProject } from "@/services/api/production-projects";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import styles from "./projects.module.css";

function AccountActions() {
    const user = useUserStore((state) => state.user);
    const clearSession = useUserStore((state) => state.clearSession);
    const mode = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const router = useRouter();
    return (
        <div className={styles.actions}>
            <span className={styles.accountName}>{user?.displayName || user?.username}</span>
            {user?.role === "admin" && (
                <Button type="text" href="/admin/users" icon={<ProjectIcon name="team" />}>
                    账号管理
                </Button>
            )}
            <Tooltip title={mode === "dark" ? "切换到浅色主题" : "切换到深色主题"}>
                <Button type="text" aria-label="切换主题" icon={<ProjectIcon name={mode === "dark" ? "sun" : "moon"} />} onClick={() => setTheme(mode === "dark" ? "light" : "dark")} />
            </Tooltip>
            <Tooltip title="退出登录">
                <Button
                    type="text"
                    aria-label="退出登录"
                    icon={<ProjectIcon name="logout" />}
                    onClick={() => {
                        clearSession();
                        router.replace("/login");
                    }}
                />
            </Tooltip>
        </div>
    );
}

export function ProjectHeader({ project }: { project?: ProductionProject }) {
    const pathname = usePathname();
    const base = project ? `/projects/${encodeURIComponent(project.id)}` : "";
    return (
        <>
            <header className={styles.header}>
                {project ? (
                    <div className={styles.projectTop}>
                        <Button type="text" href="/projects" icon={<ProjectIcon name="back" />}>
                            项目库
                        </Button>
                        <div className={styles.projectTopInfo}>
                            <div className={styles.projectTopTitle} title={project.title}>
                                {project.title}
                            </div>
                            <div className={styles.owner}>制作负责人：{project.producerName}</div>
                        </div>
                    </div>
                ) : (
                    <div className={styles.brand}>
                        <span className={styles.brandMark} aria-hidden />
                        <div>
                            <div className={styles.brandTitle}>映序 Studio</div>
                            <div className={styles.attribution}>基于无限画布 · infinite-canvas</div>
                        </div>
                    </div>
                )}
                <AccountActions />
            </header>
            {project && (
                <nav className={styles.tabs} aria-label="项目内导航">
                    {(
                        [
                            { path: base, name: "项目概览", icon: "projects" },
                            { path: `${base}/canvas`, name: "画面创作", icon: "canvas" },
                            { path: `${base}/assets`, name: "资产创意", icon: "assets" },
                        ] as const
                    ).map((item) => (
                        <Link
                            key={item.path}
                            href={item.path}
                            aria-current={pathname === item.path || (item.icon === "canvas" && pathname.startsWith(`${item.path}/`)) ? "page" : undefined}
                            className={`${styles.tab} ${pathname === item.path || (item.icon === "canvas" && pathname.startsWith(`${item.path}/`)) ? styles.tabActive : ""}`}
                        >
                            <ProjectIcon name={item.icon} />
                            {item.name}
                        </Link>
                    ))}
                </nav>
            )}
        </>
    );
}
