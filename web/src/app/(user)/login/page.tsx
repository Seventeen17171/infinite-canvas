"use client";

import { LockOutlined, UserOutlined } from "@ant-design/icons";
import { App, Button, Form, Input, Segmented, Space } from "antd";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

import { fetchCurrentUser } from "@/services/api/auth";
import { useConfigStore } from "@/stores/use-config-store";
import { StaleSessionError, useUserStore } from "@/stores/use-user-store";
import styles from "./login.module.css";

type LoginFormValues = {
    username: string;
    password: string;
    confirmPassword?: string;
};

// 仅放行站内相对路径，拦截开放重定向。浏览器会忽略 URL 中的 Tab/换行/回车，并把
// //host 或 /\host 解析为协议相对的跨站地址，因此先剥离控制字符，再拒绝 // 与 /\ 前缀。
function safeRedirect(value: string | null): string {
    const cleaned = (value ?? "").replace(/[\t\n\r]/g, "");
    if (!cleaned.startsWith("/") || cleaned.startsWith("//") || cleaned.startsWith("/\\")) {
        return "/projects";
    }
    return cleaned === "/" || cleaned === "/login" ? "/projects" : cleaned;
}

export default function LoginPage() {
    return (
        <Suspense fallback={null}>
            <LoginContent />
        </Suspense>
    );
}

function LoginContent() {
    const { message } = App.useApp();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const login = useUserStore((state) => state.login);
    const register = useUserStore((state) => state.register);
    const setSession = useUserStore((state) => state.setSession);
    const isLoading = useUserStore((state) => state.isLoading);
    const linuxDoEnabled = useConfigStore((state) => state.publicSettings?.auth?.linuxDo?.enabled === true);
    const allowRegister = useConfigStore((state) => state.publicSettings?.auth?.allowRegister !== false);
    const [mode, setMode] = useState<"login" | "register">("login");
    const redirect = safeRedirect(searchParams.get("redirect"));
    const query = searchParams.toString();
    const currentRoute = useRef({ pathname, query });
    currentRoute.current = { pathname, query };
    const mounted = useRef(true);
    const pendingAuthentication = useRef<number | null>(null);
    const submitAttempt = useRef(0);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            submitAttempt.current++;
            if (pendingAuthentication.current !== null) useUserStore.getState().cancelAuthentication(pendingAuthentication.current);
        };
    }, []);

    useEffect(() => {
        const params = new URLSearchParams(query);
        const token = params.get("token");
        const error = params.get("error");
        if (error) message.error(error);
        if (!token) return;
        let active = true;
        const session = useUserStore.getState();
        const isCurrent = () =>
            active && mounted.current && currentRoute.current.pathname === pathname && currentRoute.current.query === query && useUserStore.getState().sessionRevision === session.sessionRevision && useUserStore.getState().token === session.token;
        void fetchCurrentUser(token)
            .then((user) => {
                if (!isCurrent()) return;
                setSession(token, user);
                message.success("登录成功");
                router.replace(redirect);
                router.refresh();
            })
            .catch((failure) => {
                if (isCurrent()) message.error(failure instanceof Error ? failure.message : "登录失败");
            });
        return () => {
            active = false;
        };
    }, [message, pathname, query, redirect, router, setSession]);

    useEffect(() => {
        if (!allowRegister && mode === "register") setMode("login");
    }, [allowRegister, mode]);

    const submit = async (values: LoginFormValues) => {
        const attempt = ++submitAttempt.current;
        let revision: number | undefined;
        const isCurrent = () => mounted.current && submitAttempt.current === attempt && currentRoute.current.pathname === pathname && currentRoute.current.query === query && (revision === undefined || useUserStore.getState().sessionRevision === revision);
        try {
            if (mode === "register" && !allowRegister) {
                message.error("当前未开放注册");
                return;
            }
            if (mode === "register" && values.password !== values.confirmPassword) {
                message.error("两次输入的密码不一致");
                return;
            }
            const action = mode === "register" ? register : login;
            const operation = action({ username: values.username, password: values.password });
            revision = useUserStore.getState().sessionRevision;
            pendingAuthentication.current = revision;
            await operation;
            if (!isCurrent()) return;
            message.success(mode === "register" ? "注册成功" : "登录成功");
            router.replace(redirect);
            router.refresh();
        } catch (error) {
            if (isCurrent() && !(error instanceof StaleSessionError)) message.error(error instanceof Error ? error.message : "登录失败");
        } finally {
            if (pendingAuthentication.current === revision) pendingAuthentication.current = null;
        }
    };

    return (
        <main className={styles.page}>
            <Link href="/" prefetch={false} className={styles.brand} aria-label="映序 Studio 首页">
                <span className={styles.logo} aria-hidden="true" />
                <span>映序 <span className={styles.brandEnglish}>Studio</span></span>
            </Link>
            <section className={styles.panel} aria-labelledby="login-heading">
                <div className={styles.heading}>
                    <h1 id="login-heading">{mode === "register" ? "创建账号" : "账号登录"}</h1>
                    <p>登录后进入获授权项目，开展画面与资产创作。</p>
                </div>

                <Form<LoginFormValues> layout="vertical" size="large" requiredMark={false} onFinish={submit}>
                    {allowRegister && (
                        <Form.Item>
                            <Segmented block value={mode} onChange={(value) => setMode(value as "login" | "register")} options={[{ label: "登录", value: "login" }, { label: "注册", value: "register" }]} />
                        </Form.Item>
                    )}
                    <Form.Item name="username" label="用户名" rules={[{ required: true, message: "请输入用户名" }]}>
                        <Input prefix={<UserOutlined />} autoComplete="username" />
                    </Form.Item>
                    <Form.Item name="password" label="密码" rules={[{ required: true, message: "请输入密码" }]}>
                        <Input.Password prefix={<LockOutlined />} autoComplete="current-password" />
                    </Form.Item>
                    {mode === "register" ? (
                        <Form.Item name="confirmPassword" label="确认密码" rules={[{ required: true, message: "请再次输入密码" }]}>
                            <Input.Password prefix={<LockOutlined />} autoComplete="new-password" />
                        </Form.Item>
                    ) : null}
                    <Space orientation="vertical" size={12} style={{ width: "100%" }}>
                        <Button block type="primary" htmlType="submit" loading={isLoading}>
                            {mode === "register" ? "注册" : "登录"}
                        </Button>
                        {linuxDoEnabled ? (
                            <Button block href={`/api/auth/linux-do/authorize?redirect=${encodeURIComponent(redirect)}`} icon={<img src="/icons/linuxdo.svg" alt="" width={18} height={18} />}>
                                使用 Linux.do 登录
                            </Button>
                        ) : null}
                    </Space>
                </Form>
            </section>
            <footer className={styles.footer}>Infinite Canvas</footer>
        </main>
    );
}
