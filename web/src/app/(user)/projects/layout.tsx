"use client";

import { theme } from "antd";
import type { CSSProperties, ReactNode } from "react";
import styles from "./projects.module.css";

export default function ProjectsLayout({ children }: { children: ReactNode }) {
    const { token } = theme.useToken();
    const colors = {
        "--project-background": token.colorBgLayout,
        "--project-surface": token.colorBgContainer,
        "--project-hover": token.colorFillTertiary,
        "--project-border": token.colorBorderSecondary,
        "--project-text": token.colorText,
        "--project-muted": token.colorTextSecondary,
        "--project-subtle": token.colorTextTertiary,
        "--project-focus": token.colorPrimary,
    } as CSSProperties;
    return (
        <div className={styles.shell} style={colors}>
            {children}
        </div>
    );
}
