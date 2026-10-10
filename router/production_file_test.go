package router

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
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

func TestProductionFiles(t *testing.T) {
	if os.Getenv("PRODUCTION_FILE_TEST_CHILD") != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestProductionFiles$", "-test.timeout=55s", "-test.v")
		cmd.Env = append(os.Environ(), "PRODUCTION_FILE_TEST_CHILD=1")
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated file API: %v\n%s", err, output)
		}
		t.Log(string(output))
		return
	}
	directory := t.TempDir()
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: filepath.Join(directory, "files.db"), ProductionFileDir: filepath.Join(directory, "private"), JWTSecret: "synthetic-u04a-secret"}
	gin.SetMode(gin.TestMode)
	gin.DefaultWriter = io.Discard
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	users := []model.User{
		{ID: "u04a-creator", Role: model.UserRoleUser, Status: model.UserStatusActive},
		{ID: "u04a-leader", Role: model.UserRoleUser, Status: model.UserStatusActive},
		{ID: "u04a-other", Role: model.UserRoleUser, Status: model.UserStatusActive},
		{ID: "u04a-admin", Role: model.UserRoleAdmin, Status: model.UserStatusActive},
	}
	tokens := make([]string, len(users))
	for i := range users {
		users[i].Username, users[i].AffCode = users[i].ID, users[i].ID
		tokens[i], err = jwt.NewWithClaims(jwt.SigningMethodHS256, service.TokenClaims{UserID: users[i].ID, RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}}).SignedString([]byte(config.Cfg.JWTSecret))
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Create(&users).Error; err != nil {
		t.Fatal(err)
	}
	project := model.ProductionProject{ID: "project-u04a", Title: "合成私有项目", CreatedBy: users[0].ID, ProducerID: users[1].ID, Revision: 1}
	otherProject := model.ProductionProject{ID: "project-u04a-other", CreatedBy: users[0].ID, ProducerID: users[2].ID, Revision: 1}
	asset := model.ProductionAsset{ID: "asset-u04a", ProjectID: project.ID, Category: "character", Name: "合成人物", Revision: 1}
	emptyAsset := model.ProductionAsset{ID: "asset-u04a-empty", ProjectID: project.ID, Category: "scene", Name: "合成场景", Revision: 1}
	otherAsset := model.ProductionAsset{ID: "asset-u04a-other", ProjectID: otherProject.ID, Category: "character", Name: "合成人物", Revision: 1}
	for _, value := range []any{&project, &otherProject, &asset, &emptyAsset, &otherAsset} {
		if err := db.Create(value).Error; err != nil {
			t.Fatal(err)
		}
	}
	router := New()
	request := func(method, path, token string, headers map[string]string) *http.Request {
		r := httptest.NewRequest(method, path, nil)
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		return r
	}
	hit := func(method, path, token string, headers map[string]string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		router.ServeHTTP(w, request(method, path, token, headers))
		return w
	}
	check := func(t *testing.T, w *httptest.ResponseRecorder, status int) {
		t.Helper()
		if w.Code != status {
			t.Fatalf("status %d want %d: %s", w.Code, status, w.Body.String())
		}
		if w.Header().Get("Cache-Control") != "private, no-store" || w.Header().Get("Vary") != "Authorization" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatalf("missing privacy headers: %v", w.Header())
		}
	}
	listPath := "/api/v1/production/projects/" + project.ID + "/assets/" + asset.ID + "/files"
	file := model.ProductionFile{ID: "file-" + uuid.NewString(), ProjectID: project.ID, AssetID: asset.ID, Name: "人物参考图.png", MimeType: "image/png", CreatedBy: users[0].ID, CreatedAt: "2026-10-10T00:00:00Z"}
	file.StorageKey = file.ID + ".blob"
	metaPath := "/api/v1/production/projects/" + project.ID + "/files/" + file.ID
	contentPath := metaPath + "/content"
	var buffer bytes.Buffer
	picture := image.NewNRGBA(image.Rect(0, 0, 24, 16))
	picture.Set(3, 4, color.NRGBA{R: 240, G: 180, B: 80, A: 255})
	if err := png.Encode(&buffer, picture); err != nil {
		t.Fatal(err)
	}
	data := buffer.Bytes()
	file.Bytes = int64(len(data))
	expectedSHA := sha256.Sum256(data)

	t.Run("01 empty reads do not create rows or private directory", func(t *testing.T) {
		w := hit("GET", listPath, tokens[1], nil)
		check(t, w, 200)
		if !strings.Contains(w.Body.String(), `"items":[]`) || !strings.Contains(w.Body.String(), `"total":0`) {
			t.Fatal(w.Body.String())
		}
		if _, err := os.Stat(config.Cfg.ProductionFileDir); !os.IsNotExist(err) {
			t.Fatalf("directory unexpectedly created: %v", err)
		}
		var n int64
		db.Model(&model.ProductionFile{}).Count(&n)
		if n != 0 {
			t.Fatal(n)
		}
	})
	if err := os.MkdirAll(config.Cfg.ProductionFileDir, 0700); err != nil {
		t.Fatal(err)
	}
	filePath := filepath.Join(config.Cfg.ProductionFileDir, file.StorageKey)
	if err := os.WriteFile(filePath, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&file).Error; err != nil {
		t.Fatal(err)
	}

	t.Run("02 safe metadata ownership and bounded pagination", func(t *testing.T) {
		for _, token := range tokens[:2] {
			for _, path := range []string{listPath, metaPath} {
				w := hit("GET", path, token, nil)
				check(t, w, 200)
				for _, unsafe := range []string{"storageKey", "createdBy", "publicUrl", "objectKey", file.StorageKey, config.Cfg.ProductionFileDir} {
					if strings.Contains(w.Body.String(), unsafe) {
						t.Fatalf("leaked %s", unsafe)
					}
				}
			}
		}
		w := hit("GET", listPath+"?page=2&pageSize=1", tokens[0], nil)
		check(t, w, 200)
		if !strings.Contains(w.Body.String(), `"items":[]`) || !strings.Contains(w.Body.String(), `"total":1`) {
			t.Fatal(w.Body.String())
		}
		for _, suffix := range []string{"?pageSize=21", "?page=0", "?page=1&page=2", "?page=not-a-number", "?token=forbidden"} {
			check(t, hit("GET", listPath+suffix, tokens[0], nil), 400)
		}
		for _, token := range tokens[2:] {
			for _, path := range []string{listPath, metaPath, contentPath} {
				check(t, hit("GET", path, token, nil), 404)
			}
		}
		for _, path := range []string{listPath, metaPath, contentPath} {
			check(t, hit("GET", path, "", nil), 401)
		}
		check(t, hit("GET", strings.Replace(metaPath, project.ID, otherProject.ID, 1), tokens[0], nil), 404)
		check(t, hit("GET", strings.Replace(listPath, asset.ID, otherAsset.ID, 1), tokens[0], nil), 404)
		check(t, hit("GET", strings.Replace(metaPath, file.ID, "file-"+uuid.NewString(), 1), tokens[0], nil), 404)
	})
	t.Run("03 actual PNG full body HEAD and fresh download", func(t *testing.T) {
		for _, suffix := range []string{"", "?download=0", "?download=1"} {
			w := hit("GET", contentPath+suffix, tokens[1], nil)
			check(t, w, 200)
			if sha256.Sum256(w.Body.Bytes()) != expectedSHA || w.Header().Get("Content-Type") != "image/png" || w.Header().Get("Content-Length") != strconv.Itoa(len(data)) {
				t.Fatal("file bytes or headers changed")
			}
			disposition, params, err := mime.ParseMediaType(w.Header().Get("Content-Disposition"))
			if err != nil || params["filename"] != file.Name || (suffix == "?download=1" && disposition != "attachment") {
				t.Fatal("invalid filename/disposition")
			}
			if _, err := png.Decode(bytes.NewReader(w.Body.Bytes())); err != nil {
				t.Fatal(err)
			}
		}
		w := hit("HEAD", contentPath, tokens[1], nil)
		check(t, w, 200)
		if w.Body.Len() != 0 || w.Header().Get("Content-Length") != strconv.Itoa(len(data)) {
			t.Fatal("invalid HEAD")
		}
		for _, suffix := range []string{"?token=x", "?download=yes", "?download=1&download=0"} {
			check(t, hit("GET", contentPath+suffix, tokens[0], nil), 400)
		}
	})
	t.Run("04 single ranges suffix open ended malformed and conditional requests", func(t *testing.T) {
		for _, item := range []struct {
			value      string
			start, end int
		}{{"bytes=0-7", 0, 8}, {"bytes=8-", 8, len(data)}, {"bytes=-7", len(data) - 7, len(data)}} {
			w := hit("GET", contentPath, tokens[1], map[string]string{"Range": item.value})
			check(t, w, 206)
			if !bytes.Equal(w.Body.Bytes(), data[item.start:item.end]) || w.Header().Get("Content-Range") != fmt.Sprintf("bytes %d-%d/%d", item.start, item.end-1, len(data)) {
				t.Fatal("invalid range")
			}
		}
		for _, value := range []string{"bytes=999999-", "bytes=broken", "bytes=0-1,4-5"} {
			check(t, hit("GET", contentPath, tokens[1], map[string]string{"Range": value}), 416)
		}
		w := httptest.NewRecorder()
		r := request("GET", contentPath, tokens[1], nil)
		r.Header.Add("Range", "bytes=0-1")
		r.Header.Add("Range", "bytes=4-5")
		router.ServeHTTP(w, r)
		check(t, w, 416)
		for _, headers := range []map[string]string{{"If-None-Match": "*"}, {"If-Modified-Since": time.Now().Add(time.Hour).Format(http.TimeFormat)}, {"Range": "bytes=0-7", "If-Range": time.Now().Format(http.TimeFormat)}} {
			status := http.StatusOK
			if headers["If-None-Match"] == "*" {
				status = http.StatusNotModified
			}
			check(t, hit("GET", contentPath, tokens[1], headers), status)
			check(t, hit("GET", contentPath, tokens[2], headers), 404)
			check(t, hit("HEAD", contentPath, "", headers), 401)
		}
	})
	t.Run("05 reassignment and disabled account reject subsequent requests", func(t *testing.T) {
		if err := db.Model(&project).Update("producer_id", users[2].ID).Error; err != nil {
			t.Fatal(err)
		}
		for _, method := range []string{"GET", "HEAD"} {
			check(t, hit(method, contentPath, tokens[1], map[string]string{"Range": "bytes=0-1"}), 404)
		}
		check(t, hit("GET", contentPath, tokens[2], nil), 200)
		check(t, hit("GET", contentPath, tokens[0], nil), 200)
		db.Model(&project).Update("producer_id", users[1].ID)
		db.Model(&users[1]).Update("status", model.UserStatusBan)
		for _, path := range []string{listPath, metaPath, contentPath} {
			check(t, hit("GET", path, tokens[1], nil), 401)
		}
		db.Model(&users[1]).Update("status", model.UserStatusActive)
	})
	t.Run("06 twenty concurrent readers preserve SHA and no writes", func(t *testing.T) {
		var wg sync.WaitGroup
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				w := hit("GET", contentPath, tokens[1], nil)
				if w.Code != 200 || sha256.Sum256(w.Body.Bytes()) != expectedSHA {
					t.Error("concurrent read mismatch")
				}
			}()
		}
		wg.Wait()
		var n int64
		db.Model(&model.ProductionFile{}).Count(&n)
		if n != 1 {
			t.Fatal(n)
		}
	})
	t.Run("07 streaming does not hold SQLite transaction", func(t *testing.T) {
		w := &blockedFileWriter{ResponseRecorder: httptest.NewRecorder(), entered: make(chan struct{}), release: make(chan struct{})}
		done := make(chan struct{})
		go func() { defer close(done); router.ServeHTTP(w, request("GET", contentPath, tokens[1], nil)) }()
		select {
		case <-w.entered:
		case <-time.After(time.Second):
			close(w.release)
			t.Fatal("stream did not start")
		}
		read := make(chan *httptest.ResponseRecorder, 1)
		go func() { read <- hit("GET", metaPath, tokens[0], nil) }()
		select {
		case response := <-read:
			check(t, response, 200)
		case <-time.After(time.Second):
			close(w.release)
			t.Fatal("slow stream held DB transaction")
		}
		close(w.release)
		<-done
	})
	t.Run("08 unsafe paths symlinks FIFO directory length MIME and missing file fail closed", func(t *testing.T) {
		for _, key := range []string{"../outside.blob", "/tmp/outside.blob", "subdir/" + file.StorageKey} {
			db.Model(&file).Update("storage_key", key)
			check(t, hit("GET", contentPath, tokens[0], nil), 404)
		}
		db.Model(&file).Update("storage_key", file.ID+".blob")
		originalKey := file.ID + ".blob"
		filePath = filepath.Join(config.Cfg.ProductionFileDir, originalKey)
		if err := os.Remove(filePath); err != nil {
			t.Fatal(err)
		}
		check(t, hit("GET", contentPath, tokens[0], nil), 404)
		outside := filepath.Join(directory, "outside.blob")
		os.WriteFile(outside, data, 0600)
		for _, target := range []string{outside, "../outside.blob"} {
			if err := os.Symlink(target, filePath); err != nil {
				t.Fatal(err)
			}
			check(t, hit("GET", contentPath, tokens[0], nil), 404)
			os.Remove(filePath)
		}
		if err := os.Mkdir(filePath, 0700); err != nil {
			t.Fatal(err)
		}
		check(t, hit("GET", contentPath, tokens[0], nil), 404)
		os.Remove(filePath)
		if err := syscall.Mkfifo(filePath, 0600); err != nil {
			t.Fatal(err)
		}
		check(t, hit("GET", contentPath, tokens[0], nil), 404)
		os.Remove(filePath)
		os.WriteFile(filePath, data[:len(data)-1], 0600)
		check(t, hit("GET", contentPath, tokens[0], nil), 404)
		os.WriteFile(filePath, data, 0600)
		for _, fields := range []map[string]any{{"bytes": 0}, {"bytes": service.ProductionFileMaxBytes + 1}, {"mime_type": "image/svg+xml"}, {"name": "evil\r\nheader"}, {"asset_id": otherAsset.ID}} {
			db.Model(&file).Updates(fields)
			check(t, hit("GET", contentPath, tokens[0], nil), 404)
			db.Model(&file).Updates(map[string]any{"bytes": len(data), "mime_type": "image/png", "name": "人物参考图.png", "asset_id": asset.ID})
		}
	})
	t.Run("09 legacy reads writes and proxy cannot bypass project authorization", func(t *testing.T) {
		legacy := model.StorageObject{ID: file.ID, ObjectKey: "legacy-object", PublicURL: "https://example.invalid/private", CreatedBy: users[0].ID}
		if err := db.Create(&legacy).Error; err != nil {
			t.Fatal(err)
		}
		for _, method := range []string{"GET", "HEAD"} {
			for _, path := range []string{"/api/files/" + file.ID, "/api/files/" + file.ID + "/content"} {
				for _, token := range []string{"", tokens[0]} {
					check(t, hit(method, path, token, nil), 404)
				}
			}
		}
		for _, route := range [][2]string{{"POST", "/api/anonymous/files/session"}, {"POST", "/api/anonymous/files"}, {"DELETE", "/api/anonymous/files/" + file.ID}, {"POST", "/api/v1/files"}, {"POST", "/api/v1/files/direct"}, {"DELETE", "/api/v1/files/" + file.ID}, {"DELETE", "/api/v1/files/" + file.ID + "/record"}} {
			check(t, hit(route[0], route[1], tokens[0], nil), 410)
		}
		var n int64
		db.Model(&model.StorageObject{}).Count(&n)
		if n != 1 {
			t.Fatal("legacy data modified")
		}
		for _, target := range []string{"http://127.0.0.1:5689" + contentPath, "file://" + filePath} {
			w := hit("GET", "/api/proxy-image?url="+url.QueryEscape(target), tokens[0], nil)
			if w.Code == 200 && bytes.Equal(w.Body.Bytes(), data) {
				t.Fatal("proxy exposed file")
			}
			if w.Code == 200 {
				var value struct {
					Code int `json:"code"`
				}
				json.Unmarshal(w.Body.Bytes(), &value)
				if value.Code == 0 {
					t.Fatal("unexpected proxy success")
				}
			}
		}
	})
	t.Run("10 new process can reopen unchanged private bytes", func(t *testing.T) {
		cmd := exec.Command(os.Args[0], "-test.run=^TestProductionFileRestartRead$", "-test.timeout=15s")
		cmd.Env = append(os.Environ(), "U04A_REOPEN_DB="+config.Cfg.DatabaseDSN, "U04A_REOPEN_DIR="+config.Cfg.ProductionFileDir, "U04A_REOPEN_FILE="+file.ID, "U04A_REOPEN_SHA="+hex.EncodeToString(expectedSHA[:]))
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("reopen: %v\n%s", err, output)
		}
	})
}

type blockedFileWriter struct {
	*httptest.ResponseRecorder
	entered, release chan struct{}
	once             sync.Once
}

func (w *blockedFileWriter) Write(data []byte) (int, error) {
	w.once.Do(func() { close(w.entered); <-w.release })
	return w.ResponseRecorder.Write(data)
}

func TestProductionFileRestartRead(t *testing.T) {
	dbPath := os.Getenv("U04A_REOPEN_DB")
	if dbPath == "" {
		t.Skip("subprocess only")
	}
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: dbPath, ProductionFileDir: os.Getenv("U04A_REOPEN_DIR")}
	ctx := service.WithUser(context.Background(), model.AuthUser{ID: "u04a-leader"})
	_, stream, err := service.OpenProductionFile(ctx, "project-u04a", os.Getenv("U04A_REOPEN_FILE"))
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	data, err := io.ReadAll(stream)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != os.Getenv("U04A_REOPEN_SHA") {
		t.Fatal("restart changed bytes")
	}
}
