"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Collapse, Form, Input, InputNumber, Modal, Spin, Tag } from "antd";
import dayjs from "dayjs";
import { ProjectIcon } from "@/components/ui/project-icon";
import { applyProjectBudget, fetchProjectBudget, type ProjectBudget, type BudgetApplication } from "@/services/api/production-budgets";
import { ApiError } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";
import { useBudgetAction } from "./use-budget-action";
import styles from "./project-budget.module.css";

export const budgetStatusLabel = { pending: "待审批", approved: "已批准", rejected: "已驳回" };
export function BudgetStatusTag({ status }: { status: BudgetApplication["status"] }) {
    return <Tag color={status === "approved" ? "success" : status === "rejected" ? "error" : "processing"}>{budgetStatusLabel[status]}</Tag>;
}

export function ProjectBudgetSection({ projectId }: { projectId: string }) {
    const token = useUserStore((state) => state.token);
    return <ProjectBudgetContent key={`${token}:${projectId}`} projectId={projectId} token={token} />;
}

function ProjectBudgetContent({ projectId, token }: { projectId: string; token: string }) {
    const [applying, setApplying] = useState(false);
    const queryClient = useQueryClient();
    const queryKey = ["production", "budget", token, projectId];
    const query = useQuery({ queryKey, queryFn: () => fetchProjectBudget(token, projectId), enabled: Boolean(token), retry: false, gcTime: 0, staleTime: 0, refetchOnMount: "always" as const });
    useEffect(() => {
        if (query.error instanceof ApiError && query.error.status === 401 && useUserStore.getState().token === token) useUserStore.getState().clearSession();
    }, [query.error, token]);
    const budget = query.data;
    if (query.isPending) return <section className={styles.section} aria-label="项目积分预算"><Spin aria-label="正在加载项目预算" /></section>;
    const denied = query.error instanceof ApiError && [401, 403, 404].includes(query.error.status);
    if (!budget || denied) return <section className={styles.section} aria-label="项目积分预算"><Alert type="error" title={query.error?.message || "项目预算无法加载"} action={<Button onClick={() => void query.refetch()}>重试预算</Button>} /></section>;
    const pending = budget.applications.find((item) => item.status === "pending");
    return (
        <section className={styles.section} aria-label="项目积分预算">
            {query.isError && <Alert style={{ marginBottom: 18 }} type="warning" title="暂时无法刷新预算" description="保留上次读取的预算和当前申请输入。连接恢复后请刷新。" action={<Button onClick={() => void query.refetch()}>重试预算</Button>} />}
            <div className={styles.heading}>
                <div><h2>项目积分</h2><p>模型制作使用本项目获批额度，由制作组长申请、管理员审批。</p></div>
                <div className={styles.controls}>
                    <Button type="text" aria-label="刷新项目预算" icon={<ProjectIcon name="reload" />} loading={query.isFetching} onClick={() => void query.refetch()} />
                    {budget.canApply && !pending && <Button icon={<ProjectIcon name="plus" />} onClick={() => setApplying(true)}>{budget.approvedTotal ? "申请追加积分" : "申请项目积分"}</Button>}
                </div>
            </div>
            <div className={styles.summary}>
                <div><span className={styles.label}>已批准总积分</span><strong data-testid="approved-budget-total">{budget.approvedTotal.toLocaleString("zh-CN")}</strong><span className={styles.unit}>积分</span></div>
                <div className={styles.state}>
                    {pending ? <><BudgetStatusTag status="pending" /><span>申请目标总额 {pending.targetTotal.toLocaleString("zh-CN")} 积分</span></> : budget.approvedTotal ? <><Tag color="success">已有项目额度</Tag><span>需要更多额度时，由组长申请新的目标总额。</span></> : <><Tag>尚未获批</Tag><span>{budget.canApply ? "填写制作所需总积分，提交管理员审批。" : "由当前制作组长提交项目积分申请。"}</span></>}
                </div>
            </div>
            <p className={styles.note}>审批前可编辑画布、整理提示词。项目 AI 生成尚未开放，获批积分将在后续生成流程中使用。</p>
            {budget.applications.length > 0 && <Collapse ghost className={styles.history} items={[{ key: "history", label: `申请记录（${budget.totalApplications}）`, children: <div>{budget.applications.map((item) => <article key={item.id} className={styles.record} data-application-id={item.id}>
                <div className={styles.recordHead}><BudgetStatusTag status={item.status} /><b>目标总额 {item.targetTotal.toLocaleString("zh-CN")} 积分</b><time>{dayjs(item.createdAt).format("MM-DD HH:mm")}</time></div>
                <p>{item.reason}</p><div className={styles.meta}>申请人：{item.applicantName}{item.decidedByName && `　审批人：${item.decidedByName}`}</div>
                {item.decisionNote && <p className={styles.decision}>审批说明：{item.decisionNote}</p>}
            </article>)}{budget.totalApplications > budget.applications.length && <p className={styles.note}>此处展示最近 {budget.applications.length} 条，完整记录可由管理员在项目积分审批页查询。</p>}</div> }]} />}
            {applying && <BudgetApplicationDialog token={token} budget={budget} onClose={() => setApplying(false)} onSaved={(value) => { queryClient.setQueryData(queryKey, value); setApplying(false); void query.refetch(); }} onReload={() => void query.refetch()} />}
        </section>
    );
}

function BudgetApplicationDialog({ token, budget, onClose, onSaved, onReload }: { token: string; budget: ProjectBudget; onClose: () => void; onSaved: (value: ProjectBudget) => void; onReload: () => void }) {
    const [form] = Form.useForm<{ targetTotal: number; reason: string }>();
    const { message } = App.useApp();
    const action = useBudgetAction<{ targetTotal: number; reason: string }, ProjectBudget>((input) => applyProjectBudget(token, budget.projectId, input));
    const submit = async () => {
        if (action.busy || action.conflict) return;
        try {
            const values = await form.validateFields();
            const result = await action.run({ targetTotal: values.targetTotal, reason: values.reason.trim() });
            if (result) { message.success("项目积分申请已提交"); onSaved(result); }
        } catch { /* Keep validation next to the field. */ }
    };
    return <Modal open title="申请项目积分" width={540} onCancel={onClose} onOk={() => void submit()} okText={action.unknown ? "重试提交" : "提交申请"} cancelText="取消" confirmLoading={action.busy} closable={!action.busy && !action.unknown} keyboard={!action.busy && !action.unknown} maskClosable={false} cancelButtonProps={{ disabled: action.busy || action.unknown }} okButtonProps={{ disabled: action.conflict }}>
        <p className={styles.dialogIntro}>当前已批准 {budget.approvedTotal.toLocaleString("zh-CN")} 积分。填写整个项目需要的目标总额；追加申请只拨付与已批准总额的差额。</p>
        {action.error && <Alert style={{ marginBottom: 16 }} type={action.unknown ? "warning" : "error"} title={action.error} description={action.unknown ? "尚未确认提交结果，输入已保留。请重试同一申请，避免重复提交。" : undefined} action={action.conflict ? <Button onClick={() => { onReload(); onClose(); }}>刷新预算</Button> : undefined} />}
        <Form form={form} layout="vertical" requiredMark={false} disabled={action.busy || action.unknown} onFinish={() => void submit()}>
            <Form.Item name="targetTotal" label="项目所需总积分" rules={[{ required: true, message: "请输入项目所需总积分" }, { validator: (_, value) => Number.isSafeInteger(value) && value > budget.approvedTotal && value <= 1_000_000_000 ? Promise.resolve() : Promise.reject(new Error(`请输入大于 ${budget.approvedTotal.toLocaleString("zh-CN")} 且不超过 1,000,000,000 的整数`)) }]}><InputNumber aria-label="项目所需总积分" min={1} max={1_000_000_000} style={{ width: "100%" }} autoFocus /></Form.Item>
            <Form.Item name="reason" label="申请用途" rules={[{ required: true, whitespace: true, message: "请说明制作内容与积分用途" }, { max: 500, message: "申请用途最多 500 字" }]}><Input.TextArea aria-label="申请用途" rows={4} maxLength={500} showCount placeholder="说明计划制作的内容、数量与预算依据" /></Form.Item>
        </Form>
    </Modal>;
}
