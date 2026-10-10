package router

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
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

func TestProductionAssetCreative(t *testing.T) {
	const marker = "PRODUCTION_CREATIVE_TEST_CHILD"
	if os.Getenv(marker) != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestProductionAssetCreative$", "-test.timeout=65s", "-test.v")
		cmd.Env = append(os.Environ(), marker+"=1")
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated creative API: %v\n%s", err, output)
		}
		t.Log(string(output))
		return
	}
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: filepath.Join(t.TempDir(), "creative.db"), JWTSecret: "synthetic-u03b-secret"}
	gin.SetMode(gin.TestMode)
	gin.DefaultWriter = io.Discard
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	users := []model.User{
		{ID: "u03b-creator", Username: "u03b-creator", Role: model.UserRoleUser, Status: model.UserStatusActive, CanAssignProjects: true},
		{ID: "u03b-producer", Username: "u03b-producer", Role: model.UserRoleUser, Status: model.UserStatusActive},
		{ID: "u03b-other", Username: "u03b-other", Role: model.UserRoleUser, Status: model.UserStatusActive},
		{ID: "u03b-admin", Username: "u03b-admin", Role: model.UserRoleAdmin, Status: model.UserStatusActive},
	}
	tokens := make([]string, len(users))
	for i := range users {
		users[i].AffCode = users[i].ID
		tokens[i], err = jwt.NewWithClaims(jwt.SigningMethodHS256, service.TokenClaims{UserID: users[i].ID, Username: users[i].Username, Role: users[i].Role, RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}}).SignedString([]byte(config.Cfg.JWTSecret))
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Create(&users).Error; err != nil {
		t.Fatal(err)
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
		var p model.ProductionProject
		hit(t, "POST", "/api/v1/production/projects", tokens[0], map[string]any{"title": "合成创意项目", "producerId": producer, "requestId": uuid.NewString()}, 200, &p)
		return p.ID
	}
	projectID := createProject(users[1].ID)
	base := "/api/v1/production/projects/" + projectID + "/assets"
	otherBase := "/api/v1/production/projects/" + createProject(users[2].ID) + "/assets"
	createAsset := func(t *testing.T, base string) model.ProductionAsset {
		var asset model.ProductionAsset
		hit(t, "POST", base, tokens[0], map[string]any{"category": "character", "name": "创意人物", "description": "资料保持", "requestId": uuid.NewString()}, 200, &asset)
		return asset
	}
	asset := createAsset(t, base)
	path := base + "/" + asset.ID + "/creative"
	body := func(prompt string, revision int64) map[string]any {
		return map[string]any{"prompt": prompt, "modelChannelId": "", "modelName": "", "aspectRatio": "auto", "resolution": "auto", "imageCount": 1, "revision": revision, "requestId": uuid.NewString()}
	}
	count := func(value any) int64 {
		var n int64
		if err := db.Model(value).Count(&n).Error; err != nil {
			t.Fatal(err)
		}
		return n
	}
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }))
	defer provider.Close()
	channel := func(id string) model.ModelChannel {
		return model.ModelChannel{ID: id, Name: "合成云渠道", Protocol: "openai", Enabled: true, BaseURL: provider.URL, APIKey: "synthetic-secret-never-public", Models: []string{"gpt-image-1", "custom-portrait", "image-text", "not-public", "text-model"}, ModelCapabilities: map[string]string{"custom-portrait": "image", "image-text": "text"}, Remark: "private-remark", ParameterTranslation: ""}
	}
	first, second, disabled, noKey, workflow := channel("cloud-a"), channel("cloud-b"), channel("disabled"), channel("no-key"), channel("workflow")
	second.Models = []string{"gpt-image-1"}
	disabled.Enabled = false
	noKey.APIKey = ""
	workflow.Protocol = "comfyui"
	settings := model.Settings{Public: model.PublicSetting{ModelChannel: model.PublicModelChannelSetting{AvailableModels: []string{"gpt-image-1", "custom-portrait", "image-text", "text-model"}}}, Private: model.PrivateSetting{Channels: []model.ModelChannel{first, second, disabled, noKey, workflow}}}
	saveSettings := func() {
		if _, err := repository.SaveSettings(settings, "synthetic-u03b-time"); err != nil {
			t.Fatal(err)
		}
	}
	saveSettings()
	t.Run("default-read-does-not-write-and-cloud-options-are-safe", func(t *testing.T) {
		var detail model.ProductionAssetCreativeDetail
		hit(t, "GET", path, tokens[1], nil, 200, &detail)
		c := detail.Creative
		if c.AssetID != asset.ID || c.ProjectID != projectID || c.Revision != 0 || c.Prompt != "" || c.ModelName != "" || c.ModelChannelID != "" || c.AspectRatio != "auto" || c.Resolution != "auto" || c.ImageCount != 1 || len(detail.Models) != 3 {
			t.Fatalf("bad defaults/options: %+v", detail)
		}
		if count(&model.ProductionAssetCreative{}) != 0 || count(&model.ProductionAssetCreativeRequest{}) != 0 {
			t.Fatal("GET wrote records")
		}
		w := raw("GET", path, tokens[1], nil)
		for _, secret := range []string{"synthetic-secret-never-public", provider.URL, "private-remark", "baseUrl", "apiKey", "parameterTranslation", "weight", "timeout"} {
			if strings.Contains(w.Body.String(), secret) {
				t.Fatalf("leaked %s", secret)
			}
		}
		if calls.Load() != 0 {
			t.Fatal("read contacted provider")
		}
	})
	t.Run("save-reopen-free-prep-and-independent-asset-revision", func(t *testing.T) {
		b := body("  人物提示词\r\n保持空格\t与换行  ", 0)
		b["modelChannelId"] = "cloud-a"
		b["modelName"] = "custom-portrait"
		b["aspectRatio"] = "9:16"
		b["resolution"] = "2K"
		b["imageCount"] = 4
		var receipt model.ProductionAssetCreativeReceipt
		hit(t, "PUT", path, tokens[1], b, 200, &receipt)
		if receipt.AssetID != asset.ID || receipt.ProjectID != projectID || receipt.Revision != 1 || receipt.RequestID != b["requestId"] || receipt.UpdatedAt == "" {
			t.Fatalf("bad receipt: %+v", receipt)
		}
		var detail model.ProductionAssetCreativeDetail
		hit(t, "GET", path, tokens[0], nil, 200, &detail)
		if detail.Creative.Prompt != b["prompt"] || detail.Creative.ImageCount != 4 || detail.Creative.ModelName != "custom-portrait" || detail.Creative.Resolution != "2K" || detail.Creative.AspectRatio != "9:16" {
			t.Fatal("creative fields lost")
		}
		var unchanged model.ProductionAsset
		hit(t, "GET", base+"/"+asset.ID, tokens[1], nil, 200, &unchanged)
		if unchanged != asset {
			t.Fatal("creative save changed metadata")
		}
		hit(t, "PUT", base+"/"+asset.ID, tokens[0], map[string]any{"name": "资料改名", "description": "资料另存", "revision": 1, "requestId": uuid.NewString()}, 200, nil)
		hit(t, "GET", path, tokens[1], nil, 200, &detail)
		if detail.Creative.Revision != 1 || detail.Creative.Prompt != b["prompt"] {
			t.Fatal("metadata save changed creative")
		}
		if count(&model.ProductionProjectBudget{}) != 0 || count(&model.CreditLog{}) != 0 || count(&model.CanvasImageTask{}) != 0 || calls.Load() != 0 {
			t.Fatal("free prep required budget, billed or called model")
		}
	})
	parallel := func(path string, bodies []map[string]any) []*httptest.ResponseRecorder {
		results := make([]*httptest.ResponseRecorder, len(bodies))
		var wg sync.WaitGroup
		for i, b := range bodies {
			wg.Add(1)
			go func(i int, b map[string]any) {
				defer wg.Done()
				encoded, _ := json.Marshal(b)
				results[i] = raw("PUT", path, tokens[1], encoded)
			}(i, b)
		}
		wg.Wait()
		return results
	}
	t.Run("twenty-initial-retries-and-first-update-CAS-single-winner", func(t *testing.T) {
		target := createAsset(t, base)
		p := base + "/" + target.ID + "/creative"
		b := body("一次创建", 0)
		bodies := make([]map[string]any, 20)
		for i := range bodies {
			bodies[i] = b
		}
		var firstBody string
		for _, w := range parallel(p, bodies) {
			if w.Code != 200 {
				t.Fatalf("retry %s", w.Body.String())
			}
			if firstBody == "" {
				firstBody = w.Body.String()
			} else if firstBody != w.Body.String() {
				t.Fatal("replay receipt changed")
			}
		}
		var detail model.ProductionAssetCreativeDetail
		hit(t, "GET", p, tokens[1], nil, 200, &detail)
		if detail.Creative.Revision != 1 {
			t.Fatal("duplicate create")
		}
		for _, rev := range []int64{0, 1} {
			if rev == 0 {
				target = createAsset(t, base)
				p = base + "/" + target.ID + "/creative"
			}
			for i := range bodies {
				bodies[i] = body(fmt.Sprintf("竞争%d", i), rev)
			}
			ok, conflict := 0, 0
			for _, w := range parallel(p, bodies) {
				switch w.Code {
				case 200:
					ok++
				case 409:
					conflict++
				default:
					t.Fatalf("CAS status %d %s", w.Code, w.Body.String())
				}
			}
			if ok != 1 || conflict != 19 {
				t.Fatalf("revision %d got %d/%d", rev, ok, conflict)
			}
		}
		b = body("请求作用域", 0)
		third := createAsset(t, base)
		thirdPath := base + "/" + third.ID + "/creative"
		hit(t, "PUT", thirdPath, tokens[0], b, 200, nil)
		different := body("不同正文", 0)
		different["requestId"] = b["requestId"]
		hit(t, "PUT", thirdPath, tokens[0], different, 409, nil)
		foreign := createAsset(t, otherBase)
		hit(t, "PUT", otherBase+"/"+foreign.ID+"/creative", tokens[0], b, 409, nil)
	})
	t.Run("retired-model-kept-explicitly-and-new-selection-revalidated", func(t *testing.T) {
		settings.Private.Channels[0].Enabled = false
		saveSettings()
		var detail model.ProductionAssetCreativeDetail
		hit(t, "GET", path, tokens[1], nil, 200, &detail)
		if detail.Creative.ModelName != "custom-portrait" || len(detail.Models) != 1 {
			t.Fatal("retired selection replaced or still selectable")
		}
		b := body("下架仍可筹备", 1)
		b["modelChannelId"] = "cloud-a"
		b["modelName"] = "custom-portrait"
		hit(t, "PUT", path, tokens[1], b, 200, nil)
		target := createAsset(t, base)
		b["revision"] = 0
		b["requestId"] = uuid.NewString()
		hit(t, "PUT", base+"/"+target.ID+"/creative", tokens[1], b, 400, nil)
		b = body("不同渠道不能冒用", 2)
		b["modelChannelId"] = "cloud-b"
		b["modelName"] = "custom-portrait"
		hit(t, "PUT", path, tokens[1], b, 400, nil)
		b = body("重新选择", 2)
		b["modelChannelId"] = "cloud-b"
		b["modelName"] = "gpt-image-1"
		hit(t, "PUT", path, tokens[1], b, 200, nil)
		b = body("清空模型", 3)
		hit(t, "PUT", path, tokens[1], b, 200, nil)
		hit(t, "GET", path, tokens[1], nil, 200, &detail)
		if detail.Creative.ModelName != "" || detail.Creative.Revision != 4 {
			t.Fatal("clear failed")
		}
		if calls.Load() != 0 {
			t.Fatal("prep called provider")
		}
	})
	t.Run("strict-input-and-size-limits", func(t *testing.T) {
		for _, change := range []func(map[string]any){
			func(b map[string]any) { b["prompt"] = strings.Repeat("字", 8001) }, func(b map[string]any) { b["prompt"] = "bad\x00" }, func(b map[string]any) { b["prompt"] = "bad\u0085" }, func(b map[string]any) { b["aspectRatio"] = "3:2" }, func(b map[string]any) { b["resolution"] = "8K" }, func(b map[string]any) { b["imageCount"] = 0 }, func(b map[string]any) { b["imageCount"] = 5 }, func(b map[string]any) { b["imageCount"] = 1.5 }, func(b map[string]any) { b["revision"] = -1 }, func(b map[string]any) { b["revision"] = 9007199254740991 }, func(b map[string]any) { b["revision"] = 1.5 }, func(b map[string]any) { b["requestId"] = "bad" }, func(b map[string]any) { b["requestId"] = uuid.Nil.String() }, func(b map[string]any) { b["modelName"] = "gpt-image-1" }, func(b map[string]any) { b["modelChannelId"] = "cloud-b" }, func(b map[string]any) { b["apiKey"] = "forbidden" }, func(b map[string]any) { b["projectId"] = "foreign" }, func(b map[string]any) { b["modelChannelId"] = " cloud-b "; b["modelName"] = "gpt-image-1" }, func(b map[string]any) { b["modelName"] = strings.Repeat("m", 257); b["modelChannelId"] = "cloud-b" },
		} {
			b := body("校验", 4)
			change(b)
			hit(t, "PUT", path, tokens[1], b, 400, nil)
		}
		for _, b := range []string{"null", "[]", "{} {}", "{", "{}"} {
			if w := raw("PUT", path, tokens[1], []byte(b)); w.Code != 400 {
				t.Fatalf("bad JSON accepted %s", b)
			}
		}
		b := body(strings.Repeat("x", 256<<10), 4)
		hit(t, "PUT", path, tokens[1], b, 413, nil)
		b = body(strings.Repeat("🌆", 8000), 4)
		hit(t, "PUT", path, tokens[1], b, 200, nil)
	})
	t.Run("create-and-update-receipt-rollback-and-retry", func(t *testing.T) {
		target := createAsset(t, base)
		p := base + "/" + target.ID + "/creative"
		for _, rev := range []int64{0, 1} {
			b := body(fmt.Sprintf("回滚重试%d", rev), rev)
			trigger := fmt.Sprintf("CREATE TRIGGER u03b_fail BEFORE INSERT ON production_asset_creative_requests WHEN NEW.request_id = '%s' BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END", b["requestId"])
			if err := db.Exec(trigger).Error; err != nil {
				t.Fatal(err)
			}
			hit(t, "PUT", p, tokens[1], b, 500, nil)
			var detail model.ProductionAssetCreativeDetail
			hit(t, "GET", p, tokens[1], nil, 200, &detail)
			if detail.Creative.Revision != rev {
				t.Fatal("receipt failure left partial creative")
			}
			if err := db.Exec("DROP TRIGGER u03b_fail").Error; err != nil {
				t.Fatal(err)
			}
			hit(t, "PUT", p, tokens[1], b, 200, nil)
			hit(t, "PUT", p, tokens[1], b, 200, nil)
			hit(t, "GET", p, tokens[1], nil, 200, &detail)
			if detail.Creative.Revision != rev+1 || detail.Creative.Prompt != b["prompt"] {
				t.Fatal("same-key retry failed")
			}
		}
	})
	t.Run("old-receipt-cannot-rewind-newer-content", func(t *testing.T) {
		target := createAsset(t, base)
		p := base + "/" + target.ID + "/creative"
		first := body("旧版", 0)
		hit(t, "PUT", p, tokens[1], first, 200, nil)
		hit(t, "PUT", p, tokens[1], body("新版", 1), 200, nil)
		var receipt model.ProductionAssetCreativeReceipt
		hit(t, "PUT", p, tokens[1], first, 200, &receipt)
		var detail model.ProductionAssetCreativeDetail
		hit(t, "GET", p, tokens[1], nil, 200, &detail)
		if receipt.Revision != 1 || detail.Creative.Revision != 2 || detail.Creative.Prompt != "新版" {
			t.Fatal("replay changed latest")
		}
	})
	t.Run("project-isolation-reassignment-and-ban-deny-replay", func(t *testing.T) {
		for _, token := range []string{"", tokens[2], tokens[3]} {
			status := 404
			if token == "" {
				status = 401
			}
			hit(t, "GET", path, token, nil, status, nil)
			hit(t, "PUT", path, token, body("越权", 5), status, nil)
		}
		hit(t, "GET", otherBase+"/"+asset.ID+"/creative", tokens[0], nil, 404, nil)
		hit(t, "PUT", otherBase+"/"+asset.ID+"/creative", tokens[0], body("跨项目", 0), 404, nil)
		hit(t, "GET", base+"/missing/creative", tokens[1], nil, 404, nil)
		id := createProject(users[1].ID)
		newBase := "/api/v1/production/projects/" + id + "/assets"
		target := createAsset(t, newBase)
		p := newBase + "/" + target.ID + "/creative"
		b := body("改派前", 0)
		hit(t, "PUT", p, tokens[1], b, 200, nil)
		hit(t, "POST", "/api/v1/production/projects/"+id+"/assignment", tokens[0], map[string]any{"producerId": users[2].ID, "revision": 1}, 200, nil)
		hit(t, "GET", p, tokens[1], nil, 404, nil)
		hit(t, "PUT", p, tokens[1], b, 404, nil)
		hit(t, "GET", p, tokens[0], nil, 200, nil)
		hit(t, "GET", p, tokens[2], nil, 200, nil)
		b = body("新组长", 1)
		hit(t, "PUT", p, tokens[2], b, 200, nil)
		hit(t, "POST", "/api/admin/users", tokens[3], map[string]any{"id": users[2].ID, "username": users[2].Username, "role": "user", "status": "ban"}, 200, nil)
		hit(t, "GET", p, tokens[2], nil, 401, nil)
		hit(t, "PUT", p, tokens[2], b, 401, nil)
	})
	t.Run("creative-and-receipt-survive-process-restart", func(t *testing.T) {
		target := createAsset(t, base)
		p := base + "/" + target.ID + "/creative"
		b := body("重启后保持\n提示词", 0)
		b["resolution"] = "4K"
		hit(t, "PUT", p, tokens[1], b, 200, nil)
		if calls.Load() != 0 || count(&model.CreditLog{}) != 0 || count(&model.CanvasImageTask{}) != 0 {
			t.Fatal("creative prep side effects")
		}
		encoded, _ := json.Marshal(b)
		conn, err := db.DB()
		if err != nil {
			t.Fatal(err)
		}
		if err := conn.Close(); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(os.Args[0], "-test.run=^TestProductionAssetCreativeReopen$", "-test.timeout=15s", "-test.v")
		cmd.Env = append(os.Environ(), "U03B_REOPEN_DB="+config.Cfg.DatabaseDSN, "U03B_REOPEN_PATH="+p, "U03B_REOPEN_TOKEN="+tokens[1], "U03B_REOPEN_BODY="+string(encoded))
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("restart: %v\n%s", err, output)
		}
		t.Log(string(output))
	})
}

func TestProductionAssetCreativeReopen(t *testing.T) {
	path := os.Getenv("U03B_REOPEN_DB")
	if path == "" {
		t.Skip("invoked by isolated persistence test")
	}
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: path, JWTSecret: "synthetic-u03b-secret"}
	gin.SetMode(gin.TestMode)
	gin.DefaultWriter = io.Discard
	router := New()
	for _, method := range []string{"GET", "PUT", "GET"} {
		r := httptest.NewRequest(method, os.Getenv("U03B_REOPEN_PATH"), strings.NewReader(os.Getenv("U03B_REOPEN_BODY")))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+os.Getenv("U03B_REOPEN_TOKEN"))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("restart %s: %s", method, w.Body.String())
		}
		if method == "PUT" {
			var response struct {
				Data model.ProductionAssetCreativeReceipt `json:"data"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if response.Data.Revision != 1 {
				t.Fatal("replay rewrote")
			}
		} else {
			var response struct {
				Data model.ProductionAssetCreativeDetail `json:"data"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if response.Data.Creative.Revision != 1 || response.Data.Creative.Prompt != "重启后保持\n提示词" || response.Data.Creative.Resolution != "4K" {
				t.Fatal("persisted creative lost")
			}
		}
	}
}
