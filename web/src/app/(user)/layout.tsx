"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";

import { AppTopNav } from "@/components/layout/app-top-nav";
import { fetchUserConfig } from "@/services/api/user-config";
import { useUserStore } from "@/stores/use-user-store";

const protectedPrefixes = ["/asset-library"];

export default function UserLayout({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const router = useRouter();
    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);
    const isProtectedPage = protectedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

    useEffect(() => {
        if (!isReady || !isProtectedPage || user) return;
        router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
    }, [isProtectedPage, isReady, pathname, router, user]);

    useEffect(() => {
        if (!isReady || !user) return;
        const token = useUserStore.getState().token;
        if (!token) return;
        let cancelled = false;
        let unsubscribeHydration = () => { };
        const isCurrentSession = () => !cancelled && useUserStore.getState().token === token;
        fetchUserConfig(token).then(async (config) => {
            if (!isCurrentSession()) return;
            const syncEnabled = config.syncCapabilities?.userData === true;
            const { useCanvasStore } = await import("@/app/(user)/canvas/stores/use-canvas-store");
            if (!isCurrentSession()) return;
            const canvasStore = useCanvasStore.getState();
            canvasStore.setSyncEnabled(syncEnabled);
            const syncCanvas = () => {
                unsubscribeHydration();
                if (isCurrentSession()) void useCanvasStore.getState().syncWithRemote(token, true);
            };
            if (syncEnabled) {
                if (useCanvasStore.persist.hasHydrated()) syncCanvas();
                else unsubscribeHydration = useCanvasStore.persist.onFinishHydration(syncCanvas);
            }
            const { useAssetStore } = await import("@/stores/use-asset-store");
            if (isCurrentSession()) void useAssetStore.getState().hydrateAccountAssets(token, syncEnabled);
        }).catch(() => { });
        return () => {
            cancelled = true;
            unsubscribeHydration();
        };
    }, [isReady, user]);

    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            <AppTopNav />
            <div className="min-h-0 flex-1 overflow-hidden">{isProtectedPage && (!isReady || !user) ? null : children}</div>
        </div>
    );
}
