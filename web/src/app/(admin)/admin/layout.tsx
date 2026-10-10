"use client";

import { Spin, theme } from "antd";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { useUserStore } from "@/stores/use-user-store";

export default function AdminLayout({ children }: { children: ReactNode }) {
    const { token: colors } = theme.useToken();
    const router = useRouter();
    const pathname = usePathname();
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);

    useEffect(() => {
        // A departing layout can still observe the destination during a route transition.
        if (!isReady || !(pathname === "/admin" || pathname.startsWith("/admin/"))) return;
        if (!token) router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
        else if (user?.role !== "admin") router.replace("/projects");
    }, [isReady, pathname, router, token, user?.role]);

    if (!isReady || !token || user?.role !== "admin") {
        return <div style={{ display: "grid", height: "100dvh", placeItems: "center", background: colors.colorBgLayout }}><Spin aria-label="正在验证管理权限" /></div>;
    }
    return <div style={{ height: "100dvh", overflow: "hidden" }}><WorkspaceShell>{children}</WorkspaceShell></div>;
}
