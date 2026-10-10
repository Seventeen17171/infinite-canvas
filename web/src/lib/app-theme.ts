import type { ThemeConfig } from "antd";
import { theme as antdTheme } from "antd";

const neutral = {
    light: {
        primary: "#171717",
        primaryHover: "#000000",
        primaryText: "#ffffff",
        menuBg: "#f5f5f5",
        menuText: "#171717",
        selectActiveBg: "#f5f5f5",
        selectSelectedBg: "#f0f0f0",
        selectText: "#171717",
        tableSelectedBg: "rgba(17, 17, 17, 0.05)",
        tableSelectedHoverBg: "rgba(17, 17, 17, 0.08)",
    },
    dark: {
        primary: "#fafafa",
        primaryHover: "#ffffff",
        primaryText: "#171717",
        menuBg: "#262626",
        menuText: "#fafafa",
        selectActiveBg: "#262626",
        selectSelectedBg: "#333333",
        selectText: "#fafafa",
        tableSelectedBg: "rgba(255, 255, 255, 0.08)",
        tableSelectedHoverBg: "rgba(255, 255, 255, 0.12)",
    },
};

export function getAntThemeConfig(dark: boolean): ThemeConfig {
    const color = dark ? neutral.dark : neutral.light;

    return {
        algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        cssVar: { key: dark ? "infinite-canvas-dark" : "infinite-canvas-light" },
        token: {
            colorPrimary: color.primary,
            colorInfo: color.primary,
            colorLink: color.primary,
            colorLinkHover: color.primaryHover,
            colorLinkActive: color.primary,
            colorTextLightSolid: color.primaryText,
        },
        components: {
            Button: {
                primaryShadow: "none",
            },
            Menu: {
                itemActiveBg: color.menuBg,
                itemHoverBg: color.menuBg,
                itemSelectedBg: color.menuBg,
                itemSelectedColor: color.menuText,
                darkItemHoverBg: neutral.dark.menuBg,
                darkItemSelectedBg: neutral.dark.menuBg,
                darkItemSelectedColor: neutral.dark.menuText,
            },
            Select: {
                optionActiveBg: color.selectActiveBg,
                optionSelectedBg: color.selectSelectedBg,
                optionSelectedColor: color.selectText,
            },
            Table: {
                rowSelectedBg: color.tableSelectedBg,
                rowSelectedHoverBg: color.tableSelectedHoverBg,
            },
        },
    };
}

/** Team pages use their own palette without changing the canvas theme preference. */
export function getStudioAntThemeConfig(motion: boolean): ThemeConfig {
    const base = getAntThemeConfig(true);
    return {
        ...base,
        cssVar: { key: "infinite-canvas-studio" },
        token: {
            ...base.token,
            motion,
            fontFamily: '"Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif',
            colorPrimary: "#D5D9DF",
            colorInfo: "#D5D9DF",
            colorLink: "#D5D9DF",
            colorLinkHover: "#FFFFFF",
            colorLinkActive: "#F4F5F7",
            colorTextLightSolid: "#08090A",
            colorBgBase: "#000000",
            colorBgLayout: "#000000",
            colorBgContainer: "#08090A",
            colorBgElevated: "#101214",
            colorBorder: "#292C30",
            colorBorderSecondary: "#222529",
            colorText: "#F4F5F7",
            colorTextSecondary: "#A1A7AE",
            colorTextTertiary: "#A1A7AE",
            colorTextPlaceholder: "#858C95",
            colorTextDisabled: "#858C95",
            colorFillAlter: "#101214",
            controlItemBgHover: "#171A1E",
            controlItemBgActive: "#22262B",
            controlOutline: "rgba(213, 217, 223, 0.22)",
            borderRadius: 8,
            boxShadowSecondary: "0 18px 60px rgba(0, 0, 0, 0.55)",
        },
        components: {
            ...base.components,
            Button: { primaryShadow: "none", defaultBg: "#08090A", defaultBorderColor: "#34383E", defaultColor: "#D5D9DF", defaultHoverBg: "#16191D", defaultHoverBorderColor: "#757D87", defaultHoverColor: "#FFFFFF" },
            Card: { headerBg: "transparent" },
            Modal: { contentBg: "#08090A", headerBg: "#08090A", footerBg: "transparent" },
            Menu: { ...base.components?.Menu, darkItemBg: "#000000", darkSubMenuItemBg: "#08090A", darkItemHoverBg: "#171A1E", darkItemSelectedBg: "#22262B" },
            Select: { optionActiveBg: "#171A1E", optionSelectedBg: "#22262B", optionSelectedColor: "#F4F5F7" },
            Table: { headerBg: "#101214", headerColor: "#A1A7AE", rowHoverBg: "#111417", rowSelectedBg: "#1B1F24", rowSelectedHoverBg: "#252A30", borderColor: "#222529" },
            Segmented: { trackBg: "#08090A", itemSelectedBg: "#262B31", itemSelectedColor: "#F4F5F7", itemColor: "#A1A7AE" },
        },
    };
}
