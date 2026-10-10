"use client";

import { useRef } from "react";
import { Button, Pagination, Spin } from "antd";
import { ProjectIcon } from "@/components/ui/project-icon";
import type { AssetFilesSession } from "./use-asset-files";
import type { AssetUploadSession } from "./use-asset-upload";
import styles from "./assets.module.css";

const formatBytes = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function AssetFilesPanel({ session, upload }: { session: AssetFilesSession; upload: AssetUploadSession }) {
    const input = useRef<HTMLInputElement>(null);
    const busy = Boolean(session.busy);
    const uploading = upload.phase === "uploading" || upload.phase === "checking";
    const selected = upload.selected || upload.pending;
    return <section className={styles.filesPanel} aria-label="资产图片" data-testid="asset-files-panel">
        <header className={styles.filesHeader}><h3>资产图片{session.phase === "ready" && <span>{session.total}</span>}</h3><div className={styles.fileHeaderActions}>
            <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" hidden aria-label="选择资产图片文件" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) upload.select(file); }} />
            <Button size="small" icon={<ProjectIcon name="plus" />} disabled={uploading || upload.phase === "blocked" || session.phase !== "ready"} onClick={() => input.current?.click()}>{upload.pending ? "重选原图片" : "选择图片"}</Button>
            <button type="button" className={styles.refreshModels} disabled={session.phase === "loading" || busy} onClick={() => void session.reload()} aria-label="刷新资产图片"><ProjectIcon name="reload" />刷新</button>
        </div></header>
        <p className={styles.uploadHint}>PNG、JPEG、WebP · 单张不超过 20 MB</p>
        {selected && <div className={styles.uploadSelection} aria-label="待上传图片">
            <div className={styles.fileIdentity}><strong title={selected.name}>{selected.name}</strong><span>{formatBytes(selected.bytes)} · {upload.phase === "uploading" ? "正在上传" : upload.phase === "checking" ? "核对中" : upload.pending ? upload.selected ? "原图片已选择" : "等待确认" : "尚未上传"}</span></div>
            <div className={styles.uploadActions}>
                <Button size="small" type="primary" loading={uploading} disabled={uploading || upload.phase === "blocked"} onClick={() => void (upload.pending ? upload.retry() : upload.upload())}>{upload.phase === "uploading" ? "上传中" : upload.phase === "checking" ? "核对中" : upload.pending ? "重试确认" : "上传图片"}</Button>
                <button type="button" disabled={uploading} onClick={upload.discard}>{upload.pending ? "放弃本次确认" : "移除选择"}</button>
            </div>
        </div>}
        {upload.message && <p className={styles.filesMessage} role="status">{upload.message}</p>}
        {session.message && <p className={styles.filesMessage} role="status">{session.message}</p>}
        {session.phase === "loading" ? <div className={styles.filesEmpty}><Spin size="small" aria-label="正在加载资产图片" /></div> : session.phase === "blocked" ? <p className={styles.filesEmpty}>当前图片无法访问</p> : session.phase === "error" ? <Button size="small" onClick={() => void session.reload()}>重试图片列表</Button> : !session.items.length ? <p className={styles.filesEmpty}>暂无图片，选择一张图片补充资产</p> : <>
            <ul className={styles.fileList}>{session.items.map((file) => <li key={file.id} data-file-id={file.id}>
                <ProjectIcon name="assets" />
                <div className={styles.fileIdentity}><strong title={file.name}>{file.name}</strong><span>{file.mimeType.split("/")[1].toUpperCase()} · {formatBytes(file.bytes)}</span></div>
                <div className={styles.fileActions}><Button size="small" type="text" disabled={busy} loading={session.busy === `preview:${file.id}`} onClick={() => void session.previewFile(file.id)} aria-label={`预览 ${file.name}`}>预览</Button><Button size="small" type="text" disabled={busy} loading={session.busy === `download:${file.id}`} icon={<ProjectIcon name="download" />} onClick={() => void session.download(file.id)} aria-label={`下载 ${file.name}`} /></div>
            </li>)}</ul>
            {session.total > 20 && <Pagination simple current={session.page} pageSize={20} total={session.total} showSizeChanger={false} disabled={busy} onChange={session.changePage} />}
        </>}
        {session.preview && <figure className={styles.filePreview}>
            {/* Private bytes are fetched with authorization before creating this short-lived URL. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={session.preview.url} alt={session.preview.file.name} onError={session.imageFailed} />
            <figcaption><span title={session.preview.file.name}>{session.preview.file.name}</span><button type="button" onClick={session.close}>关闭预览</button></figcaption>
        </figure>}
    </section>;
}
