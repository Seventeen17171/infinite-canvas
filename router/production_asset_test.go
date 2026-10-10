package router

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http/httptest"
	"net/url"
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

func TestProductionAssets(t *testing.T) {
	const marker = "PRODUCTION_ASSET_TEST_CHILD"
	if os.Getenv(marker) != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestProductionAssets$", "-test.timeout=55s", "-test.v")
		cmd.Env = append(os.Environ(), marker+"=1")
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated asset API: %v\n%s", err, output)
		}
		t.Log(string(output))
		return
	}
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: filepath.Join(t.TempDir(), "assets.db"), JWTSecret: "synthetic-u03a-secret"}
	gin.SetMode(gin.TestMode)
	gin.DefaultWriter = io.Discard
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	users := []model.User{
		{ID: "u03a-creator", Username: "u03a-creator", Role: model.UserRoleUser, Status: model.UserStatusActive, CanAssignProjects: true},
		{ID: "u03a-producer", Username: "u03a-producer", Role: model.UserRoleUser, Status: model.UserStatusActive},
		{ID: "u03a-other", Username: "u03a-other", Role: model.UserRoleUser, Status: model.UserStatusActive},
		{ID: "u03a-admin", Username: "u03a-admin", Role: model.UserRoleAdmin, Status: model.UserStatusActive},
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
	raw := func(method, path, token string, body []byte) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	hit := func(t *testing.T, method, path, token string, body any, status int, target any) {
		t.Helper()
		encoded, _ := json.Marshal(body)
		w := raw(method, path, token, encoded)
		if w.Code != status {
			t.Fatalf("%s %s status %d want %d: %s", method, path, w.Code, status, w.Body.String())
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
		if target != nil {
			if err := json.Unmarshal(response.Data, target); err != nil {
				t.Fatal(err)
			}
		}
	}
	createProject := func(producer string) string {
		var project model.ProductionProject
		hit(t, "POST", "/api/v1/production/projects", tokens[0], map[string]any{"title": "合成资产项目", "producerId": producer, "requestId": uuid.NewString()}, 200, &project)
		return project.ID
	}
	projectID := createProject(users[1].ID)
	base := "/api/v1/production/projects/" + projectID + "/assets"
	otherBase := "/api/v1/production/projects/" + createProject(users[2].ID) + "/assets"
	create := func(category, name, description string) map[string]any {
		return map[string]any{"category": category, "name": name, "description": description, "requestId": uuid.NewString()}
	}
	save := func(name, description string, revision int) map[string]any {
		return map[string]any{"name": name, "description": description, "revision": revision, "requestId": uuid.NewString()}
	}
	var asset model.ProductionAsset
	var initialBody = create("character", "  林舟  ", "人物设定\n第一行\t第二行")
	t.Run("create-edit-reopen-without-approved-budget-and-stable-project-ownership", func(t *testing.T) {
		hit(t, "POST", base, tokens[1], initialBody, 200, &asset)
		if asset.ID == "" || asset.ProjectID != projectID || asset.Name != "林舟" || asset.Revision != 1 || asset.Category != "character" || asset.CreatedBy != users[1].ID {
			t.Fatalf("bad asset: %+v", asset)
		}
		var reopened model.ProductionAsset
		hit(t, "GET", base+"/"+asset.ID, tokens[0], nil, 200, &reopened)
		if reopened != asset {
			t.Fatal("reopened asset differs")
		}
		body := save("林舟（青年）", "", 1)
		var receipt model.ProductionAssetSaveReceipt
		hit(t, "PUT", base+"/"+asset.ID, tokens[0], body, 200, &receipt)
		if receipt.ID != asset.ID || receipt.Revision != 2 || receipt.RequestID != body["requestId"] || receipt.ProjectID != projectID {
			t.Fatalf("bad receipt: %+v", receipt)
		}
		hit(t, "GET", base+"/"+asset.ID, tokens[1], nil, 200, &reopened)
		if reopened.Name != "林舟（青年）" || reopened.Description != "" || reopened.UpdatedBy != users[0].ID || reopened.Revision != 2 {
			t.Fatalf("save lost: %+v", reopened)
		}
		hit(t, "POST", base, tokens[1], initialBody, 200, &reopened)
		if reopened.ID != asset.ID || reopened.Revision != 2 {
			t.Fatal("create replay duplicated or rewound later edit")
		}
		var budgets int64
		if err := db.Model(&model.ProductionProjectBudget{}).Count(&budgets).Error; err != nil || budgets != 0 {
			t.Fatal("free prep created or required a budget")
		}
	})
	t.Run("list-counts-category-literal-search-and-pagination", func(t *testing.T) {
		hit(t, "POST", base, tokens[1], create("scene", "车站", "黎明光线，标牌A_100%!"), 200, nil)
		hit(t, "POST", base, tokens[1], create("character", "阿宁", "安静的旅客"), 200, nil)
		var list model.ProductionAssetList
		hit(t, "GET", base+"?category=scene&q="+url.QueryEscape("A_100%!"), tokens[1], nil, 200, &list)
		if list.Total != 1 || len(list.Items) != 1 || list.Counts.Character != 2 || list.Counts.Scene != 1 {
			t.Fatalf("bad filtered list/counts: %+v", list)
		}
		hit(t, "GET", base+"?q="+url.QueryEscape("不存在%"), tokens[1], nil, 200, &list)
		if list.Total != 0 || len(list.Items) != 0 || list.Counts.Character != 2 {
			t.Fatal("wildcard search escaped incorrectly")
		}
		hit(t, "GET", base+"?page=1&pageSize=2", tokens[1], nil, 200, &list)
		if list.Total != 3 || len(list.Items) != 2 {
			t.Fatal("pagination first page failed")
		}
		ids := map[string]bool{}
		for _, item := range list.Items {
			ids[item.ID] = true
		}
		hit(t, "GET", base+"?page=2&pageSize=2", tokens[1], nil, 200, &list)
		if len(list.Items) != 1 || ids[list.Items[0].ID] {
			t.Fatal("pagination duplicates or omits records")
		}
		hit(t, "GET", otherBase, tokens[0], nil, 200, &list)
		if list.Total != 0 || list.Counts.Character != 0 || list.Counts.Scene != 0 || list.Items == nil {
			t.Fatal("empty project received foreign counts/data")
		}
	})
	parallel := func(method, path string, bodies []map[string]any) []*httptest.ResponseRecorder {
		results := make([]*httptest.ResponseRecorder, len(bodies))
		var wg sync.WaitGroup
		for i, body := range bodies {
			wg.Add(1)
			go func(i int, body map[string]any) {
				defer wg.Done()
				encoded, _ := json.Marshal(body)
				results[i] = raw(method, path, tokens[1], encoded)
			}(i, body)
		}
		wg.Wait()
		return results
	}
	t.Run("twenty-create-retries-one-record-and-idempotency-scope-conflicts", func(t *testing.T) {
		body := create("scene", "幂等场景", "")
		bodies := make([]map[string]any, 20)
		for i := range bodies {
			bodies[i] = body
		}
		ids := map[string]bool{}
		for _, w := range parallel("POST", base, bodies) {
			if w.Code != 200 {
				t.Fatalf("parallel create: %s", w.Body.String())
			}
			var response struct {
				Data model.ProductionAsset `json:"data"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			ids[response.Data.ID] = true
		}
		if len(ids) != 1 || ids[""] {
			t.Fatalf("created %d identities", len(ids))
		}
		changed := create("scene", "不同内容", "")
		changed["requestId"] = body["requestId"]
		hit(t, "POST", base, tokens[1], changed, 409, nil)
		// The same actor cannot recycle a request ID in another authorized project or operation.
		creatorBody := create("scene", "请求作用域", "")
		hit(t, "POST", base, tokens[0], creatorBody, 200, nil)
		hit(t, "POST", otherBase, tokens[0], creatorBody, 409, nil)
		saveBody := save("请求作用域", "", 2)
		saveBody["requestId"] = creatorBody["requestId"]
		hit(t, "PUT", base+"/"+asset.ID, tokens[0], saveBody, 409, nil)
	})
	t.Run("twenty-save-retries-and-competing-CAS-versions", func(t *testing.T) {
		var target model.ProductionAsset
		hit(t, "POST", base, tokens[1], create("character", "并发人物", ""), 200, &target)
		body := save("共同保存", "唯一写入", 1)
		bodies := make([]map[string]any, 20)
		for i := range bodies {
			bodies[i] = body
		}
		for _, w := range parallel("PUT", base+"/"+target.ID, bodies) {
			var response struct {
				Data model.ProductionAssetSaveReceipt `json:"data"`
			}
			json.Unmarshal(w.Body.Bytes(), &response)
			if w.Code != 200 || response.Data.Revision != 2 {
				t.Fatalf("parallel save: %s", w.Body.String())
			}
		}
		for i := range bodies {
			bodies[i] = save(fmt.Sprintf("竞争者%d", i), "新版本", 2)
		}
		success, conflict := 0, 0
		for _, w := range parallel("PUT", base+"/"+target.ID, bodies) {
			if w.Code == 200 {
				success++
			} else if w.Code == 409 {
				conflict++
			} else {
				t.Fatalf("unexpected parallel status: %s", w.Body.String())
			}
		}
		if success != 1 || conflict != 19 {
			t.Fatalf("success %d conflict %d", success, conflict)
		}
		var receipt model.ProductionAssetSaveReceipt
		hit(t, "PUT", base+"/"+target.ID, tokens[1], body, 200, &receipt)
		if receipt.Revision != 2 {
			t.Fatal("retry lost original receipt")
		}
		hit(t, "GET", base+"/"+target.ID, tokens[1], nil, 200, &target)
		if target.Revision != 3 || target.Description != "新版本" {
			t.Fatal("old replay overwrote later version")
		}
		body["description"] = "异内容"
		hit(t, "PUT", base+"/"+target.ID, tokens[1], body, 409, nil)
	})
	t.Run("all-operations-enforce-project-and-asset-scope", func(t *testing.T) {
		for _, token := range []string{"", tokens[2], tokens[3]} {
			status := 404
			if token == "" {
				status = 401
			}
			hit(t, "GET", base, token, nil, status, nil)
			hit(t, "GET", base+"/"+asset.ID, token, nil, status, nil)
			hit(t, "POST", base, token, initialBody, status, nil)
			hit(t, "PUT", base+"/"+asset.ID, token, save("越权", "", 2), status, nil)
		}
		hit(t, "GET", otherBase+"/"+asset.ID, tokens[0], nil, 404, nil)
		hit(t, "PUT", otherBase+"/"+asset.ID, tokens[0], save("跨项目覆盖", "", 2), 404, nil)
		hit(t, "GET", base+"/missing", tokens[1], nil, 404, nil)
	})
	t.Run("asset-and-receipt-rollback-atomically-and-retry", func(t *testing.T) {
		var before, after model.ProductionAssetList
		hit(t, "GET", base, tokens[1], nil, 200, &before)
		body := create("character", "回滚前创建", "原描述")
		trigger := fmt.Sprintf("CREATE TRIGGER u03a_fail BEFORE INSERT ON production_asset_requests WHEN NEW.request_id = '%s' BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END", body["requestId"])
		if err := db.Exec(trigger).Error; err != nil {
			t.Fatal(err)
		}
		hit(t, "POST", base, tokens[1], body, 500, nil)
		hit(t, "GET", base, tokens[1], nil, 200, &after)
		if before.Total != after.Total {
			t.Fatal("failed receipt left asset")
		}
		if err := db.Exec("DROP TRIGGER u03a_fail").Error; err != nil {
			t.Fatal(err)
		}
		var target model.ProductionAsset
		hit(t, "POST", base, tokens[1], body, 200, &target)
		update := save("回滚后重试", "新描述", 1)
		trigger = fmt.Sprintf("CREATE TRIGGER u03a_fail BEFORE INSERT ON production_asset_requests WHEN NEW.request_id = '%s' BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END", update["requestId"])
		if err := db.Exec(trigger).Error; err != nil {
			t.Fatal(err)
		}
		hit(t, "PUT", base+"/"+target.ID, tokens[1], update, 500, nil)
		hit(t, "GET", base+"/"+target.ID, tokens[1], nil, 200, &target)
		if target.Revision != 1 || target.Name != "回滚前创建" || target.Description != "原描述" {
			t.Fatal("failed receipt left partial save")
		}
		if err := db.Exec("DROP TRIGGER u03a_fail").Error; err != nil {
			t.Fatal(err)
		}
		hit(t, "PUT", base+"/"+target.ID, tokens[1], update, 200, nil)
		hit(t, "PUT", base+"/"+target.ID, tokens[1], update, 200, nil)
		hit(t, "GET", base+"/"+target.ID, tokens[1], nil, 200, &target)
		if target.Revision != 2 || target.Name != "回滚后重试" {
			t.Fatal("same-key recovery failed")
		}
	})
	t.Run("strict-input-limits-and-immutable-category", func(t *testing.T) {
		for _, change := range []func(map[string]any){
			func(b map[string]any) { b["category"] = "prop" }, func(b map[string]any) { b["name"] = "\n" }, func(b map[string]any) { b["name"] = strings.Repeat("人", 81) }, func(b map[string]any) { b["description"] = strings.Repeat("人", 8001) }, func(b map[string]any) { b["description"] = "非法\x00字符" }, func(b map[string]any) { b["requestId"] = "invalid" }, func(b map[string]any) { b["requestId"] = uuid.Nil.String() }, func(b map[string]any) { b["projectId"] = "foreign" }, func(b map[string]any) { b["workspaceId"] = "foreign" }, func(b map[string]any) { b["createdBy"] = "foreign" },
		} {
			body := create("character", "输入校验", "")
			change(body)
			hit(t, "POST", base, tokens[1], body, 400, nil)
		}
		for _, q := range []string{"page=0", "pageSize=101", "page=1000001", "page=", "page=1&page=2", "category=prop", "extra=true", "q=" + url.QueryEscape(strings.Repeat("人", 81)), "q=%00"} {
			hit(t, "GET", base+"?"+q, tokens[1], nil, 400, nil)
		}
		for _, revision := range []any{0, -1, 9007199254740991, 1.5, "1"} {
			body := save("输入校验", "", 2)
			body["revision"] = revision
			hit(t, "PUT", base+"/"+asset.ID, tokens[1], body, 400, nil)
		}
		body := save("改分类", "", 2)
		body["category"] = "scene"
		hit(t, "PUT", base+"/"+asset.ID, tokens[1], body, 400, nil)
		for _, body := range []string{"null", "[]", "{} {}", "{", "{\"category\":\"character\",\"name\":7}"} {
			if w := raw("POST", base, tokens[1], []byte(body)); w.Code != 400 {
				t.Fatalf("bad JSON accepted: %s", body)
			}
		}
		hit(t, "POST", base, tokens[1], create("scene", "超大", strings.Repeat("x", 256<<10)), 413, nil)
		hit(t, "POST", base, tokens[1], create("scene", strings.Repeat("景", 80), strings.Repeat("🌆", 8000)), 200, nil)
	})
	t.Run("reassignment-and-disabled-account-deny-including-replays", func(t *testing.T) {
		id := createProject(users[1].ID)
		path := "/api/v1/production/projects/" + id + "/assets"
		body := create("character", "改派人物", "")
		var target model.ProductionAsset
		hit(t, "POST", path, tokens[1], body, 200, &target)
		update := save("改派前保存", "", 1)
		hit(t, "PUT", path+"/"+target.ID, tokens[1], update, 200, nil)
		hit(t, "POST", "/api/v1/production/projects/"+id+"/assignment", tokens[0], map[string]any{"producerId": users[2].ID, "revision": 1}, 200, nil)
		hit(t, "GET", path, tokens[1], nil, 404, nil)
		hit(t, "GET", path+"/"+target.ID, tokens[1], nil, 404, nil)
		hit(t, "POST", path, tokens[1], body, 404, nil)
		hit(t, "PUT", path+"/"+target.ID, tokens[1], update, 404, nil)
		hit(t, "GET", path+"/"+target.ID, tokens[0], nil, 200, &target)
		hit(t, "GET", path+"/"+target.ID, tokens[2], nil, 200, &target)
		if target.Revision != 2 {
			t.Fatal("reassignment lost asset")
		}
		update = save("新组长保存", "", 2)
		hit(t, "PUT", path+"/"+target.ID, tokens[2], update, 200, nil)
		hit(t, "POST", "/api/admin/users", tokens[3], map[string]any{"id": users[2].ID, "username": users[2].Username, "role": "user", "status": "ban"}, 200, nil)
		hit(t, "GET", path, tokens[2], nil, 401, nil)
		hit(t, "GET", path+"/"+target.ID, tokens[2], nil, 401, nil)
		hit(t, "POST", path, tokens[2], body, 401, nil)
		hit(t, "PUT", path+"/"+target.ID, tokens[2], update, 401, nil)
	})
	t.Run("asset-and-receipt-survive-database-close-and-process-restart", func(t *testing.T) {
		var target model.ProductionAsset
		hit(t, "POST", base, tokens[1], create("character", "重启前", ""), 200, &target)
		body := save("重启后仍可读取", "完整描述\n保持换行", 1)
		hit(t, "PUT", base+"/"+target.ID, tokens[1], body, 200, nil)
		encoded, _ := json.Marshal(body)
		conn, err := db.DB()
		if err != nil {
			t.Fatal(err)
		}
		if err := conn.Close(); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(os.Args[0], "-test.run=^TestProductionAssetReopen$", "-test.timeout=15s", "-test.v")
		cmd.Env = append(os.Environ(), "U03A_REOPEN_DB="+config.Cfg.DatabaseDSN, "U03A_REOPEN_PATH="+base+"/"+target.ID, "U03A_REOPEN_TOKEN="+tokens[1], "U03A_REOPEN_BODY="+string(encoded))
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("restart process: %v\n%s", err, output)
		}
		t.Log(string(output))
	})
}

func TestProductionAssetReopen(t *testing.T) {
	path := os.Getenv("U03A_REOPEN_DB")
	if path == "" {
		t.Skip("invoked by isolated asset persistence test")
	}
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: path, JWTSecret: "synthetic-u03a-secret"}
	gin.SetMode(gin.TestMode)
	gin.DefaultWriter = io.Discard
	router := New()
	for _, method := range []string{"GET", "PUT", "GET"} {
		r := httptest.NewRequest(method, os.Getenv("U03A_REOPEN_PATH"), strings.NewReader(os.Getenv("U03A_REOPEN_BODY")))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+os.Getenv("U03A_REOPEN_TOKEN"))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("restart %s: %s", method, w.Body.String())
		}
		var response struct {
			Data model.ProductionAsset `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		if response.Data.Revision != 2 {
			t.Fatal("restart lost revision or replay rewrote data")
		}
		if method == "GET" && (response.Data.Name != "重启后仍可读取" || response.Data.Description != "完整描述\n保持换行") {
			t.Fatal("restart lost persisted fields")
		}
	}
}
