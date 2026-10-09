"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Spin } from "antd";
import { useUserStore } from "@/stores/use-user-store";

export default function UserLayout({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const router = useRouter();
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);
    const publicPage = pathname === "/login" || pathname === "/tokendance/callback";
    const projectPage = pathname === "/projects" || pathname.startsWith("/projects/");

    useEffect(() => {
        if (!isReady || publicPage) return;
        if (!projectPage) router.replace("/projects");
        else if (!token || !user) router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
    }, [isReady, pathname, projectPage, publicPage, router, token, user]);

    const allowed = publicPage || (isReady && projectPage && Boolean(token && user));
    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            {allowed ? (
                children
            ) : (
                <div className="flex h-full items-center justify-center">
                    <Spin aria-label="正在加载账号" />
                </div>
            )}
        </div>
    );
}
