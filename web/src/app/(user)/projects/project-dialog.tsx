"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Alert, App, Button, Form, Input, Modal, Select, Typography, type InputRef } from "antd";
import { ApiError } from "@/services/api/request";
import { assignProductionProject, createProductionProject, fetchProducers, type ProductionProject } from "@/services/api/production-projects";
import { useUserStore } from "@/stores/use-user-store";

type FormValues = { title: string; summary: string; producerId: string };

export function ProjectDialog({ open, project, onClose, onSaved, onReload }: { open: boolean; project?: ProductionProject; onClose: () => void; onSaved: (value: ProductionProject) => void; onReload?: () => Promise<ProductionProject | undefined> }) {
    const { message } = App.useApp();
    const token = useUserStore((state) => state.token);
    const pathname = usePathname();
    const [form] = Form.useForm<FormValues>();
    const titleRef = useRef<InputRef>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const [pending, setPending] = useState(false);
    const [reloading, setReloading] = useState(false);
    const [error, setError] = useState("");
    const [conflict, setConflict] = useState(false);
    const [revision, setRevision] = useState(0);
    const request = useRef<{ fingerprint: string; id: string } | null>(null);
    const currentRoute = useRef(pathname);
    currentRoute.current = pathname;
    const mounted = useRef(true);
    const activeDialog = useRef(0);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    useEffect(() => {
        activeDialog.current++;
        if (!open) return;
        form.resetFields();
        form.setFieldsValue({ title: "", summary: "", producerId: project?.producerId });
        setRevision(project?.revision || 0);
        setError("");
        setConflict(false);
        setPending(false);
        setReloading(false);
        request.current = null;
    }, [open, project?.id, form]);
    const producers = useQuery({ queryKey: ["production", "producers", token, open], queryFn: () => fetchProducers(token), enabled: Boolean(open && token), retry: false, staleTime: 0 });

    const submit = async () => {
        if (pending || reloading || conflict) return;
        let values: FormValues;
        try {
            values = await form.validateFields();
        } catch {
            return;
        }
        const route = pathname;
        const dialog = activeDialog.current;
        const isCurrent = () => mounted.current && activeDialog.current === dialog && currentRoute.current === route && useUserStore.getState().token === token;
        const payload = { title: values.title?.trim() || "", summary: values.summary?.trim() || "", producerId: values.producerId };
        const fingerprint = JSON.stringify(payload);
        if (!request.current || request.current.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
        setPending(true);
        setError("");
        try {
            const result = project ? await assignProductionProject(token, project.id, values.producerId, revision) : await createProductionProject(token, { ...payload, requestId: request.current.id });
            if (!isCurrent()) return;
            message.success(project ? "制作负责人已改派" : "项目已创建并分派");
            onSaved(result);
        } catch (failure) {
            if (!isCurrent()) return;
            if (failure instanceof ApiError && failure.status === 401) {
                useUserStore.getState().clearSession();
                return;
            }
            setError(failure instanceof Error ? failure.message : "保存失败，请重试");
            setConflict(Boolean(project && failure instanceof ApiError && failure.status === 409));
        } finally {
            if (isCurrent()) setPending(false);
        }
    };
    const reload = async () => {
        if (!onReload || reloading) return;
        const route = pathname;
        const dialog = activeDialog.current;
        const isCurrent = () => mounted.current && activeDialog.current === dialog && currentRoute.current === route && useUserStore.getState().token === token;
        setReloading(true);
        try {
            const result = await onReload();
            if (!isCurrent()) return;
            if (result) {
                setRevision(result.revision);
                setConflict(false);
                setError("");
                message.info("已重新载入项目，请核对负责人后保存");
            } else setError("重新载入失败，请重试");
        } catch (failure) {
            if (isCurrent()) setError(failure instanceof Error ? failure.message : "重新载入失败，请重试");
        } finally {
            if (isCurrent()) setReloading(false);
        }
    };

    return (
        <Modal
            title={project ? "改派制作负责人" : "创建项目"}
            open={open}
            width={560}
            okText={project ? "保存改派" : "创建并分派"}
            cancelText="取消"
            confirmLoading={pending}
            onOk={() => void submit()}
            onCancel={() => {
                if (!pending) onClose();
            }}
            keyboard={!pending}
            maskClosable={false}
            closable={!pending}
            cancelButtonProps={{ disabled: pending }}
            okButtonProps={{ disabled: reloading || conflict || !producers.data?.items.length || producers.isFetching }}
            destroyOnHidden
            modalRender={(content) => (
                <div
                    ref={dialogRef}
                    tabIndex={-1}
                    onKeyDownCapture={(event) => {
                        if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;
                        const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("a[href], button, input, textarea, select, [tabindex]")).filter(
                            (element) => element.tabIndex >= 0 && !element.matches(":disabled, [aria-disabled='true']") && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden",
                        );
                        event.preventDefault();
                        if (!elements.length) {
                            event.currentTarget.focus();
                            return;
                        }
                        const index = elements.indexOf(document.activeElement as HTMLElement);
                        const next = event.shiftKey ? (index <= 0 ? elements.length - 1 : index - 1) : (index + 1) % elements.length;
                        elements[next].focus();
                    }}
                >
                    {content}
                </div>
            )}
            afterOpenChange={(visible) => {
                if (visible && !project) titleRef.current?.focus();
                else if (visible) dialogRef.current?.querySelector<HTMLElement>("[role='combobox']")?.focus();
            }}
        >
            <Typography.Paragraph type="secondary" style={{ marginTop: 12 }}>
                {project ? `当前负责人：${project.producerName}。改派后，原负责人将失去该项目的访问权限。` : "创建时指定制作负责人。负责人登录后，只能访问获分派的项目。"}
            </Typography.Paragraph>
            {error && (
                <Alert
                    type="error"
                    title={error}
                    showIcon
                    style={{ marginBottom: 18 }}
                    action={
                        conflict ? (
                            <Button size="small" loading={reloading} onClick={() => void reload()}>
                                重新载入项目
                            </Button>
                        ) : undefined
                    }
                />
            )}
            {producers.isError && (
                <Alert
                    type="error"
                    title={producers.error.message}
                    style={{ marginBottom: 18 }}
                    action={
                        <Button size="small" onClick={() => void producers.refetch()}>
                            重试
                        </Button>
                    }
                />
            )}
            {!producers.isFetching && producers.data?.items.length === 0 && (
                <Alert
                    type="info"
                    title="暂无可分派的制作人员"
                    description="请由管理员在账号管理中新增状态正常的普通账号，再重新载入人员列表。"
                    style={{ marginBottom: 18 }}
                    action={
                        <Button size="small" onClick={() => void producers.refetch()}>
                            重新载入
                        </Button>
                    }
                />
            )}
            <Form form={form} layout="vertical" requiredMark={false} disabled={pending} onFinish={() => void submit()}>
                {!project && (
                    <>
                        <Form.Item
                            name="title"
                            label="项目名称"
                            rules={[
                                { required: true, whitespace: true, message: "请输入项目名称" },
                                { max: 80, message: "项目名称最多 80 个字符" },
                            ]}
                        >
                            <Input ref={titleRef} maxLength={80} autoComplete="off" placeholder="填写本次制作项目的名称" />
                        </Form.Item>
                        <Form.Item name="summary" label="项目说明" rules={[{ max: 500, message: "项目说明最多 500 个字符" }]}>
                            <Input.TextArea rows={3} maxLength={500} placeholder="简要说明制作内容与要求（选填）" />
                        </Form.Item>
                    </>
                )}
                <Form.Item name="producerId" label="制作负责人" rules={[{ required: true, message: "请选择制作负责人" }]}>
                    <Select
                        showSearch
                        optionFilterProp="label"
                        loading={producers.isFetching}
                        placeholder="选择制作人员"
                        options={(producers.data?.items || []).map((person) => ({ value: person.id, label: person.displayName ? `${person.displayName}（${person.username}）` : person.username }))}
                    />
                </Form.Item>
                <button type="submit" hidden aria-hidden />
            </Form>
        </Modal>
    );
}
