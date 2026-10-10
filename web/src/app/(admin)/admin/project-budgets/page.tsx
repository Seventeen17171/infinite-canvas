"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, App, Button, Descriptions, Form, Input, Modal, Radio, Select, Space, Table, Typography, type TableColumnsType } from "antd";
import dayjs from "dayjs";
import { ProjectIcon } from "@/components/ui/project-icon";
import { BudgetStatusTag } from "@/components/production-budget/project-budget";
import { useBudgetAction } from "@/components/production-budget/use-budget-action";
import { decideProjectBudget, fetchBudgetApplications, type BudgetApplication, type BudgetStatus } from "@/services/api/production-budgets";
import { ApiError } from "@/services/api/request";
import { useUserStore } from "@/stores/use-user-store";

export default function ProjectBudgetsPage() {
    const token = useUserStore((state) => state.token);
    return <BudgetReviewPage key={token} token={token} />;
}

function BudgetReviewPage({ token }: { token: string }) {
    const [status, setStatus] = useState<BudgetStatus | "all">("pending");
    const [page, setPage] = useState(1);
    const [selected, setSelected] = useState<BudgetApplication | null>(null);
    const queryClient = useQueryClient();
    const query = useQuery({ queryKey: ["admin", "project-budgets", token, status, page], queryFn: () => fetchBudgetApplications(token, { page, pageSize: 10, status: status === "all" ? undefined : status }), enabled: Boolean(token), retry: false, staleTime: 0, gcTime: 0 });
    useEffect(() => {
        if (query.error instanceof ApiError && query.error.status === 401 && useUserStore.getState().token === token) useUserStore.getState().clearSession();
    }, [query.error, token]);
    const columns: TableColumnsType<BudgetApplication> = [
        { title: "项目 / 制作组长", key: "project", width: 230, render: (_, item) => <div><Typography.Text strong style={{ display: "block" }}>{item.projectTitle}</Typography.Text><Typography.Text type="secondary">{item.producerName}</Typography.Text></div> },
        { title: "申请人", dataIndex: "applicantName", width: 120 },
        { title: "目标总积分", dataIndex: "targetTotal", width: 140, align: "right", render: (value: number) => value.toLocaleString("zh-CN") },
        { title: "当前批准总额", dataIndex: "approvedTotal", width: 140, align: "right", render: (value: number) => value.toLocaleString("zh-CN") },
        { title: "状态", dataIndex: "status", width: 105, render: (value: BudgetStatus) => <BudgetStatusTag status={value} /> },
        { title: "提交时间", dataIndex: "createdAt", width: 140, render: (value: string) => dayjs(value).format("MM-DD HH:mm") },
        { title: "操作", key: "action", width: 110, render: (_, item) => <Button type="link" aria-label={`${item.status === "pending" ? "审核申请" : "查看记录"} ${item.projectTitle}`} onClick={() => setSelected(item)}>{item.status === "pending" ? "审核" : "查看记录"}</Button> },
    ];
    return <main style={{ padding: 24, minWidth: 900 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 20, marginBottom: 24 }}>
            <div><Typography.Title level={4} style={{ margin: 0 }}>项目积分审批</Typography.Title><Typography.Paragraph type="secondary" style={{ margin: "8px 0 0", maxWidth: 680 }}>审批制作组长提出的项目总预算。批准后仅增加该项目额度，不调整任何个人积分。</Typography.Paragraph></div>
            <Button icon={<ProjectIcon name="reload" />} loading={query.isFetching} onClick={() => void query.refetch()}>刷新申请</Button>
        </div>
        <Space style={{ marginBottom: 18 }}><span>申请状态</span><Select aria-label="筛选申请状态" value={status} style={{ width: 160 }} options={[{ value: "pending", label: "待审批" }, { value: "approved", label: "已批准" }, { value: "rejected", label: "已驳回" }, { value: "all", label: "全部状态" }]} onChange={(value) => { setStatus(value); setPage(1); }} /><Typography.Text type="secondary">{query.data ? `${query.data.total} 条申请` : ""}</Typography.Text></Space>
        {query.isError ? <Alert type="error" title={query.error.message} action={<Button onClick={() => void query.refetch()}>重试</Button>} /> : <Table<BudgetApplication> rowKey="id" columns={columns} dataSource={query.data?.items || []} loading={query.isPending} onRow={(item) => ({ "data-application-id": item.id } as React.HTMLAttributes<HTMLTableRowElement>)} scroll={{ x: 985 }} pagination={{ current: page, pageSize: 10, total: query.data?.total || 0, showSizeChanger: false, onChange: setPage }} locale={{ emptyText: status === "pending" ? "暂无待审批申请" : "暂无申请记录" }} />}
        {selected && <ReviewDialog key={selected.id} token={token} application={selected} onClose={() => setSelected(null)} onSaved={() => { setSelected(null); void queryClient.invalidateQueries({ queryKey: ["admin", "project-budgets", token] }); void queryClient.invalidateQueries({ queryKey: ["production", "budget"] }); }} onRefresh={() => { setSelected(null); void query.refetch(); }} />}
    </main>;
}

function ReviewDialog({ token, application, onClose, onSaved, onRefresh }: { token: string; application: BudgetApplication; onClose: () => void; onSaved: () => void; onRefresh: () => void }) {
    const [form] = Form.useForm<{ decision: "approved" | "rejected"; note: string }>();
    const decision = Form.useWatch("decision", form) || "approved";
    const { message } = App.useApp();
    const readonly = application.status !== "pending";
    const action = useBudgetAction<{ decision: "approved" | "rejected"; note: string; revision: number }, BudgetApplication>((input) => decideProjectBudget(token, application.projectId, application.id, input));
    const submit = async () => {
        if (action.busy || action.conflict || readonly) return;
        try {
            const values = await form.validateFields();
            const result = await action.run({ decision: values.decision, note: values.note?.trim() || "", revision: application.revision });
            if (result) { message.success(result.status === "approved" ? "项目积分已批准" : "申请已驳回"); onSaved(); }
        } catch { /* Form keeps invalid inputs visible. */ }
    };
    return <Modal open title={readonly ? "项目积分申请记录" : "审核项目积分"} width={620} onCancel={onClose} onOk={() => void submit()} okText={action.unknown ? "重试审批" : decision === "approved" ? "确认批准" : "确认驳回"} cancelText="取消" confirmLoading={action.busy} closable={!action.busy && !action.unknown} keyboard={!action.busy && !action.unknown} maskClosable={false} cancelButtonProps={{ disabled: action.busy || action.unknown }} okButtonProps={{ disabled: action.conflict, danger: decision === "rejected" }} footer={readonly ? <Button onClick={onClose}>关闭</Button> : undefined}>
        <Descriptions column={2} size="small" style={{ margin: "20px 0" }} items={[
            { key: "project", label: "项目", children: application.projectTitle, span: 2 },
            { key: "leader", label: "制作组长", children: application.producerName }, { key: "applicant", label: "申请人", children: application.applicantName },
            { key: "target", label: "目标总积分", children: <strong>{application.targetTotal.toLocaleString("zh-CN")} 积分</strong> }, { key: "current", label: "当前批准总额", children: `${application.approvedTotal.toLocaleString("zh-CN")} 积分` },
            { key: "reason", label: "申请用途", children: <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{application.reason}</span>, span: 2 },
        ]} />
        {readonly ? <><BudgetStatusTag status={application.status} /><Typography.Paragraph style={{ marginTop: 14, whiteSpace: "pre-wrap" }}>审批人：{application.decidedByName || "—"}<br />审批说明：{application.decisionNote || "未填写"}</Typography.Paragraph></> : <>
            {action.error && <Alert style={{ marginBottom: 16 }} type={action.unknown ? "warning" : "error"} title={action.error} description={action.unknown ? "尚未确认审批结果。决定已锁定，请重试原决定，不会重复拨付。" : undefined} action={action.conflict ? <Button onClick={onRefresh}>刷新申请</Button> : undefined} />}
            <Form form={form} layout="vertical" initialValues={{ decision: "approved", note: "" }} disabled={action.busy || action.unknown} requiredMark={false}>
                <Form.Item name="decision" label="审批决定"><Radio.Group options={[{ value: "approved", label: "批准" }, { value: "rejected", label: "驳回" }]} /></Form.Item>
                <Typography.Paragraph type="secondary">{decision === "approved" ? `批准后项目总额度为 ${application.targetTotal.toLocaleString("zh-CN")} 积分，本次追加 ${(application.targetTotal - application.approvedTotal).toLocaleString("zh-CN")} 积分。` : "驳回不会改变项目已批准额度，组长可修改后重新申请。"}</Typography.Paragraph>
                <Form.Item name="note" label={decision === "rejected" ? "审批说明（必填）" : "审批说明（选填）"} rules={[{ required: decision === "rejected", whitespace: true, message: "请填写驳回原因" }, { max: 500, message: "审批说明最多 500 字" }]}><Input.TextArea aria-label="审批说明" rows={3} maxLength={500} showCount placeholder={decision === "approved" ? "可填写预算使用要求" : "说明需要调整的预算或用途"} /></Form.Item>
            </Form>
        </>}
    </Modal>;
}
