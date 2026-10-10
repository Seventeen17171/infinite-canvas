"use client";

import { Button, Pagination, Spin } from "antd";
import { ProjectIcon } from "@/components/ui/project-icon";
import type { AssetFilesSession } from "./use-asset-files";
import styles from "./assets.module.css";

const formatBytes = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function AssetFilesPanel({ session }: { session: AssetFilesSession }) {
    const busy = Boolean(session.busy);
    return <section className={styles.filesPanel} aria-label="资产图片" data-testid="asset-files-panel">
        <header className={styles.filesHeader}><h3>资产图片{session.phase === "ready" && <span>{session.total}</span>}</h3><button type="button" className={styles.refreshModels} disabled={session.phase === "loading" || busy} onClick={() => void session.reload()} aria-label="刷新资产图片"><ProjectIcon name="reload" />刷新</button></header>
        {session.message && <p className={styles.filesMessage} role="status">{session.message}</p>}
        {session.phase === "loading" ? <div className={styles.filesEmpty}><Spin size="small" aria-label="正在加载资产图片" /></div> : session.phase === "blocked" ? <p className={styles.filesEmpty}>当前图片无法访问</p> : session.phase === "error" ? <Button size="small" onClick={() => void session.reload()}>重试图片列表</Button> : !session.items.length ? <p className={styles.filesEmpty}>暂无图片</p> : <>
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
