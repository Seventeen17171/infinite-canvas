import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 300;

type RouteContext = {
    params: Promise<{ path: string[] }>;
};

function proxyHeaders(request: NextRequest, privateFile: boolean) {
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("content-length");
    headers.delete("connection");
    headers.delete("expect");
    headers.set("x-forwarded-host", request.nextUrl.host);
    headers.set("x-forwarded-proto", request.nextUrl.protocol.replace(":", ""));
    if (privateFile) headers.set("accept-encoding", "identity");
    return headers;
}

function privateHeaders(headers: Headers) {
    headers.set("cache-control", "private, no-store");
    headers.set("x-content-type-options", "nosniff");
    const vary = headers.get("vary")?.split(",").map(value => value.trim()) ?? [];
    if (!vary.some(value => value.toLowerCase() === "authorization")) vary.push("Authorization");
    headers.set("vary", vary.join(", "));
    return headers;
}

function responseHeaders(response: Response, privateFile: boolean) {
    const headers = new Headers(response.headers);
    if (!privateFile || response.headers.has("content-encoding")) headers.delete("content-length");
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    return privateFile ? privateHeaders(headers) : headers;
}

async function proxy(request: NextRequest, context: RouteContext) {
    const { path } = await context.params;
    const privateFile = path[0] === "v1" && path[1] === "production" && path[2] === "projects"
        && (path[4] === "files" || (path[4] === "assets" && ["files", "file-uploads"].includes(path[6])));
    const apiBaseUrl = process.env.API_BASE_URL || "http://127.0.0.1:8080";
    const target = `${apiBaseUrl.replace(/\/$/, "")}/api/${path.map(encodeURIComponent).join("/")}${request.nextUrl.search}`;
    const hasBody = request.method !== "GET" && request.method !== "HEAD";

    try {
        const response = await fetch(target, {
            method: request.method,
            headers: proxyHeaders(request, privateFile),
            body: hasBody ? request.body : undefined,
            duplex: hasBody ? "half" : undefined,
            redirect: "manual",
            ...(privateFile ? { cache: "no-store", signal: request.signal } : {}),
        } as RequestInit & { duplex?: "half" });

        return new Response(request.method === "HEAD" ? null : response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders(response, privateFile),
        });
    } catch (error) {
        console.error("Failed to proxy", privateFile ? target.split("?")[0] : target, error);
        const headers = new Headers({ "content-type": "application/json" });
        return new Response(request.method === "HEAD" ? null : JSON.stringify({ code: 1, data: null, msg: "接口连接失败，请确认后端服务已启动" }), {
            status: 502,
            headers: privateFile ? privateHeaders(headers) : headers,
        });
    }
}

export const GET = proxy;
export const HEAD = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
