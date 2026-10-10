import { create } from "zustand";

const key = "infinite-canvas:sidebar-collapsed";

export const useNavigationStore = create<{
    collapsed: boolean;
    loaded: boolean;
    load: () => void;
    toggle: () => void;
}>((set, get) => ({
    collapsed: false,
    loaded: false,
    load: () => {
        if (get().loaded) return;
        let collapsed = false;
        try {
            collapsed = localStorage.getItem(key) === "true";
        } catch {}
        set({ collapsed, loaded: true });
    },
    toggle: () => {
        const collapsed = !get().collapsed;
        set({ collapsed });
        try { localStorage.setItem(key, String(collapsed)); } catch {}
    },
}));
