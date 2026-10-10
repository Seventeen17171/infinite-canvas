"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button, Input, Modal, Pagination, Spin } from "antd";
import { ProjectIcon } from "@/components/ui/project-icon";
import { canvasThemes } from "@/lib/canvas-theme";
import { fetchProductionAssets, type AssetCategory, type ProductionAsset } from "@/services/api/production-assets";
import { fetchAssetFiles, fetchProductionFile, fetchProductionFileBlob, type ProductionFile } from "@/services/api/production-files";
import { ApiError } from "@/services/api/request";
import { useThemeStore } from "@/stores/use-theme-store";
import { useUserStore } from "@/stores/use-user-store";
import { checkImageAccess, imageReadError } from "./use-canvas-images";
import { decodeReferenceImage, type ImageReference } from "./image-reference";
import styles from "./project-image-picker.module.css";

type Selection = ImageReference & { title: string; width: number; height: number };
type View = { key: string; token: string; assets: ProductionAsset[]; assetTotal: number; files: ProductionFile[]; fileTotal: number; loading: boolean; message: string; preview?: { url: string; selection: Selection; file: ProductionFile } };
type Props = { projectId: string; documentId: string; onCancel: () => void; onInsert: (selection: Selection) => void; onDenied: (error: unknown) => void };

export function ProjectImagePicker({ projectId, documentId, onCancel, onInsert, onDenied }: Props) {
    const token = useUserStore((state) => state.token);
    const actor = useUserStore((state) => state.user?.id || "");
    const revision = useUserStore((state) => state.sessionRevision);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [category, setCategory] = useState<AssetCategory>("character");
    const [search, setSearch] = useState("");
    const [query, setQuery] = useState("");
    const [assetPage, setAssetPage] = useState(1);
    const [assetId, setAssetId] = useState("");
    const [filePage, setFilePage] = useState(1);
    const [fileId, setFileId] = useState("");
    const [epoch, setEpoch] = useState(0);
    const [visible, setVisible] = useState(true);
    const key = `${revision}:${actor}:${projectId}:${documentId}:${category}:${query}:${assetPage}:${assetId}:${filePage}:${fileId}:${epoch}:${visible}`;
    const initial: View = { key, token, assets: [], assetTotal: 0, files: [], fileTotal: 0, loading: true, message: "" };
    const [view, setView] = useState<View>(initial);
    const identity = useRef({ key, token });
    identity.current = { key, token };
    const callbacks = useRef({ onCancel, onInsert, onDenied });
    callbacks.current = { onCancel, onInsert, onDenied };
    const release = useRef<() => void>(() => {});
    const previewReadyKey = useRef("");
    const confirmed = useRef(false);
    const cancel = () => { confirmed.current = true; release.current(); callbacks.current.onCancel(); };
    const current = view.key === key && view.token === token && visible ? view : initial;

    useEffect(() => {
        const refresh = () => { release.current(); setEpoch((value) => value + 1); setVisible(document.visibilityState === "visible"); };
        const visibility = () => { if (document.visibilityState === "hidden") { release.current(); setVisible(false); } else refresh(); };
        window.addEventListener("focus", refresh);
        document.addEventListener("visibilitychange", visibility);
        return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", visibility); };
    }, []);
    useEffect(() => {
        let alive = true;
        let url = "";
        const controller = new AbortController();
        const active = () => alive && !confirmed.current && !controller.signal.aborted && identity.current.key === key && identity.current.token === token && useUserStore.getState().token === token && useUserStore.getState().sessionRevision === revision && document.visibilityState === "visible";
        const cleanup = () => { alive = false; previewReadyKey.current = ""; controller.abort(); if (url) URL.revokeObjectURL(url); url = ""; setView((previous) => previous.key === key ? { ...previous, preview: undefined } : previous); };
        release.current = cleanup;
        setView(initial);
        if (!token || !actor || !visible) return cleanup;
        async function load() {
            const next = { ...initial };
            try {
                const list = await fetchProductionAssets(token, projectId, { category, q: query, page: assetPage, pageSize: 20 }, controller.signal);
                if (!active()) return;
                next.assets = list.items; next.assetTotal = list.total;
                const asset = list.items.find((item) => item.id === assetId);
                if (asset) {
                    const files = await fetchAssetFiles(token, projectId, assetId, filePage, controller.signal);
                    if (!active()) return;
                    next.files = files.items; next.fileTotal = files.total;
                    setView({ ...next });
                    const selected = files.items.find((file) => file.id === fileId);
                    if (selected) {
                        const file = await fetchProductionFile(token, projectId, assetId, fileId, controller.signal);
                        if (!active()) return;
                        const blob = await fetchProductionFileBlob(token, projectId, assetId, file, false, controller.signal);
                        if (!active()) return;
                        url = URL.createObjectURL(blob);
                        const dimensions = await decodeReferenceImage(url, controller.signal);
                        if (!active()) return;
                        next.preview = { url, file, selection: { assetId, fileId, title: asset.name, ...dimensions } };
                        previewReadyKey.current = key;
                    }
                }
                if (active()) setView({ ...next, loading: false });
            } catch (error) {
                if (!active()) return;
                if (url) URL.revokeObjectURL(url); url = "";
                try { await checkImageAccess(error, token, projectId, documentId); }
                catch (denial) {
                    if (active()) {
                        cleanup();
                        if (denial instanceof ApiError && [401, 403, 404].includes(denial.status)) callbacks.current.onDenied(denial);
                        else setView({ ...next, preview: undefined, loading: false, message: "暂时无法确认图片访问权限，请重新加载" });
                    }
                    return;
                }
                if (active()) setView({ ...next, preview: undefined, loading: false, message: imageReadError(error) });
            }
        }
        void load();
        return cleanup;
    }, [key, token]);

    const selectAsset = (id: string) => { release.current(); setAssetId(id); setFilePage(1); setFileId(""); setEpoch((value) => value + 1); };
    const changeCategory = (value: AssetCategory) => { release.current(); setCategory(value); setAssetId(""); setFileId(""); setAssetPage(1); setFilePage(1); setEpoch((current) => current + 1); };
    const style = { "--picker-panel": theme.node.panel, "--picker-fill": theme.node.fill, "--picker-text": theme.node.text, "--picker-muted": theme.node.muted, "--picker-border": theme.node.stroke, "--picker-active": theme.node.activeStroke } as CSSProperties;
    return (
        <Modal open title="引用项目资产" width={960} centered onCancel={cancel} destroyOnHidden styles={{ body: { paddingTop: 12 }, container: { background: theme.node.panel, color: theme.node.text }, header: { background: theme.node.panel } }}
            footer={<div className={styles.footer}><span>引用固定图片，资产中新增图片不会替换它。</span><Button onClick={cancel}>取消</Button><Button type="primary" disabled={!current.preview || current.loading} onClick={() => {
                if (confirmed.current || !current.preview || previewReadyKey.current !== key || identity.current.key !== key || useUserStore.getState().token !== token || useUserStore.getState().sessionRevision !== revision || document.visibilityState !== "visible") return;
                confirmed.current = true;
                const selection = current.preview.selection;
                release.current();
                callbacks.current.onInsert(selection);
            }}>引用到画布</Button></div>}>
            <div className={styles.picker} style={style} data-testid="project-image-picker">
                <section className={styles.column} aria-label="项目人物和场景">
                    <div className={styles.categories}>{(["character", "scene"] as const).map((value) => <button key={value} type="button" aria-pressed={category === value} onClick={() => changeCategory(value)}><ProjectIcon name={value === "character" ? "user" : "scene"} />{value === "character" ? "人物" : "场景"}</button>)}</div>
                    <form className={styles.search} onSubmit={(event) => { event.preventDefault(); release.current(); setQuery(search.trim()); setAssetPage(1); setAssetId(""); setFileId(""); setEpoch((value) => value + 1); }}><Input aria-label="搜索项目资产" placeholder="搜索资产名称" value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} /><Button htmlType="submit" aria-label="搜索资产" icon={<ProjectIcon name="search" />} /></form>
                    <div className={styles.list}>{current.assets.map((asset) => <button key={asset.id} type="button" aria-label={`选择资产 ${asset.name}`} aria-pressed={asset.id === assetId} onClick={() => selectAsset(asset.id)}><strong>{asset.name}</strong><span>{asset.description || "暂无描述"}</span></button>)}{!current.loading && !current.assets.length && <p className={styles.empty}>此分类暂无资产。可先到资产创意工作台创建并上传图片。</p>}</div>
                    {current.assetTotal > 20 && <Pagination size="small" simple current={assetPage} pageSize={20} total={current.assetTotal} onChange={(page) => { release.current(); setAssetPage(page); setAssetId(""); setFileId(""); }} />}
                </section>
                <section className={styles.column} aria-label="资产图片列表"><h3>已上传图片</h3><div className={styles.list}>{current.files.map((file) => <button key={file.id} type="button" aria-label={`选择图片 ${file.name}`} aria-pressed={file.id === fileId} onClick={() => { release.current(); setFileId(file.id); setEpoch((value) => value + 1); }}><ProjectIcon name="assets" /><strong>{file.name}</strong><span>{(file.bytes / 1024 / 1024).toFixed(2)} MB</span></button>)}{!current.loading && !current.files.length && <p className={styles.empty}>{assetId ? "此资产还没有图片，请先在资产创意工作台上传。" : "选择左侧人物或场景，查看已上传图片。"}</p>}</div>{current.fileTotal > 20 && <Pagination size="small" simple current={filePage} pageSize={20} total={current.fileTotal} onChange={(page) => { release.current(); setFilePage(page); setFileId(""); }} />}</section>
                <section className={styles.preview} aria-label="引用图片预览"><h3>图片预览</h3><div className={styles.imageArea}>{current.preview ? <img src={current.preview.url} alt={`引用预览 ${current.preview.file.name}`} onError={() => { if (identity.current.key !== key || identity.current.token !== token) return; release.current(); setView((previous) => ({ ...previous, preview: undefined, loading: false, message: "图片无法显示，请重新选择" })); }} /> : current.loading ? <Spin aria-label="正在读取项目图片" /> : <p>选择一张图片，预览后引用到画布。</p>}</div>{current.preview && <div className={styles.caption}><strong>{current.preview.selection.title}</strong><span>{current.preview.file.name}</span><span>{current.preview.selection.width} × {current.preview.selection.height}</span></div>}</section>
            </div>
            {current.message && <div className={styles.error} role="alert">{current.message}<Button size="small" onClick={() => setEpoch((value) => value + 1)}>重新加载</Button></div>}
        </Modal>
    );
}
