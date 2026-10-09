package router

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestProductionCanvasDocuments(t *testing.T) {
	const marker = "PRODUCTION_DOCUMENT_TEST_CHILD"
	if os.Getenv(marker) != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestProductionCanvasDocuments$", "-test.timeout=55s", "-test.v")
		cmd.Env = append(os.Environ(), marker+"=1")
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated document API: %v\n%s", err, output)
		}
		t.Log(string(output))
		return
	}
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: filepath.Join(t.TempDir(), "documents.db"), JWTSecret: "synthetic-u02-secret"}
	gin.SetMode(gin.TestMode)
	gin.DefaultWriter = io.Discard
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	users := []model.User{
		{ID: "u02-manager", Username: "u02-manager", Role: model.UserRoleUser, Status: model.UserStatusActive, CanCreateProjects: true, CanAssignProjects: true},
		{ID: "u02-producer", Username: "u02-producer", Role: model.UserRoleUser, Status: model.UserStatusActive},
		{ID: "u02-other", Username: "u02-other", Role: model.UserRoleUser, Status: model.UserStatusActive},
		{ID: "u02-admin", Username: "u02-admin", Role: model.UserRoleAdmin, Status: model.UserStatusActive},
	}
	for i := range users {
		users[i].AffCode = users[i].ID
	}
	if err := db.Create(&users).Error; err != nil {
		t.Fatal(err)
	}
	tokens := make([]string, len(users))
	for i, user := range users {
		tokens[i], err = jwt.NewWithClaims(jwt.SigningMethodHS256, service.TokenClaims{UserID: user.ID, Username: user.Username, Role: user.Role, RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}}).SignedString([]byte(config.Cfg.JWTSecret))
		if err != nil {
			t.Fatal(err)
		}
	}
	router := New()
	request := func(t *testing.T, method, path, token string, body any, status int) json.RawMessage {
		t.Helper()
		encoded, _ := json.Marshal(body)
		r := httptest.NewRequest(method, path, bytes.NewReader(encoded))
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s %s: status %d want %d: %s", method, path, w.Code, status, w.Body.String())
		}
		var response struct {
			Code int             `json:"code"`
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if status == 200 && response.Code != 0 {
			t.Fatalf("unsuccessful response: %s", w.Body.String())
		}
		return response.Data
	}
	type parallelResult struct {
		Status int
		Body   []byte
	}
	parallel := func(method, path, token string, bodies []map[string]any) []parallelResult {
		results := make([]parallelResult, len(bodies))
		var wg sync.WaitGroup
		for i, body := range bodies {
			wg.Add(1)
			go func(i int, body map[string]any) {
				defer wg.Done()
				encoded, _ := json.Marshal(body)
				r := httptest.NewRequest(method, path, bytes.NewReader(encoded))
				r.Header.Set("Authorization", "Bearer "+token)
				r.Header.Set("Content-Type", "application/json")
				w := httptest.NewRecorder()
				router.ServeHTTP(w, r)
				results[i] = parallelResult{w.Code, w.Body.Bytes()}
			}(i, body)
		}
		wg.Wait()
		return results
	}
	var project struct {
		ID         string                      `json:"id"`
		Workspaces []model.ProductionWorkspace `json:"workspaces"`
	}
	json.Unmarshal(request(t, "POST", "/api/v1/production/projects", tokens[0], map[string]any{"title": "文档项目", "producerId": users[1].ID, "requestId": uuid.NewString()}, 200), &project)
	base := "/api/v1/production/projects/" + project.ID + "/workspaces/canvas/documents"
	content := map[string]any{"schemaVersion": 1, "nodes": []any{}, "connections": []any{}, "viewport": map[string]any{"x": 0, "y": 0, "k": 1}, "backgroundMode": "dots"}
	request(t, "POST", "/api/v1/canvas/projects", tokens[1], map[string]any{"data": map[string]any{"id": "u02-personal-canary", "title": "个人记录保持原状", "createdAt": "2026-10-09T00:00:00Z", "updatedAt": "2026-10-09T00:00:00Z", "nodes": []any{}}}, 200)
	personalBefore := request(t, "GET", "/api/v1/canvas/projects", tokens[1], nil, 200)
	var doc struct {
		ID          string          `json:"id"`
		ProjectID   string          `json:"projectId"`
		WorkspaceID string          `json:"workspaceId"`
		Title       string          `json:"title"`
		Revision    int64           `json:"revision"`
		Content     json.RawMessage `json:"content"`
	}
	t.Run("assigned-producer-creates-and-reopens-project-document", func(t *testing.T) {
		body := map[string]any{"title": "  第一个画布  ", "content": content, "requestId": uuid.NewString()}
		json.Unmarshal(request(t, "POST", base, tokens[1], body, 200), &doc)
		if doc.ID == "" || doc.ProjectID != project.ID || doc.Title != "第一个画布" || doc.Revision != 1 {
			t.Fatalf("bad created document: %+v", doc)
		}
		var workspaceID string
		for _, w := range project.Workspaces {
			if w.Kind == "canvas" {
				workspaceID = w.ID
			}
		}
		if doc.WorkspaceID != workspaceID {
			t.Fatal("document did not inherit canvas workspace")
		}
		var opened map[string]any
		json.Unmarshal(request(t, "GET", base+"/"+doc.ID, tokens[0], nil, 200), &opened)
		if opened["title"] != "第一个画布" || opened["content"].(map[string]any)["backgroundMode"] != "dots" {
			t.Fatalf("stored document not reopened: %+v", opened)
		}
		var listed struct {
			Items []map[string]any `json:"items"`
			Total int              `json:"total"`
		}
		json.Unmarshal(request(t, "GET", base, tokens[1], nil, 200), &listed)
		if listed.Total != 1 || len(listed.Items) != 1 || listed.Items[0]["id"] != doc.ID {
			t.Fatalf("list missing document: %+v", listed)
		}
		if _, ok := listed.Items[0]["content"]; ok {
			t.Fatal("list included document body")
		}
	})
	t.Run("save-is-conditional-and-unknown-response-retries-once", func(t *testing.T) {
		content["nodes"] = []any{map[string]any{"id": "text-1", "type": "text", "title": "文本", "position": map[string]any{"x": 12, "y": 34}, "width": 240, "height": 160, "metadata": map[string]any{"content": "服务端保存的台词", "fontSize": 16}}}
		body := map[string]any{"title": "保存后的画布", "content": content, "revision": 1, "requestId": uuid.NewString()}
		var receipt map[string]any
		json.Unmarshal(request(t, "PUT", base+"/"+doc.ID, tokens[1], body, 200), &receipt)
		if receipt["revision"] != float64(2) || receipt["requestId"] != body["requestId"] || receipt["content"] != nil {
			t.Fatalf("invalid save acknowledgement: %+v", receipt)
		}
		var opened map[string]any
		json.Unmarshal(request(t, "GET", base+"/"+doc.ID, tokens[0], nil, 200), &opened)
		if opened["revision"] != float64(2) || opened["title"] != "保存后的画布" {
			t.Fatalf("save was not persisted: %+v", opened)
		}
		if opened["content"].(map[string]any)["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)["content"] != "服务端保存的台词" {
			t.Fatal("node content lost")
		}
		request(t, "PUT", base+"/"+doc.ID, tokens[0], map[string]any{"title": "过期覆盖", "content": content, "revision": 1, "requestId": uuid.NewString()}, 409)
		request(t, "PUT", base+"/"+doc.ID, tokens[1], body, 200)
		request(t, "PUT", base+"/"+doc.ID, tokens[1], map[string]any{"title": "同键不同内容", "content": content, "revision": 1, "requestId": body["requestId"]}, 409)
		request(t, "PUT", base+"/"+doc.ID, tokens[0], map[string]any{"title": "新版本", "content": content, "revision": 2, "requestId": uuid.NewString()}, 200)
		json.Unmarshal(request(t, "PUT", base+"/"+doc.ID, tokens[1], body, 200), &receipt)
		if receipt["revision"] != float64(2) {
			t.Fatal("retry did not replay original receipt")
		}
		json.Unmarshal(request(t, "GET", base+"/"+doc.ID, tokens[1], nil, 200), &opened)
		if opened["revision"] != float64(3) || opened["title"] != "新版本" {
			t.Fatal("retry overwrote a later version")
		}
	})
	t.Run("twenty-retries-create-one-document", func(t *testing.T) {
		body := map[string]any{"title": "幂等创建", "content": content, "requestId": uuid.NewString()}
		bodies := make([]map[string]any, 20)
		for i := range bodies {
			bodies[i] = body
		}
		results := parallel("POST", base, tokens[1], bodies)
		ids := map[string]bool{}
		for _, result := range results {
			var response struct {
				Data struct {
					ID string `json:"id"`
				} `json:"data"`
			}
			json.Unmarshal(result.Body, &response)
			if result.Status != 200 {
				t.Fatalf("concurrent creation failed: %s", result.Body)
			}
			ids[response.Data.ID] = true
		}
		if len(ids) != 1 {
			t.Fatalf("same creation request created %d documents", len(ids))
		}
		request(t, "POST", base, tokens[1], map[string]any{"title": "不同创建内容", "content": content, "requestId": body["requestId"]}, 409)
	})
	t.Run("canvas-content-accepts-only-bounded-text-and-group-snapshots", func(t *testing.T) {
		invalid := map[string]func(map[string]any){
			"image node": func(c map[string]any) { c["nodes"].([]any)[0].(map[string]any)["type"] = "image" },
			"unknown metadata": func(c map[string]any) {
				c["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)["storageKey"] = "foreign-file"
			},
			"unknown snapshot field": func(c map[string]any) { c["model"] = "not-executed" },
			"unknown schema":         func(c map[string]any) { c["schemaVersion"] = 2 },
			"null nodes":             func(c map[string]any) { c["nodes"] = nil },
			"duplicate node":         func(c map[string]any) { n := c["nodes"].([]any)[0]; c["nodes"] = []any{n, n} },
			"missing edge target": func(c map[string]any) {
				c["connections"] = []any{map[string]any{"id": "line-1", "fromNodeId": "text-1", "toNodeId": "absent"}}
			},
			"missing group": func(c map[string]any) {
				c["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)["groupId"] = "absent"
			},
			"non-group parent": func(c map[string]any) {
				c["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)["groupId"] = "text-1"
			},
			"oversized coordinate": func(c map[string]any) {
				c["nodes"].([]any)[0].(map[string]any)["position"].(map[string]any)["x"] = 1000001
			},
			"missing position": func(c map[string]any) { delete(c["nodes"].([]any)[0].(map[string]any), "position") },
			"invalid width":    func(c map[string]any) { c["nodes"].([]any)[0].(map[string]any)["width"] = 0 },
			"invalid fontsize": func(c map[string]any) {
				c["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)["fontSize"] = 129
			},
			"invalid zoom":       func(c map[string]any) { c["viewport"].(map[string]any)["k"] = 0 },
			"unknown background": func(c map[string]any) { c["backgroundMode"] = "none" },
		}
		for name, change := range invalid {
			t.Run(name, func(t *testing.T) {
				encoded, _ := json.Marshal(content)
				var candidate map[string]any
				json.Unmarshal(encoded, &candidate)
				change(candidate)
				request(t, "POST", base, tokens[1], map[string]any{"title": "非法正文", "content": candidate, "requestId": uuid.NewString()}, 400)
			})
		}
	})
	t.Run("twenty-saves-commit-once-and-twenty-competing-versions-conflict", func(t *testing.T) {
		var target struct {
			ID string `json:"id"`
		}
		json.Unmarshal(request(t, "POST", base, tokens[1], map[string]any{"title": "并发保存", "content": content, "requestId": uuid.NewString()}, 200), &target)
		body := map[string]any{"title": "单次保存", "content": content, "revision": 1, "requestId": uuid.NewString()}
		bodies := make([]map[string]any, 20)
		for i := range bodies {
			bodies[i] = body
		}
		for _, result := range parallel("PUT", base+"/"+target.ID, tokens[1], bodies) {
			var response struct {
				Data struct {
					Revision int `json:"revision"`
				} `json:"data"`
			}
			json.Unmarshal(result.Body, &response)
			if result.Status != 200 || response.Data.Revision != 2 {
				t.Fatalf("retry failed: %s", result.Body)
			}
		}
		for i := range bodies {
			bodies[i] = map[string]any{"title": fmt.Sprintf("竞争版本%d", i), "content": content, "revision": 2, "requestId": uuid.NewString()}
		}
		success, conflict := 0, 0
		for _, result := range parallel("PUT", base+"/"+target.ID, tokens[1], bodies) {
			switch result.Status {
			case 200:
				success++
			case 409:
				conflict++
			default:
				t.Fatalf("unexpected competing result: %s", result.Body)
			}
		}
		if success != 1 || conflict != 19 {
			t.Fatalf("competing writes: success %d conflict %d", success, conflict)
		}
		var reopened struct {
			Revision int `json:"revision"`
		}
		json.Unmarshal(request(t, "GET", base+"/"+target.ID, tokens[1], nil, 200), &reopened)
		if reopened.Revision != 3 {
			t.Fatalf("retries incremented version: %d", reopened.Revision)
		}
	})
	t.Run("every-document-operation-enforces-project-and-workspace-membership", func(t *testing.T) {
		for _, token := range []string{"", tokens[2], tokens[3]} {
			status := 404
			if token == "" {
				status = 401
			}
			request(t, "GET", base, token, nil, status)
			request(t, "GET", base+"/"+doc.ID, token, nil, status)
			request(t, "POST", base, token, map[string]any{"title": "禁止创建", "content": content, "requestId": uuid.NewString()}, status)
			request(t, "PUT", base+"/"+doc.ID, token, map[string]any{"title": "禁止保存", "content": content, "revision": 3, "requestId": uuid.NewString()}, status)
		}
		wrongWorkspace := strings.Replace(base, "/canvas/", "/assets/", 1)
		request(t, "GET", wrongWorkspace, tokens[1], nil, 400)
		request(t, "GET", wrongWorkspace+"/"+doc.ID, tokens[1], nil, 400)
		var otherProject struct {
			ID string `json:"id"`
		}
		json.Unmarshal(request(t, "POST", "/api/v1/production/projects", tokens[0], map[string]any{"title": "另一项目", "producerId": users[2].ID, "requestId": uuid.NewString()}, 200), &otherProject)
		otherBase := "/api/v1/production/projects/" + otherProject.ID + "/workspaces/canvas/documents"
		request(t, "GET", otherBase, tokens[1], nil, 404)
		request(t, "GET", otherBase+"/"+doc.ID, tokens[0], nil, 404)
		request(t, "PUT", otherBase+"/"+doc.ID, tokens[0], map[string]any{"title": "跨项目覆盖", "content": content, "revision": 3, "requestId": uuid.NewString()}, 404)
		request(t, "GET", base+"/unknown", tokens[1], nil, 404)
	})
	t.Run("document-and-request-receipt-roll-back-together", func(t *testing.T) {
		var before struct {
			Total int `json:"total"`
		}
		json.Unmarshal(request(t, "GET", base, tokens[1], nil, 200), &before)
		create := map[string]any{"title": "失败后重试创建", "content": content, "requestId": uuid.NewString()}
		trigger := fmt.Sprintf("CREATE TRIGGER u02_create_failure BEFORE INSERT ON canvas_document_requests WHEN NEW.request_id = '%s' BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END", create["requestId"])
		if err := db.Exec(trigger).Error; err != nil {
			t.Fatal(err)
		}
		request(t, "POST", base, tokens[1], create, 500)
		var after struct {
			Total int `json:"total"`
		}
		json.Unmarshal(request(t, "GET", base, tokens[1], nil, 200), &after)
		if before.Total != after.Total {
			t.Fatal("failed creation left a document")
		}
		if err := db.Exec("DROP TRIGGER u02_create_failure").Error; err != nil {
			t.Fatal(err)
		}
		var target struct {
			ID string `json:"id"`
		}
		json.Unmarshal(request(t, "POST", base, tokens[1], create, 200), &target)
		request(t, "POST", base, tokens[1], create, 200)
		save := map[string]any{"title": "失败后重试保存", "content": content, "revision": 1, "requestId": uuid.NewString()}
		trigger = fmt.Sprintf("CREATE TRIGGER u02_save_failure BEFORE INSERT ON canvas_document_requests WHEN NEW.request_id = '%s' BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END", save["requestId"])
		if err := db.Exec(trigger).Error; err != nil {
			t.Fatal(err)
		}
		request(t, "PUT", base+"/"+target.ID, tokens[1], save, 500)
		var opened struct {
			Revision int    `json:"revision"`
			Title    string `json:"title"`
		}
		json.Unmarshal(request(t, "GET", base+"/"+target.ID, tokens[1], nil, 200), &opened)
		if opened.Revision != 1 || opened.Title != "失败后重试创建" {
			t.Fatalf("failed save changed document: %+v", opened)
		}
		if err := db.Exec("DROP TRIGGER u02_save_failure").Error; err != nil {
			t.Fatal(err)
		}
		request(t, "PUT", base+"/"+target.ID, tokens[1], save, 200)
		request(t, "PUT", base+"/"+target.ID, tokens[1], save, 200)
		json.Unmarshal(request(t, "GET", base+"/"+target.ID, tokens[1], nil, 200), &opened)
		if opened.Revision != 2 || opened.Title != "失败后重试保存" {
			t.Fatalf("same-key recovery failed: %+v", opened)
		}
	})
	t.Run("reassignment-and-ban-revoke-access-including-idempotent-replays", func(t *testing.T) {
		var targetProject struct {
			ID string `json:"id"`
		}
		json.Unmarshal(request(t, "POST", "/api/v1/production/projects", tokens[0], map[string]any{"title": "改派撤权", "producerId": users[1].ID, "requestId": uuid.NewString()}, 200), &targetProject)
		targetBase := "/api/v1/production/projects/" + targetProject.ID + "/workspaces/canvas/documents"
		create := map[string]any{"title": "改派前文档", "content": content, "requestId": uuid.NewString()}
		var target struct {
			ID string `json:"id"`
		}
		json.Unmarshal(request(t, "POST", targetBase, tokens[1], create, 200), &target)
		save := map[string]any{"title": "改派前保存", "content": content, "revision": 1, "requestId": uuid.NewString()}
		request(t, "PUT", targetBase+"/"+target.ID, tokens[1], save, 200)
		request(t, "POST", "/api/v1/production/projects/"+targetProject.ID+"/assignment", tokens[0], map[string]any{"producerId": users[2].ID, "revision": 1}, 200)
		request(t, "GET", targetBase, tokens[1], nil, 404)
		request(t, "GET", targetBase+"/"+target.ID, tokens[1], nil, 404)
		request(t, "POST", targetBase, tokens[1], create, 404)
		request(t, "PUT", targetBase+"/"+target.ID, tokens[1], save, 404)
		request(t, "POST", targetBase, tokens[1], map[string]any{"title": "撤权后创建", "content": content, "requestId": uuid.NewString()}, 404)
		request(t, "PUT", targetBase+"/"+target.ID, tokens[1], map[string]any{"title": "撤权后写入", "content": content, "revision": 2, "requestId": uuid.NewString()}, 404)
		var opened struct {
			Title    string `json:"title"`
			Revision int    `json:"revision"`
		}
		json.Unmarshal(request(t, "GET", targetBase+"/"+target.ID, tokens[2], nil, 200), &opened)
		if opened.Title != "改派前保存" || opened.Revision != 2 {
			t.Fatal("reassignment lost the project document")
		}
		newSave := map[string]any{"title": "新负责人保存", "content": content, "revision": 2, "requestId": uuid.NewString()}
		request(t, "PUT", targetBase+"/"+target.ID, tokens[2], newSave, 200)
		request(t, "POST", "/api/admin/users", tokens[3], map[string]any{"id": users[2].ID, "username": users[2].Username, "role": "user", "status": "ban"}, 200)
		request(t, "GET", targetBase, tokens[2], nil, 401)
		request(t, "GET", targetBase+"/"+target.ID, tokens[2], nil, 401)
		request(t, "POST", targetBase, tokens[2], create, 401)
		request(t, "PUT", targetBase+"/"+target.ID, tokens[2], newSave, 401)
		request(t, "POST", "/api/admin/users", tokens[3], map[string]any{"id": users[2].ID, "username": users[2].Username, "role": "user", "status": "active"}, 200)
	})
	t.Run("strict-input-limits-and-group-references", func(t *testing.T) {
		clone := func() map[string]any {
			encoded, _ := json.Marshal(content)
			var result map[string]any
			json.Unmarshal(encoded, &result)
			return result
		}
		for _, change := range []func(map[string]any){
			func(b map[string]any) { b["projectId"] = "foreign" }, func(b map[string]any) { b["workspaceId"] = "foreign" }, func(b map[string]any) { b["createdBy"] = users[0].ID }, func(b map[string]any) { b["updatedAt"] = "2099" }, func(b map[string]any) { b["title"] = "\n" }, func(b map[string]any) { b["title"] = strings.Repeat("画", 81) }, func(b map[string]any) { b["requestId"] = "not-a-uuid" }, func(b map[string]any) { b["requestId"] = "00000000-0000-0000-0000-000000000000" },
		} {
			body := map[string]any{"title": "验证", "content": content, "requestId": uuid.NewString()}
			change(body)
			request(t, "POST", base, tokens[1], body, 400)
		}
		request(t, "GET", base+"?page=0", tokens[1], nil, 400)
		request(t, "GET", base+"?pageSize=501", tokens[1], nil, 400)
		tooLarge := clone()
		tooLarge["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)["content"] = strings.Repeat("x", 2<<20)
		request(t, "POST", base, tokens[1], map[string]any{"title": "超大正文", "content": tooLarge, "requestId": uuid.NewString()}, 413)
		grouped := clone()
		group := map[string]any{"id": "group-1", "type": "group", "title": "分组", "position": map[string]any{"x": -50, "y": -50}, "width": 600, "height": 400, "metadata": map[string]any{}}
		grouped["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)["groupId"] = "group-1"
		grouped["nodes"] = append(grouped["nodes"].([]any), group)
		grouped["connections"] = []any{map[string]any{"id": "line-1", "fromNodeId": "group-1", "toNodeId": "text-1"}}
		grouped["backgroundMode"] = "blank"
		var target struct {
			ID string `json:"id"`
		}
		json.Unmarshal(request(t, "POST", base, tokens[1], map[string]any{"title": "合法分组", "content": grouped, "requestId": uuid.NewString()}, 200), &target)
		request(t, "GET", base+"/"+target.ID, tokens[1], nil, 200)
		group["metadata"].(map[string]any)["groupId"] = "group-1"
		request(t, "POST", base, tokens[1], map[string]any{"title": "非法组循环", "content": grouped, "requestId": uuid.NewString()}, 400)
		many := clone()
		nodes := make([]any, 300)
		for i := range nodes {
			nodes[i] = map[string]any{"id": fmt.Sprintf("n%d", i), "type": "text", "title": "", "position": map[string]any{"x": i, "y": 0}, "width": 16, "height": 16}
		}
		many["nodes"] = nodes
		connections := make([]any, 600)
		for i := range connections {
			connections[i] = map[string]any{"id": fmt.Sprintf("e%d", i), "fromNodeId": "n0", "toNodeId": "n1"}
		}
		many["connections"] = connections
		request(t, "POST", base, tokens[1], map[string]any{"title": "容量边界", "content": many, "requestId": uuid.NewString()}, 200)
		many["nodes"] = append(nodes, map[string]any{"id": "n300", "type": "text", "title": "", "position": map[string]any{"x": 0, "y": 0}, "width": 16, "height": 16})
		request(t, "POST", base, tokens[1], map[string]any{"title": "节点超限", "content": many, "requestId": uuid.NewString()}, 400)
		many["nodes"] = nodes
		many["connections"] = append(connections, map[string]any{"id": "e600", "fromNodeId": "n0", "toNodeId": "n1"})
		request(t, "POST", base, tokens[1], map[string]any{"title": "连线超限", "content": many, "requestId": uuid.NewString()}, 400)
	})
	t.Run("personal-documents-are-not-migrated-or-modified", func(t *testing.T) {
		personalAfter := request(t, "GET", "/api/v1/canvas/projects", tokens[1], nil, 200)
		if !bytes.Equal(personalBefore, personalAfter) {
			t.Fatal("project document operations changed personal records")
		}
		request(t, "GET", base+"/u02-personal-canary", tokens[1], nil, 404)
	})
	t.Run("document-and-save-receipt-survive-closed-database-and-new-process", func(t *testing.T) {
		var target struct {
			ID string `json:"id"`
		}
		json.Unmarshal(request(t, "POST", base, tokens[1], map[string]any{"title": "重启前创建", "content": content, "requestId": uuid.NewString()}, 200), &target)
		body := map[string]any{"title": "重启后仍可读取", "content": content, "revision": 1, "requestId": uuid.NewString()}
		request(t, "PUT", base+"/"+target.ID, tokens[1], body, 200)
		encoded, _ := json.Marshal(body)
		conn, err := db.DB()
		if err != nil {
			t.Fatal(err)
		}
		if err := conn.Close(); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(os.Args[0], "-test.run=^TestProductionCanvasDocumentReopen$", "-test.timeout=15s", "-test.v")
		cmd.Env = append(os.Environ(), "U02_REOPEN_DB="+config.Cfg.DatabaseDSN, "U02_REOPEN_PATH="+base+"/"+target.ID, "U02_REOPEN_TOKEN="+tokens[1], "U02_REOPEN_BODY="+string(encoded))
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("reopened process: %v\n%s", err, output)
		}
		t.Log(string(output))
	})
}

func TestProductionCanvasDocumentReopen(t *testing.T) {
	path := os.Getenv("U02_REOPEN_DB")
	if path == "" {
		t.Skip("invoked by isolated document persistence test")
	}
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: path, JWTSecret: "synthetic-u02-secret"}
	gin.SetMode(gin.TestMode)
	gin.DefaultWriter = io.Discard
	router := New()
	for _, method := range []string{"GET", "PUT", "GET"} {
		r := httptest.NewRequest(method, os.Getenv("U02_REOPEN_PATH"), strings.NewReader(os.Getenv("U02_REOPEN_BODY")))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+os.Getenv("U02_REOPEN_TOKEN"))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("restart %s: %s", method, w.Body.String())
		}
		var response struct {
			Data struct {
				Title    string         `json:"title"`
				Revision int            `json:"revision"`
				Content  map[string]any `json:"content"`
			} `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if response.Data.Revision != 2 {
			t.Fatal("restart lost version or replay added a write")
		}
		if method == "GET" {
			if response.Data.Title != "重启后仍可读取" {
				t.Fatal("restart lost title")
			}
			if response.Data.Content["nodes"].([]any)[0].(map[string]any)["metadata"].(map[string]any)["content"] != "服务端保存的台词" {
				t.Fatal("restart lost content")
			}
		}
	}
}
