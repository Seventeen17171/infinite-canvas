export function tokenDanceRecoveryMessage(action: string | null) {
    switch ((action || "").trim()) {
        case "top_up_balance": return "TokenDance 余额不足，请充值后重试";
        case "reauthorize_api_key": return "TokenDance API Key 已失效，请重新授权";
        case "api_key_quota": return "TokenDance API Key 已达到周期额度，请等待额度刷新或重新授权";
        default: return "";
    }
}
