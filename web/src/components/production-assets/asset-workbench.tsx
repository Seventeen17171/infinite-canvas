"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Alert, Button, Input, Pagination, Spin } from "antd";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ProjectIcon } from "@/components/ui/project-icon";
import { ApiError } from "@/services/api/request";
import { fetchProductionAssets, type AssetCategory, type ProductionAsset } from "@/services/api/production-assets";
import type { ProductionProject } from "@/services/api/production-projects";
import { useUserStore } from "@/stores/use-user-store";
import { useAssetSession } from "./use-asset-session";
import { clearAssetCreativeDrafts, useAssetCreativeSession } from "./use-asset-creative-session";
import { AssetCreativePanel } from "./asset-creative-panel";
import styles from "./assets.module.css";

const categories: { value: AssetCategory; label: string; icon: "user" | "scene" }[] = [{ value: "character", label: "人物", icon: "user" }, { value: "scene", label: "场景", icon: "scene" }];
const formatTime = (value?: string) => value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "尚未保存";

export function AssetWorkbench({ project }: { project: ProductionProject }) {
    const actorId = useUserStore((state) => state.user?.id || "");
    const revision = useUserStore((state) => state.sessionRevision);
    return <AssetWorkbenchSession key={`${actorId}:${revision}:${project.id}`} project={project} />;
}

function AssetWorkbenchSession({ project }: { project: ProductionProject }) {
    const token = useUserStore((state) => state.token);
    const actorId = useUserStore((state) => state.user?.id || "");
    const sessionRevision = useUserStore((state) => state.sessionRevision);
    const queryClient = useQueryClient();
    const router = useRouter();
    const pathname = usePathname();
    const search = useSearchParams();
    const category: AssetCategory = search.get("category") === "scene" ? "scene" : "character";
    const label = category === "character" ? "人物" : "场景";
    const selection = search.get("asset") || "";
    const keyword = Array.from(search.get("q") || "").slice(0, 80).join("");
    const parsedPage = Number(search.get("page") || 1);
    const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    const [searchText, setSearchText] = useState(keyword);
    const [deniedMessage, setDeniedMessage] = useState("");
    useEffect(() => setSearchText(keyword), [keyword]);
    const queryPrefix = ["production", "assets", token, sessionRevision, project.id];
    const queryKey = [...queryPrefix, category, keyword, page];
    const query = useQuery({
        queryKey,
        queryFn: async ({ signal }) => {
            try { return await fetchProductionAssets(token, project.id, { category, q: keyword, page, pageSize: 20 }); }
            catch (error) {
                if (!signal.aborted && error instanceof ApiError && [401, 403, 404].includes(error.status)) queryClient.setQueriesData({ queryKey: queryPrefix }, null);
                throw error;
            }
        },
        enabled: Boolean(token), retry: false, staleTime: 0, gcTime: 0,
    });
    const blocked = Boolean(deniedMessage) || (query.error instanceof ApiError && [401, 403, 404].includes(query.error.status));
    useEffect(() => {
        if (query.error instanceof ApiError && query.error.status === 401 && useUserStore.getState().token === token && useUserStore.getState().sessionRevision === sessionRevision) useUserStore.getState().clearSession();
    }, [query.error, token, sessionRevision]);
    const navigate = (patch: Record<string, string | undefined>, replace = false) => {
        const next = new URLSearchParams(search.toString());
        Object.entries(patch).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key));
        const href = `${pathname}${next.size ? `?${next}` : ""}`;
        if (replace) router.replace(href, { scroll: false });
        else router.push(href, { scroll: false });
    };
    const saved = (asset: ProductionAsset) => {
        void queryClient.invalidateQueries({ queryKey: queryPrefix });
        if (selection === "new") navigate({ asset: asset.id, category: asset.category, page: undefined, q: undefined }, true);
    };
    const accessDenied = () => {
        clearAssetCreativeDrafts(actorId, project.id);
        queryClient.setQueriesData({ queryKey: queryPrefix }, null);
        setDeniedMessage("此资产已无法访问。请重新载入资产库，确认当前项目权限。");
    };
    const session = useAssetSession(project.id, selection, category, Boolean(token) && !blocked, saved, accessDenied);
    const creative = useAssetCreativeSession(project.id, selection, Boolean(token) && !blocked && session.authorized && session.asset?.id === selection, accessDenied);
    useEffect(() => {
        if (blocked) clearAssetCreativeDrafts(actorId, project.id);
    }, [blocked, actorId, project.id]);
    const changeSelection = (patch: Record<string, string | undefined>) => {
        if (session.storageError && session.dirty && !window.confirm("本页草稿未能写入浏览器。切换前请先保存；仍要切换吗？")) return;
        if (creative.storageError && creative.dirty && !window.confirm("创意草稿未能写入浏览器。切换前请先保存；仍要切换吗？")) return;
        navigate(patch);
    };
    const create = () => changeSelection({ category, asset: "new", page: undefined, q: undefined });
    const isNew = selection === "new";
    const locked = blocked || session.phase === "loading" || session.phase === "blocked" || session.phase === "saving" || session.retryPending;
    const hasEditor = Boolean(selection) && !blocked && session.authorized && (isNew || Boolean(session.asset));
    const status = session.phase === "saving" ? "正在保存" : session.retryPending ? "等待确认" : session.phase === "conflict" ? "版本冲突" : session.dirty ? "未保存" : session.asset ? "已保存" : "未创建";

    return (
        <main className={styles.workbench} data-testid="asset-workbench" data-project-id={project.id} data-asset-id={session.asset?.id || ""}>
            <header className={styles.topbar}>
                <div><h1>资产创意</h1><p>建立人物与场景，让每一份设定有据可循。</p></div>
                <span className={styles.scopeNote}><ProjectIcon name="projects" /> 项目资产库</span>
            </header>
            <div className={styles.columns}>
                <aside className={styles.library} aria-label="资产分类与列表">
                    <div className={styles.categories} aria-label="资产分类">
                        {categories.map((item) => <button type="button" key={item.value} aria-pressed={category === item.value} className={category === item.value ? styles.activeCategory : ""} onClick={() => changeSelection({ category: item.value, asset: undefined, page: undefined, q: undefined })}>
                            <ProjectIcon name={item.icon} /><span>{item.label}</span><span className={styles.categoryCount}>{blocked ? "—" : query.data?.counts[item.value] ?? "—"}</span>
                        </button>)}
                    </div>
                    <div className={styles.listToolbar}>
                        <div className={styles.listTitle}><h2>{label}库</h2><Button size="small" type="text" icon={<ProjectIcon name="plus" />} onClick={create} disabled={blocked} aria-label={`新建${label}`}>新建</Button></div>
                        <form role="search" onSubmit={(event) => { event.preventDefault(); navigate({ q: searchText.trim() || undefined, page: undefined }, true); }}>
                            <Input aria-label="搜索资产名称或描述" placeholder="搜索名称或描述" value={searchText} onChange={(event) => setSearchText(Array.from(event.target.value).slice(0, 80).join(""))} suffix={<button type="submit" className={styles.searchButton} aria-label="搜索资产"><ProjectIcon name="search" /></button>} />
                        </form>
                        {keyword && <div className={styles.filterNote}><span>搜索：{keyword}</span><button type="button" onClick={() => navigate({ q: undefined, page: undefined }, true)}>清除</button></div>}
                    </div>
                    <div className={styles.assetList} aria-label={`${label}资产列表`}>
                        {blocked ? <div className={styles.listEmpty}>资产列表不可访问</div> : query.isPending ? <div className={styles.listEmpty}><Spin aria-label="正在加载资产列表" /></div> : query.isError ? <div className={styles.listEmpty}><p>{query.error.message}</p><Button size="small" onClick={() => void query.refetch()}>重试列表</Button></div> : query.data?.items.length ? query.data.items.map((asset) => <button type="button" key={asset.id} data-asset-list-id={asset.id} aria-current={selection === asset.id ? "true" : undefined} className={`${styles.assetRow} ${selection === asset.id ? styles.selectedAsset : ""}`} onClick={() => changeSelection({ asset: asset.id, category: asset.category })}>
                            <span className={styles.assetMark} aria-hidden>{asset.name.slice(0, 1)}</span>
                            <span className={styles.assetSummary}><strong>{asset.name}</strong><small>{asset.description || "尚未填写描述"}</small></span>
                        </button>) : <div className={styles.listEmpty}><p>{keyword ? "没有找到匹配的资产" : `还没有${label}资产`}</p><span>{keyword ? "试试其他名称或描述关键词。" : `新建${label}，先把设定记录下来。`}</span></div>}
                    </div>
                    <div className={styles.listFooter}>
                        <span>{blocked ? "—" : query.data?.total ?? 0} 项{keyword ? "结果" : label}</span>
                        <Pagination simple current={page} pageSize={20} total={blocked ? 0 : query.data?.total || 0} hideOnSinglePage showSizeChanger={false} onChange={(value) => navigate({ page: value === 1 ? undefined : String(value) })} />
                    </div>
                </aside>
                <section className={styles.editor} aria-label="资产资料">
                    {blocked ? <div className={styles.empty}><ProjectIcon name="assets" style={{ fontSize: 32 }} /><h2>当前资产无法访问</h2><p>{deniedMessage || query.error?.message}</p><Button onClick={() => { setDeniedMessage(""); navigate({ asset: undefined }, true); void query.refetch(); }}>重新载入资产库</Button></div> : !selection ? <div className={styles.empty}><span className={styles.emptyGlyph}><ProjectIcon name={category === "character" ? "user" : "scene"} /></span><h2>从一份{label}设定开始</h2><p>{category === "character" ? "记录人物的身份、外貌与性格，让角色在整个项目里保持一致。" : "记录场景的空间、时代与氛围，为每个镜头建立共同的环境设定。"}</p><Button type="primary" icon={<ProjectIcon name="plus" />} onClick={create}>新建{label}</Button><span className={styles.preparation}>整理资料无需消耗项目积分</span></div> : session.phase === "loading" && !hasEditor ? <div className={styles.empty}><Spin aria-label="正在加载资产资料" /></div> : !hasEditor ? <div className={styles.empty}><h2>资产暂时无法打开</h2><p>{session.message}</p><Button onClick={() => void session.reload()}>重试打开</Button></div> : <>
                        <header className={styles.editorHeader}>
                            <div className={styles.editorIdentity}><span className={styles.editorIcon}><ProjectIcon name={category === "character" ? "user" : "scene"} /></span><div><span className={styles.kindLabel}>{label}设定{session.asset ? ` · 资料第 ${session.asset.revision} 版` : ""}</span><h2 title={session.name || `新建${label}`}>{session.name || `新建${label}`}</h2></div></div>
                            <span className={`${styles.status} ${session.dirty || session.retryPending ? styles.unsaved : ""}`} aria-live="polite"><span aria-hidden />{status}</span>
                        </header>
                        <form className={styles.editorForm} onSubmit={(event) => { event.preventDefault(); void session.save(); }}>
                            <div className={styles.formFields}>
                                {session.storageError && <Alert type="warning" title="本页草稿未能写入浏览器" description="内容仍在当前页面。请先保存到项目资产库，再关闭或刷新页面。" showIcon />}
                                {session.message && <Alert type={session.phase === "conflict" || session.phase === "error" ? "warning" : "info"} title={session.message} showIcon />}
                                {session.phase === "conflict" && <Button className={styles.reloadButton} onClick={() => void session.reload()} icon={<ProjectIcon name="reload" />}>保留草稿，载入最新版本</Button>}
                                <div className={styles.field}><div className={styles.fieldHeading}><label htmlFor="project-asset-name">{label}名称</label><span>{Array.from(session.name).length} / 80</span></div><Input id="project-asset-name" size="large" value={session.name} disabled={locked} placeholder={category === "character" ? "例如：林川" : "例如：旧城天台 · 夜"} onChange={(event) => session.edit({ name: Array.from(event.target.value).slice(0, 80).join("") })} /></div>
                                <div className={`${styles.field} ${styles.descriptionField}`}><div className={styles.fieldHeading}><label htmlFor="project-asset-description">{label === "人物" ? "人物描述" : "场景描述"}</label><span>{Array.from(session.description).length} / 8000</span></div><Input.TextArea id="project-asset-description" value={session.description} disabled={locked} placeholder={category === "character" ? "写下身份、年龄、外貌、服饰和性格。也可以先保存名称，稍后补充。" : "写下地点、空间布局、时代、光线和氛围。也可以先保存名称，稍后补充。"} onChange={(event) => session.edit({ description: Array.from(event.target.value).slice(0, 8000).join("") })} /></div>
                                {session.backup && <details className={styles.backup}><summary>查看保留的本页草稿</summary><strong>{session.backup.name}</strong><p>{session.backup.description || "未填写描述"}</p><Button size="small" disabled={locked || session.phase !== "ready"} onClick={session.restoreBackup}>用这份草稿继续编辑</Button></details>}
                            </div>
                            <footer className={styles.saveBar}><div><span>{session.asset ? `上次保存 ${formatTime(session.asset.updatedAt)}` : "保存后进入当前项目资产库"}</span><small>{session.dirty && !session.storageError ? "本页草稿已保留" : "项目积分审批前也可整理资料"}</small></div><Button type="primary" htmlType="submit" loading={session.phase === "saving"} disabled={session.phase === "loading" || session.phase === "conflict" || !session.name.trim() || (!session.dirty && !session.retryPending)}>{session.retryPending && session.phase !== "saving" ? "重试确认" : isNew ? `创建${label}` : "保存修改"}</Button></footer>
                        </form>
                    </>}
                </section>
                <AssetCreativePanel session={creative} selected={Boolean(selection)} isNew={isNew} blocked={blocked} projectTitle={project.title} />
            </div>
        </main>
    );
}
