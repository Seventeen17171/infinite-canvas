"use client";

import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { App } from "antd";

import { fetchUserConfig } from "@/services/api/user-config";
import { STORAGE_SYNC_FAILED_EVENT, defaultUserStorageProvider, defaultUserWebDAVStorageProvider, saveUserStorageProvider, saveUserWebDAVStorageProvider } from "@/services/image-storage";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message } = App.useApp();
    const pathname = usePathname();
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const hydrateUser = useUserStore((state) => state.hydrateUser);
    const loadPublicSettings = useConfigStore((state) => state.loadPublicSettings);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isLoginPage = pathname === "/login" || pathname === "/admin/login";
    const isTeamPage = !pathname.startsWith("/admin");
    const accountSessionRef = useRef({ token, userId: user?.id || "" });

    useEffect(() => {
        const onSyncFailed = (event: Event) => {
            const detail = (event as CustomEvent<string>).detail;
            message.warning({ key: STORAGE_SYNC_FAILED_EVENT, content: `云端同步失败，已保留原始素材${detail ? `：${detail}` : ""}` });
        };
        window.addEventListener(STORAGE_SYNC_FAILED_EVENT, onSyncFailed);
        return () => window.removeEventListener(STORAGE_SYNC_FAILED_EVENT, onSyncFailed);
    }, [message]);

    useEffect(() => { void loadPublicSettings(); }, [loadPublicSettings]);
    useEffect(() => { if (!isLoginPage) void hydrateUser(); }, [hydrateUser, isLoginPage]);

    useLayoutEffect(() => {
        const previous = accountSessionRef.current;
        const userId = user?.id || "";
        if ((previous.token && !token) || (previous.userId && userId && previous.userId !== userId)) {
            useConfigStore.setState({ config: defaultConfig, isConfigOpen: false });
        }
        accountSessionRef.current = { token, userId };
    }, [token, user?.id]);

    useEffect(() => {
        if (isTeamPage || !token || !user?.id) return;
        const accountToken = token;
        const accountId = user.id;
        let canceled = false;
        void fetchUserConfig(accountToken).then((payload) => {
            if (canceled || useUserStore.getState().token !== accountToken || useUserStore.getState().user?.id !== accountId) return;
            const syncS3 = payload.storageSync?.s3 === true;
            const syncWebDAV = payload.storageSync?.webdav === true;
            updateConfig("syncStorageConfig", syncS3);
            updateConfig("syncWebDAVStorageConfig", syncWebDAV);
            if (syncS3 && payload.storageProvider?.s3) saveUserStorageProvider({ ...defaultUserStorageProvider(), ...payload.storageProvider.s3, type: "s3" });
            if (syncWebDAV && payload.storageProvider?.webdav) saveUserWebDAVStorageProvider({ ...defaultUserWebDAVStorageProvider(), ...payload.storageProvider.webdav, type: "webdav" });
        }).catch(() => {});
        return () => { canceled = true; };
    }, [isTeamPage, token, updateConfig, user?.id]);

    return <>{children}</>;
}
