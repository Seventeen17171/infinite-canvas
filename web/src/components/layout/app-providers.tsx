"use client";

import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useState } from "react";
import { ProConfigProvider } from "@ant-design/pro-components";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import { usePathname } from "next/navigation";

import { ClientRootInit } from "@/components/layout/client-root-init";
import { getAntThemeConfig, getStudioAntThemeConfig } from "@/lib/app-theme";
import { useNavigationStore } from "@/stores/use-navigation-store";
import { useThemeStore } from "@/stores/use-theme-store";

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 30_000,
            retry: false,
            refetchOnWindowFocus: false,
        },
    },
});

export function AppProviders({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const theme = useThemeStore((state) => state.theme);
    const motionEnabled = useNavigationStore((state) => state.motionEnabled);
    const loadNavigation = useNavigationStore((state) => state.load);
    const [reducedMotion, setReducedMotion] = useState(true);
    const isDocument = /^\/projects\/[^/]+\/[^/]+\/documents\/[^/]+(?:\/|$)/.test(pathname);
    const studio = !isDocument && (pathname === "/login" || /^\/(projects|admin)(?:\/|$)/.test(pathname));
    const dark = studio || theme === "dark";
    const motion = motionEnabled && !reducedMotion;

    useEffect(() => {
        loadNavigation();
        const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
        const update = () => setReducedMotion(preference.matches);
        update();
        preference.addEventListener("change", update);
        return () => preference.removeEventListener("change", update);
    }, [loadNavigation]);

    useLayoutEffect(() => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.colorScheme = dark ? "dark" : "light";
        if (studio) {
            document.documentElement.dataset.studio = "true";
            document.documentElement.dataset.studioMotion = motion ? "on" : "off";
        } else {
            delete document.documentElement.dataset.studio;
            delete document.documentElement.dataset.studioMotion;
        }
    }, [dark, motion, studio]);

    return (
        <ConfigProvider locale={zhCN} theme={studio ? getStudioAntThemeConfig(motion) : getAntThemeConfig(dark)}>
            <ProConfigProvider dark={dark}>
                <App>
                    <QueryClientProvider client={queryClient}>
                        <ClientRootInit>{children}</ClientRootInit>
                    </QueryClientProvider>
                </App>
            </ProConfigProvider>
        </ConfigProvider>
    );
}
