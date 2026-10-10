"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ApiError } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

// A lost reply is retried with the exact submitted payload and idempotency key.
export function useBudgetAction<T extends object, R>(execute: (input: T & { requestId: string }) => Promise<R>) {
    const token = useUserStore((state) => state.token);
    const pathname = usePathname();
    const scope = `${token}:${pathname}`;
    const currentScope = useRef(scope);
    currentScope.current = scope;
    const alive = useRef(true);
    const running = useRef(false);
    const submitted = useRef<(T & { requestId: string }) | null>(null);
    const [busy, setBusy] = useState(false);
    const [unknown, setUnknown] = useState(false);
    const [error, setError] = useState("");
    const [conflict, setConflict] = useState(false);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    useEffect(() => {
        if (!busy && !unknown) return;
        const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", warn);
        return () => window.removeEventListener("beforeunload", warn);
    }, [busy, unknown]);
    const run = async (input: T): Promise<R | undefined> => {
        if (running.current) return;
        running.current = true;
        submitted.current ??= { ...input, requestId: crypto.randomUUID() };
        const active = () => alive.current && currentScope.current === scope && useUserStore.getState().token === token;
        setBusy(true); setError(""); setConflict(false);
        try {
            const value = await execute(submitted.current);
            if (!active()) return;
            submitted.current = null; setUnknown(false);
            return value;
        } catch (failure) {
            if (!active()) return;
            const definitive = failure instanceof ApiError && failure.status >= 400 && failure.status < 500;
            if (definitive) submitted.current = null;
            setUnknown(!definitive);
            setConflict(failure instanceof ApiError && failure.status === 409);
            setError(failure instanceof Error ? failure.message : "请求未完成，请重试");
            if (failure instanceof ApiError && failure.status === 401) useUserStore.getState().clearSession();
        } finally {
            running.current = false;
            if (active()) setBusy(false);
        }
    };
    return { run, busy, unknown, error, conflict };
}
