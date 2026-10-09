package handler

import (
	"encoding/json"
	"github.com/tigerowo/infinite-canvas/service"
	"io"
	"net/http"
)

func UserAutoDLWorkflows(w http.ResponseWriter, r *http.Request) {
	if rejectRetiredModelConnection(w, r) {
		return
	}
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		FailWithStatus(w, http.StatusUnauthorized, "请先登录")
		return
	}
	var input struct {
		ChannelID  string `json:"channelId"`
		WorkflowID string `json:"workflowId,omitempty"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF {
		Fail(w, "模型发现参数无效，仅可选择后台渠道")
		return
	}
	result, err := service.UserAutoDLWorkflows(user, input.ChannelID, input.WorkflowID)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, result)
}
