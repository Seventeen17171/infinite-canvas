"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type MouseEvent as ReactMouseEvent } from "react";
import { App } from "antd";
import { ProjectIcon } from "@/components/ui/project-icon";
import { InfiniteCanvas } from "@/app/(user)/canvas/components/infinite-canvas";
import { CanvasNode } from "@/app/(user)/canvas/components/canvas-node";
import { ActiveConnectionPath, ConnectionPath } from "@/app/(user)/canvas/components/canvas-connections";
import { CanvasToolbar, type CanvasToolbarAction } from "@/app/(user)/canvas/components/canvas-toolbar";
import { CanvasZoomControls } from "@/app/(user)/canvas/components/canvas-zoom-controls";
import { CanvasNodeHoverToolbar } from "@/app/(user)/canvas/components/canvas-node-hover-toolbar";
import { CanvasNodeContextMenu } from "@/app/(user)/canvas/components/canvas-context-menu";
import { CanvasNodesPanel } from "@/app/(user)/canvas/components/canvas-nodes-panel";
import { Minimap } from "@/app/(user)/canvas/components/canvas-mini-map";
import { CanvasNodeType, type ConnectionHandle, type ContextMenuState, type Position, type ViewportTransform } from "@/app/(user)/canvas/types";
import { findContainingGroupId, getNodeBounds } from "@/app/(user)/canvas/utils/canvas-group";
import { canvasThemes } from "@/lib/canvas-theme";
import type { ProductionCanvasContent, ProductionCanvasNode } from "@/services/api/production-canvas-documents";
import { useThemeStore } from "@/stores/use-theme-store";
import styles from "./document-editor.module.css";

type Props = { content: ProductionCanvasContent; onChange: (content: ProductionCanvasContent) => void; disabled?: boolean; header?: ReactNode; notice?: ReactNode };
type DragState = { x: number; y: number; positions: Map<string, Position>; started: boolean };
const noop = () => {};
const documentActions: readonly CanvasToolbarAction[] = ["tool", "undo", "redo", "text", "group", "style", "delete", "clear"];
const nodeActions = ["delete", "decreaseFont", "increaseFont"];
const documentShortcuts = [
    { label: "Space + 拖动", value: "临时反转选择/移动工具" },
    { label: "滚轮", value: "缩放画布" },
    { label: "双击文本 / 标题", value: "编辑内容 / 节点名称" },
    { label: "拖动节点两侧圆点", value: "连接文本节点" },
    { label: "Shift / Ctrl / Cmd + 点击", value: "追加选择节点" },
    { label: "Ctrl / Cmd + G", value: "将选中文本加入分组" },
    { label: "Ctrl / Cmd + Z", value: "撤销" },
    { label: "Ctrl / Cmd + Shift + Z", value: "重做" },
    { label: "右键节点", value: "复制或删除" },
    { label: "Delete / Backspace", value: "删除选中" },
];
const bound = (value: number, min = -1_000_000, max = 1_000_000) => Math.min(max, Math.max(min, value));
const isInput = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest("input,textarea,select,[contenteditable='true']"));

export function DocumentEditor({ content, onChange, disabled = false, header, notice }: Props) {
    const { message, modal } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const rootRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const surfaceRef = useRef<HTMLDivElement>(null);
    const contentRef = useRef(content);
    const onChangeRef = useRef(onChange);
    const disabledRef = useRef(disabled);
    const lastEmitted = useRef<ProductionCanvasContent | null>(null);
    const history = useRef<{ past: ProductionCanvasContent[]; future: ProductionCanvasContent[]; key: string; at: number }>({ past: [], future: [], key: "", at: 0 });
    const selectionRef = useRef(new Set<string>());
    const drag = useRef<DragState | null>(null);
    const connectingRef = useRef<ConnectionHandle | null>(null);
    const connectionDrag = useRef(false);
    const animationRef = useRef<number | null>(null);
    const pendingMove = useRef<{ x: number; y: number } | null>(null);
    const [selected, setSelected] = useState(new Set<string>());
    const [selectedConnection, setSelectedConnection] = useState<string | null>(null);
    const [tool, setTool] = useState<"select" | "pan">("select");
    const [connecting, setConnecting] = useState<ConnectionHandle | null>(null);
    const [mouseWorld, setMouseWorld] = useState<Position>({ x: 0, y: 0 });
    const [miniMap, setMiniMap] = useState(false);
    const [size, setSize] = useState({ width: 1000, height: 600 });
    const [historyVersion, setHistoryVersion] = useState(0);
    const [panelOpen, setPanelOpen] = useState(true);
    const [panelWidth, setPanelWidth] = useState(280);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

    useLayoutEffect(() => {
        onChangeRef.current = onChange;
        disabledRef.current = disabled;
    }, [onChange, disabled]);
    useLayoutEffect(() => {
        if (content !== contentRef.current && content !== lastEmitted.current) {
            history.current = { past: [], future: [], key: "", at: 0 };
            selectionRef.current = new Set();
            setSelected(new Set());
            setSelectedConnection(null);
            setHoveredNodeId(null);
            setContextMenu(null);
            connectingRef.current = null;
            setConnecting(null);
            drag.current = null;
            setHistoryVersion((value) => value + 1);
        }
        contentRef.current = content;
    }, [content]);

    const choose = useCallback((ids: Set<string>) => {
        selectionRef.current = ids;
        setSelected(ids);
        setSelectedConnection(null);
        setHoveredNodeId(ids.size === 1 ? [...ids][0] : null);
        setContextMenu(null);
    }, []);
    const emit = useCallback((next: ProductionCanvasContent) => {
        if (disabledRef.current || next === contentRef.current) return;
        contentRef.current = next;
        lastEmitted.current = next;
        onChangeRef.current(next);
    }, []);
    const checkpoint = useCallback((key = "") => {
        const now = Date.now();
        const current = history.current;
        if (!key || key !== current.key || now - current.at > 800) current.past = [...current.past.slice(-39), contentRef.current];
        current.key = key;
        current.at = now;
        current.future = [];
        setHistoryVersion((value) => value + 1);
    }, []);
    const change = useCallback(
        (updater: (current: ProductionCanvasContent) => ProductionCanvasContent, key = "") => {
            if (disabledRef.current) return;
            const next = updater(contentRef.current);
            if (next === contentRef.current) return;
            checkpoint(key);
            emit(next);
        },
        [checkpoint, emit],
    );
    const patchNode = useCallback(
        (id: string, patch: Partial<ProductionCanvasNode>, key = "") => {
            change((current) => ({ ...current, nodes: current.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)) }), key);
        },
        [change],
    );
    const worldPoint = useCallback((x: number, y: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const view = contentRef.current.viewport;
        return { x: (x - (rect?.left || 0) - view.x) / view.k, y: (y - (rect?.top || 0) - view.y) / view.k };
    }, []);
    const viewportChange = useCallback(
        (viewport: ViewportTransform) => {
            if (![viewport.x, viewport.y, viewport.k].every(Number.isFinite)) return;
            emit({ ...contentRef.current, viewport: { x: bound(viewport.x), y: bound(viewport.y), k: bound(viewport.k, 0.05, 5) } });
        },
        [emit],
    );
    const resetConnection = useCallback(() => {
        connectingRef.current = null;
        connectionDrag.current = false;
        setConnecting(null);
    }, []);
    const addConnection = useCallback(
        (fromNodeId: string, toNodeId: string) => {
            const current = contentRef.current;
            if (disabledRef.current || fromNodeId === toNodeId) return;
            const from = current.nodes.find((node) => node.id === fromNodeId && node.type === CanvasNodeType.Text);
            const to = current.nodes.find((node) => node.id === toNodeId && node.type === CanvasNodeType.Text);
            if (!from || !to) return;
            if (current.connections.some((connection) => connection.fromNodeId === fromNodeId && connection.toNodeId === toNodeId)) {
                void message.warning("这两个节点之间已有连线");
                return;
            }
            if (current.connections.length >= 600) {
                void message.warning("每份画布最多 600 条连线");
                return;
            }
            change((value) => ({ ...value, connections: [...value.connections, { id: crypto.randomUUID(), fromNodeId, toNodeId }] }));
            resetConnection();
        },
        [change, message, resetConnection],
    );
    const finishConnection = useCallback(
        (targetId: string) => {
            const start = connectingRef.current;
            if (start) addConnection(start.handleType === "source" ? start.nodeId : targetId, start.handleType === "source" ? targetId : start.nodeId);
        },
        [addConnection],
    );

    useEffect(() => {
        const element = containerRef.current;
        if (!element) return;
        const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const flushMove = useCallback(() => {
        animationRef.current = null;
        const point = pendingMove.current;
        pendingMove.current = null;
        if (!point || disabledRef.current) return;
        if (connectingRef.current) setMouseWorld(worldPoint(point.x, point.y));
        const currentDrag = drag.current;
        if (!currentDrag) return;
        const dx = (point.x - currentDrag.x) / contentRef.current.viewport.k;
        const dy = (point.y - currentDrag.y) / contentRef.current.viewport.k;
        if (!currentDrag.started && Math.abs(dx) + Math.abs(dy) < 2) return;
        if (!currentDrag.started) {
            checkpoint();
            currentDrag.started = true;
        }
        emit({
            ...contentRef.current,
            nodes: contentRef.current.nodes.map((node) => {
                const start = currentDrag.positions.get(node.id);
                return start ? { ...node, position: { x: bound(start.x + dx), y: bound(start.y + dy) } } : node;
            }),
        });
    }, [checkpoint, emit, worldPoint]);
    useEffect(() => {
        const move = (event: MouseEvent) => {
            if (!drag.current && !connectingRef.current) return;
            pendingMove.current = { x: event.clientX, y: event.clientY };
            if (animationRef.current === null) animationRef.current = requestAnimationFrame(flushMove);
        };
        const up = (event: MouseEvent) => {
            if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
            flushMove();
            const completedDrag = drag.current;
            drag.current = null;
            if (completedDrag?.started && !disabledRef.current) {
                const nodes = contentRef.current.nodes;
                emit({
                    ...contentRef.current,
                    nodes: nodes.map((node) => {
                        if (!completedDrag.positions.has(node.id) || node.type === CanvasNodeType.Group || (node.metadata?.groupId && completedDrag.positions.has(node.metadata.groupId))) return node;
                        const groupId = findContainingGroupId(node, nodes);
                        return groupId === node.metadata?.groupId ? node : { ...node, metadata: { ...node.metadata, groupId } };
                    }),
                });
            }
            if (connectionDrag.current) {
                const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-node-id]");
                if (target && containerRef.current?.contains(target)) finishConnection(target.dataset.nodeId || "");
                resetConnection();
            }
        };
        const blur = () => {
            drag.current = null;
            resetConnection();
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        window.addEventListener("blur", blur);
        return () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
            window.removeEventListener("blur", blur);
            if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
        };
    }, [emit, finishConnection, flushMove, resetConnection]);

    const addNode = useCallback(
        (type: CanvasNodeType.Text | CanvasNodeType.Group, at?: Position) => {
            if (disabledRef.current) return;
            const current = contentRef.current;
            if (current.nodes.length >= 300) {
                void message.warning("每份画布最多 300 个节点");
                return;
            }
            const chosen = type === CanvasNodeType.Group ? current.nodes.filter((node) => selectionRef.current.has(node.id) && node.type === CanvasNodeType.Text) : [];
            const bounds = chosen.length ? getNodeBounds(chosen) : null;
            const rect = containerRef.current?.getBoundingClientRect();
            const center = at || worldPoint((rect?.left || 0) + (rect?.width || 1000) / 2, (rect?.top || 0) + (rect?.height || 600) / 2);
            const offset = (current.nodes.filter((node) => node.type === type).length % 5) * 24;
            const width = bounds ? Math.max(400, bounds.right - bounds.left + 64) : type === CanvasNodeType.Text ? 340 : 620;
            const height = bounds ? Math.max(240, bounds.bottom - bounds.top + 80) : type === CanvasNodeType.Text ? 240 : 380;
            if (width > 10_000 || height > 10_000) {
                void message.warning("选中内容跨度过大，请分成多个分组");
                return;
            }
            const id = crypto.randomUUID();
            const node: ProductionCanvasNode = {
                id,
                type,
                title: `${type === CanvasNodeType.Text ? "文本" : "分组"} ${current.nodes.filter((item) => item.type === type).length + 1}`,
                position: bounds ? { x: bound(bounds.left - 32), y: bound(bounds.top - 40) } : { x: bound(center.x - width / 2 + offset), y: bound(center.y - height / 2 + offset) },
                width,
                height,
                metadata: type === CanvasNodeType.Text ? { content: "", fontSize: 14 } : {},
            };
            change((value) => ({ ...value, nodes: [...value.nodes.map((item) => (chosen.some((child) => child.id === item.id) ? { ...item, metadata: { ...item.metadata, groupId: id } } : item)), node] }));
            choose(new Set([id]));
            surfaceRef.current?.focus({ preventScroll: true });
        },
        [change, choose, message, worldPoint],
    );
    const removeContent = useCallback(
        (ids: Set<string>, edgeId?: string | null) => {
            if (disabledRef.current || (!ids.size && !edgeId)) return;
            change((value) => ({
                ...value,
                nodes: value.nodes.filter((node) => !ids.has(node.id)).map((node) => (node.metadata?.groupId && ids.has(node.metadata.groupId) ? { ...node, metadata: { ...node.metadata, groupId: undefined } } : node)),
                connections: value.connections.filter((edge) => edge.id !== edgeId && !ids.has(edge.fromNodeId) && !ids.has(edge.toNodeId)),
            }));
            choose(new Set());
            resetConnection();
        },
        [change, choose, resetConnection],
    );
    const deleteSelection = useCallback(() => removeContent(selectionRef.current, selectedConnection), [removeContent, selectedConnection]);
    const duplicateNode = (id: string) => {
        if (disabledRef.current) return;
        const current = contentRef.current;
        const source = current.nodes.find((node) => node.id === id);
        if (!source) return;
        const ids = new Set([id]);
        let size = 0;
        while (size !== ids.size) {
            size = ids.size;
            current.nodes.forEach((node) => {
                if (node.metadata?.groupId && ids.has(node.metadata.groupId)) ids.add(node.id);
            });
        }
        const internalConnections = current.connections.filter((edge) => ids.has(edge.fromNodeId) && ids.has(edge.toNodeId));
        if (current.nodes.length + ids.size > 300 || current.connections.length + internalConnections.length > 600) {
            void message.warning("复制后将超过画布节点或连线数量上限");
            return;
        }
        const copies = new Map([...ids].map((oldId) => [oldId, crypto.randomUUID()]));
        const nodes = current.nodes
            .filter((node) => ids.has(node.id))
            .map((node) => ({
                ...node,
                id: copies.get(node.id)!,
                title: `${node.title} 副本`.slice(0, 200),
                position: { x: bound(node.position.x + 36), y: bound(node.position.y + 36) },
                metadata: { ...node.metadata, ...(node.metadata?.groupId ? { groupId: copies.get(node.metadata.groupId) || node.metadata.groupId } : {}) },
            }));
        change((value) => ({
            ...value,
            nodes: [...value.nodes, ...nodes],
            connections: [...value.connections, ...internalConnections.map((edge) => ({ id: crypto.randomUUID(), fromNodeId: copies.get(edge.fromNodeId)!, toNodeId: copies.get(edge.toNodeId)! }))],
        }));
        choose(new Set([copies.get(id)!]));
    };
    const undo = useCallback(
        (redo = false) => {
            if (disabledRef.current) return;
            const current = history.current;
            const source = redo ? current.future : current.past;
            const next = source.pop();
            if (!next) return;
            (redo ? current.past : current.future).push(contentRef.current);
            current.key = "";
            emit({ ...next, viewport: contentRef.current.viewport });
            choose(new Set());
            resetConnection();
            setHistoryVersion((value) => value + 1);
        },
        [choose, emit, resetConnection],
    );
    useEffect(() => {
        const key = (event: KeyboardEvent) => {
            if (disabledRef.current || !rootRef.current?.contains(document.activeElement) || isInput(event.target)) return;
            const command = event.ctrlKey || event.metaKey;
            if (event.key === "Escape") {
                resetConnection();
                choose(new Set());
            } else if (command && event.key.toLowerCase() === "z") {
                event.preventDefault();
                undo(event.shiftKey);
            } else if (command && event.key.toLowerCase() === "y") {
                event.preventDefault();
                undo(true);
            } else if (command && event.key.toLowerCase() === "a") {
                event.preventDefault();
                choose(new Set(contentRef.current.nodes.map((node) => node.id)));
            } else if (command && event.key.toLowerCase() === "g") {
                event.preventDefault();
                addNode(CanvasNodeType.Group);
            } else if (event.key === "Delete" || event.key === "Backspace") {
                event.preventDefault();
                deleteSelection();
            }
        };
        window.addEventListener("keydown", key);
        return () => window.removeEventListener("keydown", key);
    }, [addNode, choose, deleteSelection, resetConnection, undo]);

    const startNodeDrag = (event: ReactMouseEvent, id: string) => {
        if (disabled || tool === "pan" || event.button !== 0 || isInput(event.target)) return;
        event.stopPropagation();
        event.preventDefault();
        surfaceRef.current?.focus({ preventScroll: true });
        const node = contentRef.current.nodes.find((item) => item.id === id);
        if (!node) return;
        const additive = event.shiftKey || event.ctrlKey || event.metaKey;
        const ids = additive ? new Set(selectionRef.current) : selectionRef.current.has(id) ? new Set(selectionRef.current) : new Set<string>();
        if (additive && ids.has(id)) {
            ids.delete(id);
            choose(ids);
            return;
        }
        ids.add(id);
        choose(ids);
        const movingIds = new Set(ids);
        let previousSize = -1;
        while (previousSize !== movingIds.size) {
            previousSize = movingIds.size;
            contentRef.current.nodes.forEach((item) => {
                if (item.metadata?.groupId && movingIds.has(item.metadata.groupId)) movingIds.add(item.id);
            });
        }
        drag.current = { x: event.clientX, y: event.clientY, positions: new Map(contentRef.current.nodes.filter((item) => movingIds.has(item.id)).map((item) => [item.id, item.position])), started: false };
    };
    const resizeNode = useCallback(
        (id: string, width: number, height: number, position?: Position) => {
            patchNode(id, { width: bound(width, 16, 10_000), height: bound(height, 16, 10_000), ...(position ? { position: { x: bound(position.x), y: bound(position.y) } } : {}) }, `resize:${id}`);
        },
        [patchNode],
    );
    const changeNodeText = useCallback(
        (id: string, text: string) => {
            const node = contentRef.current.nodes.find((item) => item.id === id);
            if (node) patchNode(id, { metadata: { ...node.metadata, content: text.slice(0, 50_000) } }, `text:${id}`);
        },
        [patchNode],
    );
    const changeNodeTitle = useCallback((id: string, title: string) => patchNode(id, { title: title.slice(0, 200) }, `title:${id}`), [patchNode]);
    const fit = () => {
        if (!content.nodes.length) {
            viewportChange({ x: 0, y: 0, k: 1 });
            return;
        }
        const bounds = getNodeBounds(content.nodes);
        const k = bound(Math.min((size.width - 120) / (bounds.right - bounds.left), (size.height - 140) / (bounds.bottom - bounds.top), 1), 0.05, 5);
        viewportChange({ x: size.width / 2 - ((bounds.left + bounds.right) / 2) * k, y: size.height / 2 - ((bounds.top + bounds.bottom) / 2) * k, k });
    };
    const zoom = (k: number) => {
        k = bound(k, 0.05, 5);
        const current = contentRef.current.viewport;
        viewportChange({ x: size.width / 2 - ((size.width / 2 - current.x) / current.k) * k, y: size.height / 2 - ((size.height / 2 - current.y) / current.k) * k, k });
    };
    const activeNode = selected.size === 1 ? content.nodes.find((node) => selected.has(node.id)) : undefined;
    const canUndo = history.current.past.length > 0;
    const canRedo = history.current.future.length > 0;
    const style = {
        "--editor-panel": theme.toolbar.panel,
        "--editor-border": theme.node.stroke,
        "--editor-text": theme.node.text,
        "--editor-muted": theme.node.muted,
        "--editor-fill": theme.node.fill,
        "--editor-active": theme.node.activeStroke,
    } as CSSProperties;

    const focusNode = (id: string) => {
        if (disabled) return;
        const node = contentRef.current.nodes.find((item) => item.id === id);
        if (!node) return;
        choose(new Set([id]));
        const k = bound(Math.min(contentRef.current.viewport.k, (size.width - 120) / node.width, (size.height - 180) / node.height), 0.05, 5);
        viewportChange({ x: size.width / 2 - (node.position.x + node.width / 2) * k, y: size.height / 2 - (node.position.y + node.height / 2) * k, k });
        surfaceRef.current?.focus({ preventScroll: true });
    };
    const changeFontSize = (id: string, increment: number) => {
        const node = contentRef.current.nodes.find((item) => item.id === id);
        if (node) patchNode(id, { metadata: { ...node.metadata, fontSize: bound((node.metadata?.fontSize || 14) + increment, 8, 128) } }, `font:${id}`);
    };
    const hoverNode = drag.current?.started || connecting ? null : content.nodes.find((node) => node.id === hoveredNodeId) || activeNode || null;

    return (
        <div ref={rootRef} className={styles.editor} style={style} data-testid="production-canvas-editor" data-history-version={historyVersion}>
            <CanvasNodesPanel nodes={content.nodes} selectedNodeIds={selected} open={panelOpen} width={panelWidth} onWidthChange={setPanelWidth} onFocusNode={focusNode} />
            <section className={styles.surface}>
                <div className={styles.header} data-canvas-no-zoom>
                    <button
                        type="button"
                        onClick={() => setPanelOpen((value) => !value)}
                        className="grid size-7 shrink-0 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10"
                        style={{ color: theme.node.text }}
                        aria-label={panelOpen ? "收起左侧面板" : "展开左侧面板"}
                    >
                        <ProjectIcon name={panelOpen ? "panelClose" : "panelOpen"} style={{ fontSize: 16 }} />
                    </button>
                    <div className={styles.headerContent}>{header}</div>
                </div>
                {notice ? (
                    <div className={styles.notice} data-canvas-no-zoom>
                        {notice}
                    </div>
                ) : null}
                <div ref={surfaceRef} className={styles.canvas} tabIndex={0} aria-label="画布编辑区" data-testid="canvas-viewport" inert={disabled}>
                    <InfiniteCanvas
                        containerRef={containerRef}
                        viewport={content.viewport}
                        tool={tool}
                        backgroundMode={content.backgroundMode}
                        onViewportChange={viewportChange}
                        onCanvasDeselect={() => choose(new Set())}
                        onCanvasMouseDown={() => {
                            surfaceRef.current?.focus({ preventScroll: true });
                            choose(new Set());
                        }}
                        onCanvasDoubleClick={(event) => addNode(CanvasNodeType.Text, worldPoint(event.clientX, event.clientY))}
                        onContextMenu={(event) => {
                            event.preventDefault();
                            setContextMenu(null);
                        }}
                    >
                        <svg className={styles.connections} data-testid="canvas-connections">
                            {content.connections.map((edge) => {
                                const from = content.nodes.find((node) => node.id === edge.fromNodeId);
                                const to = content.nodes.find((node) => node.id === edge.toNodeId);
                                return from && to ? (
                                    <ConnectionPath
                                        key={edge.id}
                                        connection={edge}
                                        from={from}
                                        to={to}
                                        active={edge.id === selectedConnection}
                                        onSelect={() => {
                                            choose(new Set());
                                            setSelectedConnection(edge.id);
                                            surfaceRef.current?.focus({ preventScroll: true });
                                        }}
                                        onContextMenu={(event) => {
                                            choose(new Set());
                                            setSelectedConnection(edge.id);
                                            setContextMenu({ type: "connection", connectionId: edge.id, x: event.clientX, y: event.clientY });
                                        }}
                                    />
                                ) : null;
                            })}
                            {connecting && <ActiveConnectionPath node={content.nodes.find((node) => node.id === connecting.nodeId)} handle={connecting} mouseWorld={mouseWorld} />}
                        </svg>
                        {content.nodes.map((node) => (
                            <CanvasNode
                                key={node.id}
                                data={node}
                                scale={content.viewport.k}
                                isSelected={selected.has(node.id)}
                                isRelated={false}
                                isFocusRelated={false}
                                isConnectionTarget={false}
                                isConnecting={Boolean(connecting)}
                                showPanel={false}
                                showImageInfo={false}
                                groupChildCount={node.type === CanvasNodeType.Group ? content.nodes.filter((child) => child.metadata?.groupId === node.id).length : undefined}
                                onMouseDown={startNodeDrag}
                                onHoverStart={setHoveredNodeId}
                                onHoverEnd={noop}
                                onConnectStart={(event, nodeId, handleType) => {
                                    if (disabled) return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    const start = { nodeId, handleType };
                                    connectingRef.current = start;
                                    connectionDrag.current = true;
                                    setConnecting(start);
                                    setMouseWorld(worldPoint(event.clientX, event.clientY));
                                }}
                                onResize={resizeNode}
                                onContentChange={changeNodeText}
                                onTitleChange={changeNodeTitle}
                                onContextMenu={(event, id) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    choose(new Set([id]));
                                    setContextMenu({ type: "node", nodeId: id, x: event.clientX, y: event.clientY });
                                }}
                            />
                        ))}
                    </InfiniteCanvas>
                </div>
                <CanvasNodeHoverToolbar
                    node={hoverNode}
                    viewport={content.viewport}
                    disabled={disabled}
                    visibleToolIds={nodeActions}
                    persistToolPreferences={false}
                    onKeep={setHoveredNodeId}
                    onLeave={noop}
                    onDecreaseFont={(node) => changeFontSize(node.id, -2)}
                    onIncreaseFont={(node) => changeFontSize(node.id, 2)}
                    onDelete={(node) => removeContent(new Set([node.id]))}
                />
                <CanvasToolbar
                    selectedCount={selected.size + (selectedConnection ? 1 : 0)}
                    canvasTool={tool}
                    canUndo={canUndo}
                    canRedo={canRedo}
                    backgroundMode={content.backgroundMode}
                    showImageInfo={false}
                    visibleActions={documentActions}
                    disabled={disabled}
                    showImageInfoControl={false}
                    onAddText={() => addNode(CanvasNodeType.Text)}
                    onAddGroup={() => addNode(CanvasNodeType.Group)}
                    onUndo={() => undo()}
                    onRedo={() => undo(true)}
                    onDelete={deleteSelection}
                    onClear={() => {
                        if (disabledRef.current || !contentRef.current.nodes.length) return;
                        modal.confirm({
                            title: "清空画布？",
                            content: "当前画布的节点和连线将被移除，可通过撤销恢复。",
                            okText: "清空",
                            cancelText: "取消",
                            onOk: () => {
                                change((value) => ({ ...value, nodes: [], connections: [] }));
                                choose(new Set());
                                resetConnection();
                            },
                        });
                    }}
                    onCanvasToolChange={(value) => {
                        setTool(value);
                        resetConnection();
                        setContextMenu(null);
                    }}
                    onBackgroundModeChange={(backgroundMode) => change((value) => ({ ...value, backgroundMode }))}
                />
                {miniMap ? <Minimap nodes={content.nodes} viewport={content.viewport} viewportSize={size} onViewportChange={viewportChange} /> : null}
                <CanvasZoomControls scale={content.viewport.k} onScaleChange={zoom} onReset={fit} isMiniMapOpen={miniMap} onToggleMiniMap={() => setMiniMap((value) => !value)} disabled={disabled} shortcuts={documentShortcuts} />
                {contextMenu && !disabled ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        canCaptureVideoFrame={false}
                        onCaptureVideoFrame={noop}
                        onClose={() => setContextMenu(null)}
                        onDuplicate={() => {
                            if (contextMenu.type === "node") duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onDelete={() => {
                            if (contextMenu.type === "node") removeContent(new Set([contextMenu.nodeId]));
                            else removeContent(new Set(), contextMenu.connectionId);
                            setContextMenu(null);
                        }}
                    />
                ) : null}
            </section>
        </div>
    );
}
