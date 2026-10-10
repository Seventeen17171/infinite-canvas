"use client";

import { Button, Dropdown, Tooltip, theme } from "antd";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { ProjectIcon } from "@/components/ui/project-icon";
import type { ProductionProject } from "@/services/api/production-projects";
import { useNavigationStore } from "@/stores/use-navigation-store";
import { useUserStore } from "@/stores/use-user-store";
import styles from "./workspace-shell.module.css";

const adminLinks = [
    { href: "/admin/project-budgets", label: "项目积分审批", icon: "budget" },
    { href: "/admin/users", label: "用户管理", icon: "team" },
    { href: "/admin/credit-logs", label: "算力点日志", icon: "credits" },
    { href: "/admin/ai-logs", label: "AI 日志", icon: "logs" },
    { href: "/admin/prompts", label: "提示词管理", icon: "text" },
    { href: "/admin/assets", label: "素材库", icon: "assets" },
    { href: "/admin/settings", label: "系统设置", icon: "settings" },
] as const;

export function WorkspaceShell({ project, children }: { project?: ProductionProject; children: ReactNode }) {
    const { token } = theme.useToken();
    const pathname = usePathname();
    const router = useRouter();
    const user = useUserStore((state) => state.user);
    const clearSession = useUserStore((state) => state.clearSession);
    const { collapsed, motionEnabled, load, toggle, toggleMotion } = useNavigationStore();
    const contentRef = useRef<HTMLDivElement>(null);
    useEffect(load, [load]);
    useEffect(() => {
        const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
        if (!motionEnabled || preference.matches) return;
        // Animate the existing content surface; never remount forms or the project shell.
        const animation = contentRef.current?.animate(
            [{ opacity: 0.72, transform: "translateY(4px)" }, { opacity: 1, transform: "translateY(0)" }],
            { duration: 200, easing: "cubic-bezier(.2,.7,.2,1)" },
        );
        const stop = () => { if (preference.matches) animation?.cancel(); };
        preference.addEventListener("change", stop);
        return () => { animation?.cancel(); preference.removeEventListener("change", stop); };
    }, [pathname, motionEnabled]);
    const base = project ? `/projects/${encodeURIComponent(project.id)}` : "";
    // Only a project returned for this route may label its navigation.
    const currentProject = project && (pathname === base || pathname.startsWith(`${base}/`)) ? project : undefined;
    const projectLinks = currentProject ? [
        { href: base, label: "项目概览", icon: "overview" as const },
        { href: `${base}/canvas`, label: "画面创作", icon: "canvas" as const },
        { href: `${base}/assets`, label: "资产创意", icon: "assets" as const },
    ] : [];
    const isAdmin = pathname === "/admin" || pathname.startsWith("/admin/");
    const adminPage = adminLinks.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
    const workspace = projectLinks.find((item) => item.href !== base && (pathname === item.href || pathname.startsWith(`${item.href}/`)));
    const account = user?.displayName || user?.username || "当前账号";
    const colors = {
        "--workspace-bg": token.colorBgLayout,
        "--workspace-surface": token.colorBgContainer,
        "--workspace-selected": token.colorFillSecondary,
        "--workspace-hover": token.colorFillTertiary,
        "--workspace-border": token.colorBorderSecondary,
        "--workspace-text": token.colorText,
        "--workspace-muted": token.colorTextSecondary,
        "--workspace-subtle": token.colorTextTertiary,
        "--workspace-focus": token.colorPrimary,
    } as CSSProperties;
    const link = (item: { href: string; label: string; icon: Parameters<typeof ProjectIcon>[0]["name"] }) => {
        const active = pathname === item.href || (item.href !== "/projects" && item.href !== base && pathname.startsWith(`${item.href}/`));
        return (
            <Tooltip key={item.href} title={collapsed ? item.label : undefined} placement="right">
                <Link href={item.href} prefetch={false} aria-label={item.label} aria-current={active ? "page" : undefined} className={`${styles.navLink} ${active ? styles.active : ""}`}>
                    <ProjectIcon name={item.icon} />
                    <span className={styles.linkLabel}>{item.label}</span>
                </Link>
            </Tooltip>
        );
    };
    return (
        <div className={`${styles.shell} ${collapsed ? styles.collapsed : ""}`} style={colors} data-testid="workspace-shell" data-sidebar-collapsed={collapsed} data-workspace-motion={motionEnabled ? "on" : "off"}>
            <aside className={styles.sidebar} aria-label="工作站侧栏" id="workspace-sidebar">
                <Link href="/projects" prefetch={false} className={styles.brand} aria-label="映序 Studio 项目库">
                    <span className={styles.logo} aria-hidden />
                    <span className={styles.brandLabel}>映序 Studio</span>
                </Link>
                <nav className={styles.navigation} aria-label="工作站主导航">
                    <section className={styles.group} aria-label="工作空间">
                        <div className={styles.groupTitle}>工作空间</div>
                        {link({ href: "/projects", label: "项目库", icon: "projects" })}
                    </section>
                    {currentProject && (
                        <section className={styles.group} aria-label="当前项目导航">
                            <div className={styles.projectContext}>
                                <span className={styles.groupTitle}>当前项目</span>
                                <span className={styles.projectTitle} title={currentProject.title}>{currentProject.title}</span>
                            </div>
                            {projectLinks.map(link)}
                        </section>
                    )}
                    {user?.role === "admin" && (
                        <section className={styles.group} aria-label="管理后台导航">
                            <div className={styles.groupTitle}>管理后台</div>
                            {adminLinks.map(link)}
                        </section>
                    )}
                </nav>
                <div className={styles.sidebarFooter}>
                    <Dropdown trigger={["click"]} placement="topLeft" menu={{ items: [
                        { key: "logout", icon: <ProjectIcon name="logout" />, label: "退出登录", onClick: () => { clearSession(); router.replace("/login"); } },
                    ] }}>
                        <button type="button" className={styles.account} aria-label={`账号菜单：${account}`}>
                            <span className={styles.avatar} aria-hidden>{account.slice(0, 1)}</span>
                            <span className={styles.accountInfo}><span title={account}>{account}</span><small>{user?.role === "admin" ? "管理员" : "制作成员"}</small></span>
                            <span className={styles.accountChevron}><ProjectIcon name="down" /></span>
                        </button>
                    </Dropdown>
                    <a className={styles.attribution} href="https://github.com/tigerowo/infinite-canvas" target="_blank" rel="noreferrer" title="基于无限画布 · infinite-canvas">基于无限画布</a>
                </div>
            </aside>
            <div className={styles.body}>
                <header className={styles.header}>
                    <span className={styles.signalTrack} aria-hidden="true" />
                    <Tooltip title={collapsed ? "展开主菜单" : "收起主菜单"}>
                        <Button type="text" aria-label={collapsed ? "展开主菜单" : "收起主菜单"} aria-expanded={!collapsed} aria-controls="workspace-sidebar" icon={<ProjectIcon name={collapsed ? "panelOpen" : "panelClose"} />} onClick={toggle} />
                    </Tooltip>
                    <nav className={styles.breadcrumb} aria-label="页面路径">
                        <ol>
                            <li>{pathname === "/projects" ? <span aria-current="page">项目库</span> : <Link href="/projects" prefetch={false}>项目库</Link>}</li>
                            {isAdmin && <><li className={styles.separator} aria-hidden>/</li><li><span>管理后台</span></li>{adminPage && <><li className={styles.separator} aria-hidden>/</li><li><span aria-current="page">{adminPage.label}</span></li></>}</>}
                            {currentProject && <><li className={styles.separator} aria-hidden>/</li><li className={styles.projectCrumb} title={currentProject.title}>{workspace ? <Link href={base} prefetch={false}>{currentProject.title}</Link> : <span aria-current="page">{currentProject.title}</span>}</li>{workspace && <><li className={styles.separator} aria-hidden>/</li><li><span aria-current="page">{workspace.label}</span></li></>}</>}
                            {!currentProject && !isAdmin && pathname !== "/projects" && <><li className={styles.separator} aria-hidden>/</li><li><span aria-current="page">项目空间</span></li></>}
                        </ol>
                    </nav>
                    <Tooltip title={motionEnabled ? "暂停界面动效" : "开启界面动效"}>
                        <Button className={styles.motionButton} type="text" aria-label={motionEnabled ? "暂停界面动效" : "开启界面动效"} aria-pressed={motionEnabled} icon={<ProjectIcon name={motionEnabled ? "pause" : "play"} />} onClick={toggleMotion}>动效</Button>
                    </Tooltip>
                </header>
                <div ref={contentRef} className={styles.content} data-testid="workspace-content">{children}</div>
            </div>
        </div>
    );
}
