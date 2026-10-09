"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Input, Select } from "antd";
import { ChevronRight, Clapperboard, FileText, Group, Image as ImageIcon, Music2, Search, Settings2, Type, Video } from "lucide-react";
import { motion } from "motion/react";
import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { isCanvasImageNodeType } from "../utils/canvas-panorama";

export type CanvasNodesPanelProps = {
    nodes: CanvasNodeData[];
    selectedNodeIds: Set<string>;
    open: boolean;
    width: number;
    onWidthChange: (width: number) => void;
    onFocusNode: (nodeId: string) => void;
};

const PANEL_MOTION_SECONDS = 0.5;
const PANEL_EASE = [0.22, 1, 0.36, 1] as const;
const PANEL_MIN_WIDTH = 220;
const PANEL_MAX_WIDTH = 480;

const NODE_TYPE_ICON = {
    [CanvasNodeType.Image]: ImageIcon,
    [CanvasNodeType.Panorama]: ImageIcon,
    [CanvasNodeType.Video]: Video,
    [CanvasNodeType.Audio]: Music2,
    [CanvasNodeType.Text]: Type,
    [CanvasNodeType.Config]: Settings2,
    [CanvasNodeType.Director]: Clapperboard,
    [CanvasNodeType.Group]: Group,
};

const NODE_TYPE_LABEL = {
    [CanvasNodeType.Image]: "图片",
    [CanvasNodeType.Panorama]: "全景图",
    [CanvasNodeType.Video]: "视频",
    [CanvasNodeType.Audio]: "音频",
    [CanvasNodeType.Text]: "文本",
    [CanvasNodeType.Config]: "生成配置",
    [CanvasNodeType.Director]: "导演台",
    [CanvasNodeType.Group]: "组",
};

const NODE_FILTER_OPTIONS = [
    { label: "全部", value: "all" },
    { label: "图片", value: CanvasNodeType.Image },
    { label: "全景图", value: CanvasNodeType.Panorama },
    { label: "文本", value: CanvasNodeType.Text },
    { label: "配置", value: CanvasNodeType.Config },
    { label: "视频", value: CanvasNodeType.Video },
    { label: "音频", value: CanvasNodeType.Audio },
    { label: "导演台", value: CanvasNodeType.Director },
    { label: "组", value: CanvasNodeType.Group },
];

const STATUS_COLOR: Record<string, string> = {
    success: "#22c55e",
    loading: "#f59e0b",
    error: "#ef4444",
};

export function CanvasNodesPanel({ nodes, selectedNodeIds, open, width, onWidthChange, onFocusNode }: CanvasNodesPanelProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [mounted, setMounted] = useState(open);
    const [closing, setClosing] = useState(false);
    const [resizing, setResizing] = useState(false);

    useEffect(() => {
        if (open) {
            setMounted(true);
            setClosing(false);
            return;
        }
        setClosing(true);
        const timer = window.setTimeout(() => {
            setMounted(false);
            setClosing(false);
        }, PANEL_MOTION_SECONDS * 1000);
        return () => window.clearTimeout(timer);
    }, [open]);

    const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        const onMove = (moveEvent: PointerEvent) => onWidthChange(Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, startWidth + moveEvent.clientX - startX)));
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            setResizing(false);
        };
        setResizing(true);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    if (!mounted) return null;

    return (
        <motion.div
            className="relative z-[60] flex h-full shrink-0"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: open ? width + 1 : 0, opacity: open ? 1 : 0 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: PANEL_EASE }}
            style={{ overflow: "clip", pointerEvents: closing ? "none" : undefined }}
        >
            <motion.aside
                className="relative flex h-full shrink-0 flex-col overflow-hidden border-r"
                initial={{ x: -48 }}
                animate={{ x: closing ? -28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: PANEL_EASE }}
                style={{ width, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                data-canvas-no-zoom
            >
                <div className="flex items-center gap-5 px-4 pt-3.5">
                    <PanelTabButton label="画布" active theme={theme} onClick={() => undefined} />
                </div>
                <div className="mt-2 min-h-0 flex-1 overflow-hidden">
                    <CanvasNodesTab nodes={nodes} selectedNodeIds={selectedNodeIds} onFocusNode={onFocusNode} theme={theme} />
                </div>
                <button type="button" className="absolute inset-y-0 right-0 z-40 w-4 translate-x-1/2 cursor-col-resize" onPointerDown={startResize} aria-label="调整左侧面板宽度" />
            </motion.aside>
        </motion.div>
    );
}

function PanelTabButton({ label, active, theme, onClick }: { label: string; active: boolean; theme: CanvasTheme; onClick: () => void }) {
    return (
        <button type="button" onClick={onClick} className="relative pb-1.5 text-sm font-semibold transition-opacity" style={{ color: theme.node.text, opacity: active ? 1 : 0.45 }}>
            {label}
            {active ? <motion.span layoutId="sidePanelTabIndicator" className="absolute inset-x-0 -bottom-px h-0.5 rounded-full" style={{ background: theme.toolbar.activeText }} transition={{ type: "spring", stiffness: 500, damping: 34 }} /> : null}
        </button>
    );
}

export function CanvasNodesTab({ nodes, selectedNodeIds, onFocusNode, theme }: { nodes: CanvasNodeData[]; selectedNodeIds: Set<string>; onFocusNode: (nodeId: string) => void; theme: CanvasTheme }) {
    const [keyword, setKeyword] = useState("");
    const [typeFilter, setTypeFilter] = useState<string>("all");
    const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
    const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return nodes.filter((node) => {
            if (typeFilter !== "all" && node.type !== typeFilter) return false;
            return !query || [node.title, NODE_TYPE_LABEL[node.type], node.metadata?.content, node.metadata?.prompt].filter(Boolean).join(" ").toLowerCase().includes(query);
        });
    }, [keyword, nodes, typeFilter]);
    const treeRows = useMemo(() => {
        const filteredIds = new Set(filtered.map((node) => node.id));
        const groups = new Set(nodes.filter((node) => node.type === CanvasNodeType.Group).map((node) => node.id));
        const children = new Map<string, CanvasNodeData[]>();
        filtered.forEach((node) => {
            const groupId = node.metadata?.groupId;
            if (groupId && groups.has(groupId)) children.set(groupId, [...(children.get(groupId) || []), node]);
        });
        return nodes.flatMap((node) => {
            if (node.metadata?.groupId && groups.has(node.metadata.groupId)) return [];
            if (node.type !== CanvasNodeType.Group) return filteredIds.has(node.id) ? [{ node, depth: 0, hasChildren: false }] : [];
            const groupChildren = children.get(node.id) || [];
            if (!filteredIds.has(node.id) && !groupChildren.length) return [];
            return [{ node, depth: 0, hasChildren: groupChildren.length > 0 }, ...(collapsedGroups.has(node.id) ? [] : groupChildren.map((child) => ({ node: child, depth: 1, hasChildren: false })))];
        });
    }, [collapsedGroups, filtered, nodes]);

    useEffect(() => {
        const selectedId = Array.from(selectedNodeIds)[0];
        if (selectedId) rowRefs.current[selectedId]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, [selectedNodeIds]);

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 px-3 pb-2.5 pt-1">
                <span className="text-xs font-medium opacity-60">画布元素</span>
                <span className="text-xs opacity-35">{nodes.length}</span>
                <Select aria-label="筛选节点类型" size="small" variant="borderless" className="w-auto" popupMatchSelectWidth={false} value={typeFilter} onChange={setTypeFilter} options={NODE_FILTER_OPTIONS} />
            </div>
            <div className="px-3 pb-2.5">
                <Input aria-label="搜索节点" size="small" allowClear prefix={<Search className="size-3.5 text-stone-400" />} placeholder="搜索节点" value={keyword} onChange={(event) => setKeyword(event.target.value)} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {treeRows.length ? (
                    <div className="space-y-1.5">
                        {treeRows.map(({ node, depth, hasChildren }) => {
                            const Icon = NODE_TYPE_ICON[node.type] || FileText;
                            const hasImage = isCanvasImageNodeType(node.type) && node.metadata?.content;
                            const active = selectedNodeIds.has(node.id);
                            return (
                                <div key={node.id} className={cn("relative flex items-center rounded-lg transition", depth && "ml-5", active ? "" : "hover:bg-black/5 dark:hover:bg-white/5")} style={active ? { background: theme.toolbar.activeBg } : undefined}>
                                    {depth ? <span className="pointer-events-none absolute -left-3 top-[calc(-50%-0.4rem)] h-[calc(100%+0.4rem)] w-3 rounded-bl-md border-b border-l opacity-45" style={{ borderColor: theme.node.stroke }} /> : null}
                                    {node.type === CanvasNodeType.Group && hasChildren ? (
                                        <button type="button" onClick={() => setCollapsedGroups((current) => (current.has(node.id) ? new Set([...current].filter((id) => id !== node.id)) : new Set(current).add(node.id)))} className="ml-1 grid size-6 shrink-0 place-items-center opacity-55 transition hover:opacity-100" aria-label={node.title}>
                                            <ChevronRight className={cn("size-3.5 transition-transform", !collapsedGroups.has(node.id) && "rotate-90")} />
                                        </button>
                                    ) : null}
                                    <button
                                        ref={(element) => {
                                            rowRefs.current[node.id] = element;
                                        }}
                                        type="button"
                                        onClick={() => onFocusNode(node.id)}
                                        data-node-list-id={node.id}
                                        aria-label={`选择节点 ${node.title || NODE_TYPE_LABEL[node.type] || "未命名节点"}`}
                                        aria-pressed={active}
                                        className={cn("flex min-w-0 flex-1 items-center gap-3 py-2 pr-2 text-left", node.type === CanvasNodeType.Group && hasChildren ? "pl-0" : "pl-2")}
                                    >
                                        <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md">
                                            {hasImage ? <img src={node.metadata?.content} alt={node.title} className="size-full object-cover" /> : <Icon className="size-5 opacity-60" />}
                                        </span>
                                        <span className="min-w-0 flex-1 space-y-0.5">
                                            <span className="block truncate text-sm font-medium leading-snug">{node.title || NODE_TYPE_LABEL[node.type] || "未命名节点"}</span>
                                            <span className="block truncate text-xs leading-snug opacity-50">{node.type === CanvasNodeType.Text ? node.metadata?.content || node.metadata?.prompt || "" : NODE_TYPE_LABEL[node.type] || node.type}</span>
                                        </span>
                                        {node.metadata?.status && node.metadata.status !== "idle" ? <span className="size-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[node.metadata.status] || "transparent" }} /> : null}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="pt-16 text-center text-sm opacity-40">{nodes.length ? "无匹配节点" : "画布暂无节点"}</div>
                )}
            </div>
        </div>
    );
}
