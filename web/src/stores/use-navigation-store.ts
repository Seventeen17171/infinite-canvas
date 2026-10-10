import { create } from "zustand";

const key = "infinite-canvas:sidebar-collapsed";
const motionKey = "infinite-canvas:workspace-motion";

export const useNavigationStore = create<{
    collapsed: boolean;
    motionEnabled: boolean;
    loaded: boolean;
    load: () => void;
    toggle: () => void;
    toggleMotion: () => void;
}>((set, get) => ({
    collapsed: false,
    motionEnabled: true,
    loaded: false,
    load: () => {
        if (get().loaded) return;
        let collapsed = false;
        let motionEnabled = true;
        try {
            collapsed = localStorage.getItem(key) === "true";
            motionEnabled = localStorage.getItem(motionKey) !== "false";
        } catch {}
        set({ collapsed, motionEnabled, loaded: true });
    },
    toggle: () => {
        const collapsed = !get().collapsed;
        set({ collapsed });
        try { localStorage.setItem(key, String(collapsed)); } catch {}
    },
    toggleMotion: () => {
        const motionEnabled = !get().motionEnabled;
        set({ motionEnabled });
        try { localStorage.setItem(motionKey, String(motionEnabled)); } catch {}
    },
}));
