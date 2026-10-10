"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useParams, usePathname } from "next/navigation";
import { WorkspaceShell } from "@/components/layout/workspace-shell";
import { ApiError } from "@/services/api/request";
import { useProject } from "../use-project";

function ProjectNavigation({ id, children }: { id: string; children: ReactNode }) {
    const pathname = usePathname();
    const { kind } = useParams<{ kind?: string }>();
    const query = useProject(id, kind === "canvas" || kind === "assets" ? kind : undefined);
    const previousPath = useRef(pathname);
    const { refetch } = query;
    useEffect(() => {
        if (previousPath.current === pathname) return;
        previousPath.current = pathname;
        // Keep the shell mounted, but recheck authorization at every destination.
        void refetch({ cancelRefetch: false });
    }, [pathname, refetch]);
    const denied = query.error instanceof ApiError && [401, 403, 404].includes(query.error.status);
    return <WorkspaceShell project={denied ? undefined : query.data?.project}>{children}</WorkspaceShell>;
}

export default function ProjectLayout({ children }: { children: ReactNode }) {
    const { id, documentId } = useParams<{ id: string; documentId?: string }>();
    // The original document editor owns its full-screen controls and leave guard.
    if (documentId) return children;
    return <ProjectNavigation key={id} id={id}>{children}</ProjectNavigation>;
}
