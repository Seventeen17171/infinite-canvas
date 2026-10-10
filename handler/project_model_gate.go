package handler

import "net/http"

// Retired personal execution must not bypass project budget approval or charge User.Credits.
// Project-owned task submission will get its own authorization and reservation transaction.
func ProjectModelTaskRequired(w http.ResponseWriter, r *http.Request) {
	FailWithStatus(w, http.StatusConflict, "AI生成将在项目积分任务接入后开放，当前可免费进行制作筹备")
}

func ProjectWorkflowInspectionPending(w http.ResponseWriter, r *http.Request) {
	FailWithStatus(w, http.StatusConflict, "项目工作流通道尚未开放，暂不能执行Bridge工作流检查")
}
