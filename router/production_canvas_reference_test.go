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

func TestProductionCanvasReferences(t *testing.T) {
	const marker = "PRODUCTION_REFERENCE_TEST_CHILD"
	if os.Getenv(marker) != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 70*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestProductionCanvasReferences$", "-test.timeout=65s", "-test.v")
		cmd.Env = append(os.Environ(), marker+"=1")
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated reference API: %v\n%s", err, output)
		}
		t.Log(string(output))
		return
	}
	directory := t.TempDir()
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: filepath.Join(directory, "references.db"), ProductionFileDir: filepath.Join(directory, "private"), JWTSecret: "synthetic-u04d-secret"}
	gin.SetMode(gin.TestMode)
	gin.DefaultWriter = io.Discard
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	users := []model.User{
		{ID: "u04d-creator", Username: "u04d-creator", Role: model.UserRoleUser, Status: model.UserStatusActive, CanAssignProjects: true},
		{ID: "u04d-producer", Username: "u04d-producer", Role: model.UserRoleUser, Status: model.UserStatusActive},
		{ID: "u04d-other", Username: "u04d-other", Role: model.UserRoleUser, Status: model.UserStatusActive},
		{ID: "u04d-admin", Username: "u04d-admin", Role: model.UserRoleAdmin, Status: model.UserStatusActive},
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
	perform := func(method, path, token string, body any) *httptest.ResponseRecorder {
		encoded, _ := json.Marshal(body)
		r := httptest.NewRequest(method, path, bytes.NewReader(encoded))
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return w
	}
	request := func(method, path, token string, body any, status int) json.RawMessage {
		t.Helper()
		w := perform(method, path, token, body)
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
	newProject := func(title string) model.ProductionProject {
		var project model.ProductionProject
		json.Unmarshal(request("POST", "/api/v1/production/projects", tokens[0], map[string]any{"title": title, "producerId": users[1].ID, "requestId": uuid.NewString()}, 200), &project)
		return project
	}
	project, foreign := newProject("引用项目"), newProject("另一个项目")
	assets := []model.ProductionAsset{
		{ID: "asset-" + uuid.NewString(), ProjectID: project.ID, Category: "character", Name: "人物", Revision: 1},
		{ID: "asset-" + uuid.NewString(), ProjectID: project.ID, Category: "scene", Name: "场景", Revision: 1},
		{ID: "asset-" + uuid.NewString(), ProjectID: foreign.ID, Category: "character", Name: "另一项目人物", Revision: 1},
	}
	if err := db.Create(&assets).Error; err != nil {
		t.Fatal(err)
	}
	files := make([]model.ProductionFile, 3)
	for i, asset := range assets {
		id := "file-" + uuid.NewString()
		files[i] = model.ProductionFile{ID: id, ProjectID: asset.ProjectID, AssetID: asset.ID, StorageKey: id + ".blob", Name: "不可快照的文件名.png", MimeType: "image/png", Bytes: 100, CreatedBy: users[0].ID, CreatedAt: "2026-10-10T00:00:00Z"}
	}
	if err := db.Create(&files).Error; err != nil {
		t.Fatal(err)
	}
	base := "/api/v1/production/projects/" + project.ID + "/workspaces/canvas/documents"
	node := func(id string, index int) map[string]any {
		return map[string]any{"id": id, "type": "image", "title": "资产图片", "position": map[string]any{"x": 12, "y": 34}, "width": 320, "height": 240, "metadata": map[string]any{"assetId": assets[index].ID, "fileId": files[index].ID}}
	}
	content := func(nodes ...any) map[string]any {
		return map[string]any{"schemaVersion": 1, "nodes": nodes, "connections": []any{}, "viewport": map[string]any{"x": 0, "y": 0, "k": 1}, "backgroundMode": "dots"}
	}
	createBody := func(c map[string]any) map[string]any {
		return map[string]any{"title": "引用画布", "content": c, "requestId": uuid.NewString()}
	}
	saveBody := func(c map[string]any, revision int64) map[string]any {
		return map[string]any{"title": "引用画布", "content": c, "revision": revision, "requestId": uuid.NewString()}
	}
	create := func(c map[string]any) model.ProductionCanvasDocument {
		var document model.ProductionCanvasDocument
		json.Unmarshal(request("POST", base, tokens[1], createBody(c), 200), &document)
		return document
	}
	read := func(id string) model.ProductionCanvasDocument {
		var document model.ProductionCanvasDocument
		json.Unmarshal(request("GET", base+"/"+id, tokens[1], nil, 200), &document)
		return document
	}
	counts := func() [2]int64 {
		var result [2]int64
		db.Model(&model.ProductionCanvasDocument{}).Count(&result[0])
		db.Model(&model.CanvasDocumentRequest{}).Count(&result[1])
		return result
	}
	var saved model.ProductionCanvasDocument
	t.Run("reference-create-save-reopen-and-immutable-file-identity", func(t *testing.T) {
		c := content(node("image-1", 0), node("image-2", 1))
		saved = create(c)
		moved := node("image-1", 0)
		moved["position"] = map[string]any{"x": 400, "y": -200}
		moved["width"], moved["height"] = 640, 480
		request("PUT", base+"/"+saved.ID, tokens[1], saveBody(content(moved, node("image-2", 1)), 1), 200)
		saved = read(saved.ID)
		if saved.Revision != 2 || !bytes.Contains(saved.Content, []byte(files[0].ID)) || !bytes.Contains(saved.Content, []byte(files[1].ID)) {
			t.Fatalf("reference not persisted: %+v", saved)
		}
		for _, unsafe := range []string{files[0].Name, "storageKey", "http:", "blob:", "base64"} {
			if bytes.Contains(saved.Content, []byte(unsafe)) {
				t.Fatalf("content included media data: %s", saved.Content)
			}
		}
	})
	t.Run("project-asset-file-mismatch-is-atomic-422", func(t *testing.T) {
		before := counts()
		for _, pair := range [][2]string{{assets[0].ID, files[1].ID}, {assets[2].ID, files[2].ID}, {assets[0].ID, files[2].ID}, {assets[2].ID, files[0].ID}, {"asset-" + uuid.NewString(), files[0].ID}, {assets[0].ID, "file-" + uuid.NewString()}} {
			n := node("invalid", 0)
			n["metadata"] = map[string]any{"assetId": pair[0], "fileId": pair[1]}
			request("POST", base, tokens[1], createBody(content(n)), 422)
			request("PUT", base+"/"+saved.ID, tokens[1], saveBody(content(node("valid", 0), n), 2), 422)
		}
		if before != counts() || read(saved.ID).Revision != 2 {
			t.Fatal("invalid reference partially wrote document/receipt")
		}
	})
	t.Run("strict-reference-fields-types-ids-and-twenty-image-limit", func(t *testing.T) {
		for _, field := range []string{"content", "fontSize", "url", "imageUrl", "storageKey", "projectId", "filename", "token"} {
			n := node("invalid", 0)
			n["metadata"].(map[string]any)[field] = nil
			request("POST", base, tokens[1], createBody(content(n)), 400)
		}
		for _, value := range []any{"", "asset-AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "asset-00000000-0000-0000-0000-000000000000", "https://example.invalid/file", nil} {
			n := node("invalid", 0)
			n["metadata"].(map[string]any)["assetId"] = value
			request("POST", base, tokens[1], createBody(content(n)), 400)
		}
		for _, kind := range []string{"text", "group"} {
			for _, field := range []string{"assetId", "fileId", "AssetId", "ASSETID", "FileID", "FILEID"} {
				for _, value := range []any{nil, "", "https://example.invalid/not-a-reference"} {
					n := node("invalid", 0)
					n["type"] = kind
					n["metadata"] = map[string]any{field: value}
					request("POST", base, tokens[1], createBody(content(n)), 400)
				}
			}
		}
		nodes := make([]any, 20)
		for i := range nodes {
			nodes[i] = node(fmt.Sprintf("image-%d", i), i%2)
		}
		create(content(nodes...))
		request("POST", base, tokens[1], createBody(content(append(nodes, node("twenty-one", 0))...)), 400)
	})
	t.Run("reference-group-connections-copy-and-delete-do-not-touch-assets", func(t *testing.T) {
		group := map[string]any{"id": "group", "type": "group", "title": "分组", "position": map[string]any{"x": 0, "y": 0}, "width": 1000, "height": 800}
		image := node("image", 0)
		image["metadata"].(map[string]any)["groupId"] = "group"
		c := content(group, image, node("copy", 0))
		c["connections"] = []any{map[string]any{"id": "edge", "fromNodeId": "image", "toNodeId": "copy"}}
		document := create(c)
		c["connections"] = []any{map[string]any{"id": "edge", "fromNodeId": "image", "toNodeId": "group"}}
		request("POST", base, tokens[1], createBody(c), 400)
		request("PUT", base+"/"+document.ID, tokens[1], saveBody(content(group), 1), 200)
		var remaining int64
		db.Model(&model.ProductionFile{}).Count(&remaining)
		if remaining != 3 {
			t.Fatal("deleting reference removed private files")
		}
	})
	t.Run("twenty-retries-and-competing-revisions", func(t *testing.T) {
		c := content(node("image", 0))
		document := create(c)
		parallel := func(bodies []map[string]any) []int {
			results := make([]int, len(bodies))
			var wg sync.WaitGroup
			for i := range bodies {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					results[i] = perform("PUT", base+"/"+document.ID, tokens[1], bodies[i]).Code
				}(i)
			}
			wg.Wait()
			return results
		}
		body := saveBody(c, 1)
		bodies := make([]map[string]any, 20)
		for i := range bodies {
			bodies[i] = body
		}
		for _, status := range parallel(bodies) {
			if status != 200 {
				t.Fatalf("same-key replay: %d", status)
			}
		}
		for i := range bodies {
			bodies[i] = saveBody(c, 2)
		}
		success, conflicts := 0, 0
		for _, status := range parallel(bodies) {
			switch status {
			case 200:
				success++
			case 409:
				conflicts++
			default:
				t.Fatalf("competing save: %d", status)
			}
		}
		if success != 1 || conflicts != 19 || read(document.ID).Revision != 3 {
			t.Fatalf("CAS result success=%d conflict=%d", success, conflicts)
		}
	})
	t.Run("receipt-failure-rolls-back-reference-and-allows-same-key-retry", func(t *testing.T) {
		document := create(content(node("image", 0)))
		body := saveBody(content(node("scene", 1)), 1)
		before := counts()
		trigger := fmt.Sprintf("CREATE TRIGGER u04d_receipt_failure BEFORE INSERT ON canvas_document_requests WHEN NEW.request_id = '%s' BEGIN SELECT RAISE(ABORT, 'synthetic reference failure'); END", body["requestId"])
		if err := db.Exec(trigger).Error; err != nil {
			t.Fatal(err)
		}
		request("PUT", base+"/"+document.ID, tokens[1], body, 500)
		if before != counts() || read(document.ID).Revision != 1 {
			t.Fatal("receipt failure partially committed")
		}
		db.Exec("DROP TRIGGER u04d_receipt_failure")
		request("PUT", base+"/"+document.ID, tokens[1], body, 200)
		request("PUT", base+"/"+document.ID, tokens[1], body, 200)
		if read(document.ID).Revision != 2 {
			t.Fatal("retry saved duplicate revision")
		}
	})
	t.Run("missing-file-retains-existing-node-but-rejects-copy-new-node-and-save-as", func(t *testing.T) {
		c := content(node("retained", 0))
		body := createBody(c)
		var document model.ProductionCanvasDocument
		json.Unmarshal(request("POST", base, tokens[1], body, 200), &document)
		save := saveBody(c, 1)
		request("PUT", base+"/"+document.ID, tokens[1], save, 200)
		if err := db.Delete(&files[0]).Error; err != nil {
			t.Fatal(err)
		}
		defer db.Create(&files[0])
		if read(document.ID).Revision != 2 {
			t.Fatal("missing file hid whole document")
		}
		request("GET", "/api/v1/production/projects/"+project.ID+"/files/"+files[0].ID+"/content", tokens[1], nil, 404)
		request("POST", base, tokens[1], body, 200)
		request("PUT", base+"/"+document.ID, tokens[1], save, 200)
		moved := node("retained", 0)
		moved["position"] = map[string]any{"x": 90, "y": 70}
		request("PUT", base+"/"+document.ID, tokens[1], saveBody(content(moved), 2), 200)
		request("POST", base, tokens[1], createBody(content(moved)), 422)
		request("PUT", base+"/"+document.ID, tokens[1], saveBody(content(moved, node("new-copy", 0)), 3), 422)
		request("PUT", base+"/"+document.ID, tokens[1], saveBody(content(node("renamed-node", 0)), 3), 422)
		if read(document.ID).Revision != 3 {
			t.Fatal("invalid copy changed revision")
		}
	})
	t.Run("missing-asset-is-retainable-but-existing-file-mismatch-is-not", func(t *testing.T) {
		c := content(node("retained", 1))
		document := create(c)
		db.Delete(&assets[1])
		request("PUT", base+"/"+document.ID, tokens[1], saveBody(c, 1), 200)
		request("POST", base, tokens[1], createBody(c), 422)
		db.Create(&assets[1])
		db.Model(&model.ProductionFile{}).Where("id = ?", files[1].ID).Update("asset_id", assets[0].ID)
		request("PUT", base+"/"+document.ID, tokens[1], saveBody(c, 2), 422)
		db.Model(&model.ProductionFile{}).Where("id = ?", files[1].ID).Update("asset_id", assets[1].ID)
	})
	t.Run("anonymous-outsider-admin-reassignment-and-ban-reject-even-replays", func(t *testing.T) {
		c := content(node("image", 0))
		body := createBody(c)
		var document model.ProductionCanvasDocument
		json.Unmarshal(request("POST", base, tokens[1], body, 200), &document)
		save := saveBody(c, 1)
		request("PUT", base+"/"+document.ID, tokens[1], save, 200)
		for _, token := range []string{"", tokens[2], tokens[3]} {
			status := 404
			if token == "" {
				status = 401
			}
			request("GET", base+"/"+document.ID, token, nil, status)
			request("POST", base, token, body, status)
			request("PUT", base+"/"+document.ID, token, save, status)
		}
		request("POST", "/api/v1/production/projects/"+project.ID+"/assignment", tokens[0], map[string]any{"producerId": users[2].ID, "revision": 1}, 200)
		request("GET", base+"/"+document.ID, tokens[1], nil, 404)
		request("POST", base, tokens[1], body, 404)
		request("PUT", base+"/"+document.ID, tokens[1], save, 404)
		request("GET", base+"/"+document.ID, tokens[2], nil, 200)
		request("POST", "/api/admin/users", tokens[3], map[string]any{"id": users[2].ID, "username": users[2].Username, "role": "user", "status": "ban"}, 200)
		request("GET", base+"/"+document.ID, tokens[2], nil, 401)
		request("PUT", base+"/"+document.ID, tokens[2], saveBody(c, 2), 401)
	})
	t.Run("new-process-reopens-same-file-references", func(t *testing.T) {
		cmd := exec.Command(os.Args[0], "-test.run=^TestProductionCanvasReferenceReopen$", "-test.timeout=15s")
		cmd.Env = append(os.Environ(), "REFERENCE_REOPEN_DB="+config.Cfg.DatabaseDSN, "REFERENCE_REOPEN_PROJECT="+project.ID, "REFERENCE_REOPEN_DOCUMENT="+saved.ID, "REFERENCE_REOPEN_FILE="+files[0].ID)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("reference reopen failed: %v\n%s", err, output)
		}
	})
}

func TestProductionCanvasReferenceReopen(t *testing.T) {
	path := os.Getenv("REFERENCE_REOPEN_DB")
	if path == "" {
		t.Skip("subprocess readback only")
	}
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: path}
	ctx := service.WithUser(context.Background(), model.AuthUser{ID: "u04d-creator"})
	document, err := service.GetProductionCanvasDocument(ctx, os.Getenv("REFERENCE_REOPEN_PROJECT"), "canvas", os.Getenv("REFERENCE_REOPEN_DOCUMENT"))
	if err != nil || document.Revision != 2 || !bytes.Contains(document.Content, []byte(os.Getenv("REFERENCE_REOPEN_FILE"))) {
		t.Fatalf("persisted reference lost: %+v %v", document, err)
	}
}
