"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";

import { AUTH_TOKEN_KEY, fetchCurrentUser, login, register, type AuthPayload, type AuthSession, type AuthUser } from "@/services/api/auth";

export class StaleSessionError extends Error {
    constructor() {
        super("登录请求已失效");
        this.name = "StaleSessionError";
    }
}

type UserStore = {
    token: string;
    user: AuthUser | null;
    isReady: boolean;
    isLoading: boolean;
    sessionRevision: number;
    setSession: (token: string, user: AuthUser) => void;
    clearSession: () => void;
    cancelAuthentication: (revision: number) => void;
    hydrateUser: () => Promise<void>;
    login: (payload: AuthPayload) => Promise<AuthUser>;
    register: (payload: AuthPayload) => Promise<AuthUser>;
};

export const useUserStore = create<UserStore>()(
    persist(
        (set, get) => {
            const authenticate = async (action: (payload: AuthPayload) => Promise<AuthSession>, payload: AuthPayload) => {
                const revision = get().sessionRevision + 1;
                set({ sessionRevision: revision, isLoading: true });
                try {
                    const session = await action(payload);
                    if (get().sessionRevision !== revision) throw new StaleSessionError();
                    set({ token: session.token, user: session.user, isReady: true, isLoading: false });
                    return session.user;
                } catch (error) {
                    if (get().sessionRevision !== revision) throw new StaleSessionError();
                    set({ isLoading: false });
                    throw error;
                }
            };
            return {
                token: "",
                user: null,
                isReady: false,
                isLoading: false,
                sessionRevision: 0,
                setSession: (token, user) => set({ token, user, isReady: true, isLoading: false, sessionRevision: get().sessionRevision + 1 }),
                clearSession: () => set({ token: "", user: null, isReady: true, isLoading: false, sessionRevision: get().sessionRevision + 1 }),
                cancelAuthentication: (revision) => {
                    if (get().sessionRevision === revision) set({ sessionRevision: revision + 1, isLoading: false });
                },
                hydrateUser: async () => {
                    const token = get().token;
                    const revision = get().sessionRevision;
                    if (!token) {
                        set({ user: null, isReady: true });
                        return;
                    }
                    set({ isLoading: true });
                    try {
                        const user = await fetchCurrentUser(token);
                        if (get().token !== token || get().sessionRevision !== revision) return;
                        if (user.role === "guest") {
                            set({ token: "", user: null, isReady: true, isLoading: false });
                            return;
                        }
                        set({ user, isReady: true, isLoading: false });
                    } catch {
                        if (get().token !== token || get().sessionRevision !== revision) return;
                        set({ token: "", user: null, isReady: true, isLoading: false });
                    }
                },
                login: (payload) => authenticate(login, payload),
                register: (payload) => authenticate(register, payload),
            };
        },
        {
            name: AUTH_TOKEN_KEY,
            partialize: (state) => ({ token: state.token }),
            onRehydrateStorage: () => (state) => {
                if (state) state.isReady = false;
            },
        },
    ),
);
