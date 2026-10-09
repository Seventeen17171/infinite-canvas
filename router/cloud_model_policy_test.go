package router

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCloudModelPolicyRemovedRoutes(t *testing.T) {
	r := New()
	for _, entry := range []struct{ method, path string }{
		{"POST", "/api/ai/direct-request"}, {"POST", "/api/ai/autodl/workflows"}, {"POST", "/api/v1/user-config/model"}, {"POST", "/api/v1/ai-logs"}, {"POST", "/api/v1/workflow-providers/runninghub/inspect"}, {"GET", "/api/v1/comfy-bridges"}, {"POST", "/api/v1/comfy-bridges"}, {"POST", "/api/v1/comfy-bridges/inspect"}, {"DELETE", "/api/v1/comfy-bridges/old"},
	} {
		t.Run(entry.method+entry.path, func(t *testing.T) {
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest(entry.method, entry.path, strings.NewReader(`{"apiKey":"legacy"}`)))
			if w.Code != http.StatusNotFound {
				t.Fatalf("retired route status=%d", w.Code)
			}
		})
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("POST", "/api/v1/model-channels/autodl/workflows", strings.NewReader(`{"channelId":"cloud"}`)))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("discovery lacks authentication: %d", w.Code)
	}
}
