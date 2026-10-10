"use client";

import { Alert, Button, Input, Spin } from "antd";
import { ProjectIcon } from "@/components/ui/project-icon";
import { creativeAspectRatios, creativeResolutions, type CreativeFields } from "@/services/api/production-asset-creative";
import type { AssetCreativeSession } from "./use-asset-creative-session";
import styles from "./assets.module.css";

const modelKey = (channelId: string, model: string) => channelId && model ? JSON.stringify([channelId, model]) : "";
const formatTime = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "";

export function AssetCreativePanel({ session, selected, isNew, blocked, projectTitle }: { session: AssetCreativeSession; selected: boolean; isNew: boolean; blocked: boolean; projectTitle: string }) {
    const locked = blocked || ["loading", "saving", "blocked"].includes(session.phase) || session.retryPending;
    const status = session.phase === "saving" ? "正在保存" : session.retryPending ? "等待确认" : session.phase === "conflict" ? "版本冲突" : session.dirty ? "未保存" : session.revision ? "已保存" : "尚未保存";
    const selectedModelKey = modelKey(session.modelChannelId, session.modelName);
    const unavailable = Boolean(selectedModelKey) && !session.models.some((model) => modelKey(model.channelId, model.model) === selectedModelKey);
    const retainedModel = selectedModelKey === modelKey(session.creative?.modelChannelId || "", session.creative?.modelName || "");
    const invalidNewModel = unavailable && !retainedModel;

    return <aside className={styles.creativePanel} aria-label="资产创意筹备" data-testid="asset-creative-panel" data-creative-revision={session.creative?.revision ?? 0}>
        <header className={styles.creativeHeader}>
            <div><h2><ProjectIcon name="assets" /> 创意筹备</h2><p title={projectTitle}>{projectTitle}</p></div>
            {selected && !isNew && session.authorized && !blocked && <span className={`${styles.status} ${session.dirty || session.retryPending ? styles.unsaved : ""}`} aria-live="polite"><span aria-hidden />{status}</span>}
        </header>
        {blocked ? <div className={styles.creativeEmpty}><p>确认项目访问权限后，才能打开资产创意。</p></div> : !selected || isNew ? <div className={styles.creativeEmpty}><ProjectIcon name="text" style={{ fontSize: 24 }} /><h3>{isNew ? "先保存这份资产" : "为设定准备画面"}</h3><p>{isNew ? "创建人物或场景后，即可独立保存它的提示词和图片参数。" : "从左侧选择一份人物或场景，整理它的提示词与图片参数。"}</p><span>筹备不消耗项目积分</span></div> : !session.authorized ? <div className={styles.creativeEmpty}>{session.phase === "loading" ? <Spin aria-label="正在加载资产创意" /> : <><h3>创意暂时无法打开</h3><p>{session.message}</p><Button size="small" onClick={() => void session.reload()}>重试打开创意</Button></>}</div> : <form className={styles.creativeForm} onSubmit={(event) => { event.preventDefault(); void session.save(); }}>
            <div className={styles.creativeFields}>
                {session.storageError && <Alert type="warning" title="创意草稿未能写入浏览器" description="请先保存，再关闭或刷新页面。" showIcon />}
                {session.message && <Alert type={session.phase === "error" || session.phase === "conflict" ? "warning" : "info"} title={session.message} showIcon />}
                {session.phase === "conflict" && <Button size="small" onClick={() => void session.reload()} icon={<ProjectIcon name="reload" />}>保留创意草稿，载入最新版本</Button>}
                <div className={styles.field}>
                    <div className={styles.fieldHeading}><label htmlFor="asset-creative-prompt">图片提示词</label><span>{Array.from(session.prompt).length} / 8000</span></div>
                    <Input.TextArea id="asset-creative-prompt" className={styles.creativePrompt} value={session.prompt} disabled={locked} placeholder="描写主体、外观、构图、光线和画面风格。" onChange={(event) => session.edit({ prompt: Array.from(event.target.value).slice(0, 8000).join("") })} />
                </div>
                <div className={styles.field}>
                    <div className={styles.fieldHeading}><label htmlFor="asset-creative-model">后台图片模型</label><button className={styles.refreshModels} type="button" disabled={locked || session.refreshing} onClick={() => void session.refresh()} aria-label="刷新可选模型"><ProjectIcon name="reload" />{session.refreshing ? "刷新中" : "刷新"}</button></div>
                    <select id="asset-creative-model" className={styles.creativeSelect} value={selectedModelKey} disabled={locked} onChange={(event) => { const model = session.models.find((item) => modelKey(item.channelId, item.model) === event.target.value); session.edit({ modelChannelId: model?.channelId || "", modelName: model?.model || "" }); }}>
                        <option value="">暂不选择模型</option>
                        {unavailable && <option value={selectedModelKey} disabled>{session.modelName}（已不可用）</option>}
                        {session.models.map((model) => <option key={modelKey(model.channelId, model.model)} value={modelKey(model.channelId, model.model)}>{model.model} · {model.channelName}</option>)}
                    </select>
                    {unavailable ? <p className={styles.modelWarning}>{retainedModel ? "原模型已不可用。可继续保存筹备内容，或选择其他模型。" : "这份新选择已不可用，请暂不选择模型或改选其他模型，再保存。"}</p> : !session.models.length ? <p className={styles.creativeHint}>后台尚未开放图片模型。你仍可保存提示词和参数。</p> : <p className={styles.creativeHint}>可选模型由管理员统一配置。</p>}
                    {session.modelMessage && <p className={styles.modelWarning} role="status">{session.modelMessage}</p>}
                </div>
                <div className={styles.creativeParameters}>
                    <div className={styles.field}><label htmlFor="asset-creative-ratio">画面比例</label><select id="asset-creative-ratio" className={styles.creativeSelect} value={session.aspectRatio} disabled={locked} onChange={(event) => session.edit({ aspectRatio: event.target.value as CreativeFields["aspectRatio"] })}>{creativeAspectRatios.map((value) => <option key={value} value={value}>{value === "auto" ? "自动" : value}</option>)}</select></div>
                    <div className={styles.field}><label htmlFor="asset-creative-resolution">目标清晰度</label><select id="asset-creative-resolution" className={styles.creativeSelect} value={session.resolution} disabled={locked} onChange={(event) => session.edit({ resolution: event.target.value as CreativeFields["resolution"] })}>{creativeResolutions.map((value) => <option key={value} value={value}>{value === "auto" ? "自动" : value}</option>)}</select></div>
                    <div className={styles.field}><label htmlFor="asset-creative-count">计划张数</label><select id="asset-creative-count" className={styles.creativeSelect} value={session.imageCount} disabled={locked} onChange={(event) => session.edit({ imageCount: Number(event.target.value) })}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value} 张</option>)}</select></div>
                </div>
                <p className={styles.creativeHint}>这些参数记录创作意向，实际生成时将按模型能力确认。</p>
                {session.backup && <details className={styles.backup}><summary>查看保留的创意草稿</summary><p>{session.backup.prompt || "未填写提示词"}</p><p>模型：{session.backup.modelName || "暂未选择"}<br />比例 {session.backup.aspectRatio} / 清晰度 {session.backup.resolution} / {session.backup.imageCount} 张</p><Button size="small" disabled={locked || session.phase !== "ready"} onClick={session.restoreBackup}>用这份创意草稿继续编辑</Button></details>}
            </div>
            <footer className={styles.creativeSaveBar}>
                <div><span>{session.creative?.revision ? `第 ${session.creative.revision} 版 · ${formatTime(session.creative.updatedAt)}` : "筹备不消耗项目积分"}</span>{session.dirty && !session.storageError && <small>本页创意草稿已保留</small>}</div>
                <Button type="primary" htmlType="submit" loading={session.phase === "saving"} disabled={session.phase === "loading" || session.phase === "conflict" || (invalidNewModel && !session.retryPending) || (!session.dirty && !session.retryPending)}>{session.retryPending && session.phase !== "saving" ? "重试确认创意" : "保存创意"}</Button>
            </footer>
        </form>}
    </aside>;
}
