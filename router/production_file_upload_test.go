package router

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"net/textproto"
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
	"gorm.io/gorm"
)

type heldUploadBody struct {
	data    *bytes.Reader
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *heldUploadBody) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.entered); <-b.release })
	return b.data.Read(p)
}

// This wrapper commits a real SQLite transaction, then simulates losing its commit acknowledgement.
type ambiguousUploadPool struct {
	gorm.ConnPool
	begin gorm.TxBeginner
}

func (p ambiguousUploadPool) BeginTx(ctx context.Context, options *sql.TxOptions) (gorm.ConnPool, error) {
	tx, err := p.begin.BeginTx(ctx, options)
	if err != nil {
		return nil, err
	}
	return &ambiguousUploadTx{Tx: tx}, nil
}

type ambiguousUploadTx struct {
	*sql.Tx
	wroteReceipt bool
}

func (tx *ambiguousUploadTx) ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error) {
	if strings.Contains(query, "INSERT INTO `production_file_upload_requests`") {
		tx.wroteReceipt = true
	}
	return tx.Tx.ExecContext(ctx, query, args...)
}
func (tx *ambiguousUploadTx) Commit() error {
	err := tx.Tx.Commit()
	if err == nil && tx.wroteReceipt {
		return errors.New("synthetic lost commit acknowledgement")
	}
	return err
}

// Exercise the real net/http deadline with a shorter test duration, without adding a production timeout bypass.
type shortUploadDeadlineWriter struct{ http.ResponseWriter }

func (w shortUploadDeadlineWriter) SetReadDeadline(deadline time.Time) error {
	if !deadline.IsZero() {
		deadline = time.Now().Add(200 * time.Millisecond)
	}
	return http.NewResponseController(w.ResponseWriter).SetReadDeadline(deadline)
}

func TestProductionFileUploads(t *testing.T) {
	if os.Getenv("PRODUCTION_UPLOAD_TEST_CHILD") != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 100*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestProductionFileUploads$", "-test.timeout=95s", "-test.v")
		cmd.Env = append(os.Environ(), "PRODUCTION_UPLOAD_TEST_CHILD=1")
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated upload API: %v\n%s", err, output)
		}
		t.Log(string(output))
		return
	}
	directory := t.TempDir()
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: filepath.Join(directory, "uploads.db"), ProductionFileDir: filepath.Join(directory, "private"), JWTSecret: "synthetic-u04b-test"}
	gin.SetMode(gin.TestMode)
	gin.DefaultWriter = io.Discard
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	users := []model.User{{ID: "upload-creator", Role: model.UserRoleUser, Status: model.UserStatusActive}, {ID: "upload-leader", Role: model.UserRoleUser, Status: model.UserStatusActive}, {ID: "upload-outsider", Role: model.UserRoleUser, Status: model.UserStatusActive}, {ID: "upload-admin", Role: model.UserRoleAdmin, Status: model.UserStatusActive}}
	tokens := make([]string, len(users))
	for i := range users {
		users[i].Username = users[i].ID
		users[i].AffCode = users[i].ID
		tokens[i], err = jwt.NewWithClaims(jwt.SigningMethodHS256, service.TokenClaims{UserID: users[i].ID, RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}}).SignedString([]byte(config.Cfg.JWTSecret))
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Create(&users).Error; err != nil {
		t.Fatal(err)
	}
	project := model.ProductionProject{ID: "project-upload", CreatedBy: users[0].ID, ProducerID: users[1].ID, Revision: 1}
	otherProject := model.ProductionProject{ID: "project-upload-other", CreatedBy: users[0].ID, ProducerID: users[2].ID, Revision: 1}
	asset := model.ProductionAsset{ID: "asset-upload", ProjectID: project.ID, Category: "character", Name: "上传人物", Revision: 1}
	scene := model.ProductionAsset{ID: "asset-upload-scene", ProjectID: project.ID, Category: "scene", Name: "上传场景", Revision: 1}
	otherAsset := model.ProductionAsset{ID: "asset-upload-other", ProjectID: otherProject.ID, Category: "scene", Name: "其他场景", Revision: 1}
	for _, v := range []any{&project, &otherProject, &asset, &scene, &otherAsset} {
		if err := db.Create(v).Error; err != nil {
			t.Fatal(err)
		}
	}
	route := New()
	path := "/api/v1/production/projects/" + project.ID + "/assets/" + asset.ID + "/files"
	hit := func(method, path, token, requestID, contentType string, body io.Reader) *httptest.ResponseRecorder {
		request := httptest.NewRequest(method, path, body)
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		if requestID != "" {
			request.Header.Set("X-Upload-Request-Id", requestID)
		}
		if contentType != "" {
			request.Header.Set("Content-Type", contentType)
		}
		w := httptest.NewRecorder()
		route.ServeHTTP(w, request)
		return w
	}
	check := func(w *httptest.ResponseRecorder, status int) {
		t.Helper()
		if w.Code != status {
			t.Fatalf("status %d want %d: %s", w.Code, status, w.Body.String())
		}
		if w.Header().Get("Cache-Control") != "private, no-store" || w.Header().Get("Vary") != "Authorization" || w.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Fatal("missing privacy headers", w.Header())
		}
	}
	encode := func(name, mime string, data []byte, extra bool) ([]byte, string) {
		t.Helper()
		var b bytes.Buffer
		writer := multipart.NewWriter(&b)
		header := textproto.MIMEHeader{}
		header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, name))
		header.Set("Content-Type", mime)
		part, err := writer.CreatePart(header)
		if err != nil {
			t.Fatal(err)
		}
		part.Write(data)
		if extra {
			writer.WriteField("other", "no")
		}
		writer.Close()
		return b.Bytes(), writer.FormDataContentType()
	}
	post := func(path, token, id, name, mime string, data []byte) *httptest.ResponseRecorder {
		body, typ := encode(name, mime, data, false)
		return hit("POST", path, token, id, typ, bytes.NewReader(body))
	}
	receipt := func(w *httptest.ResponseRecorder) model.ProductionFileUploadReceipt {
		t.Helper()
		var envelope struct {
			Data model.ProductionFileUploadReceipt `json:"data"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		if envelope.Data.File.ID == "" {
			t.Fatal(w.Body.String())
		}
		return envelope.Data
	}
	snapshot := func() (int64, int64, []string) {
		var files, receipts int64
		db.Model(&model.ProductionFile{}).Count(&files)
		db.Model(&model.ProductionFileUploadRequest{}).Count(&receipts)
		entries, _ := os.ReadDir(config.Cfg.ProductionFileDir)
		names := []string{}
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		return files, receipts, names
	}
	imageData := image.NewNRGBA(image.Rect(0, 0, 24, 16))
	imageData.Set(1, 1, color.NRGBA{R: 200, G: 100, B: 30, A: 255})
	var pngBuffer, jpegBuffer bytes.Buffer
	png.Encode(&pngBuffer, imageData)
	jpeg.Encode(&jpegBuffer, imageData, nil)
	pngBytes, jpegBytes := pngBuffer.Bytes(), jpegBuffer.Bytes()
	webpBytes, _ := base64.StdEncoding.DecodeString("UklGRh4AAABXRUJQVlA4TBEAAAAvAYAAAAdQqJIUr/+BiOh/AAA=")
	var first model.ProductionFileUploadReceipt
	firstID := uuid.NewString()
	t.Run("01 reject unauthorized before reading and no disk writes", func(t *testing.T) {
		for i, status := range []int{401, 404, 404} {
			token := ""
			if i > 0 {
				token = tokens[i+1]
			}
			body := &heldUploadBody{data: bytes.NewReader(nil), entered: make(chan struct{}), release: make(chan struct{})}
			w := hit("POST", path, token, uuid.NewString(), "multipart/form-data; boundary=x", body)
			check(w, status)
			select {
			case <-body.entered:
				t.Fatal("read unauthorized body")
			default:
			}
		}
		wrong := strings.Replace(path, asset.ID, otherAsset.ID, 1)
		check(post(wrong, tokens[0], uuid.NewString(), "a.png", "image/png", pngBytes), 404)
		if _, err := os.Stat(config.Cfg.ProductionFileDir); !os.IsNotExist(err) {
			t.Fatal("unauthorized request created directory")
		}
	})
	t.Run("02 PNG JPEG WebP original bytes private read and budget-free preparation", func(t *testing.T) {
		for i, item := range []struct {
			name, mime string
			data       []byte
		}{{" 人物参考.png ", "image/png", pngBytes}, {"scene.jpg", "image/jpeg", jpegBytes}, {"reference.webp", "image/webp", webpBytes}} {
			id := uuid.NewString()
			if i == 0 {
				id = firstID
			}
			w := post(path, tokens[1], id, item.name, item.mime, item.data)
			check(w, 200)
			saved := receipt(w)
			if i == 0 {
				first = saved
			}
			if saved.RequestID != id || saved.File.ProjectID != project.ID || saved.File.AssetID != asset.ID || saved.File.Name != strings.TrimSpace(item.name) {
				t.Fatal(saved)
			}
			for _, unsafe := range []string{"storageKey", "payloadHash", "publicUrl", config.Cfg.ProductionFileDir} {
				if strings.Contains(w.Body.String(), unsafe) {
					t.Fatal("unsafe DTO")
				}
			}
			url := "/api/v1/production/projects/" + project.ID + "/files/" + saved.File.ID + "/content?download=1"
			download := hit("GET", url, tokens[0], "", "", nil)
			check(download, 200)
			if sha256.Sum256(download.Body.Bytes()) != sha256.Sum256(item.data) {
				t.Fatal("bytes changed")
			}
			head := hit("HEAD", url, tokens[1], "", "", nil)
			check(head, 200)
			if head.Body.Len() != 0 {
				t.Fatal("HEAD returned bytes")
			}
			partialRequest := httptest.NewRequest("GET", url, nil)
			partialRequest.Header.Set("Authorization", "Bearer "+tokens[1])
			partialRequest.Header.Set("Range", "bytes=0-7")
			partial := httptest.NewRecorder()
			route.ServeHTTP(partial, partialRequest)
			check(partial, 206)
			if !bytes.Equal(partial.Body.Bytes(), item.data[:8]) {
				t.Fatal("upload range changed bytes")
			}

			info, err := os.Stat(filepath.Join(config.Cfg.ProductionFileDir, saved.File.ID+".blob"))
			if err != nil || info.Mode().Perm() != 0600 {
				t.Fatal("nonprivate file mode", err)
			}
		}
		files, records, names := snapshot()
		if files != 3 || records != 3 || len(names) != 3 {
			t.Fatal(files, records, names)
		}
	})
	t.Run("03 receipt fresh authorization same-key replay conflicts and actor isolation", func(t *testing.T) {
		receiptPath := strings.TrimSuffix(path, "/files") + "/file-uploads/" + firstID
		w := hit("GET", receiptPath, tokens[1], "", "", nil)
		check(w, 200)
		if receipt(w).File.ID != first.File.ID {
			t.Fatal("wrong receipt")
		}
		check(hit("GET", receiptPath, tokens[0], "", "", nil), 404)
		check(hit("GET", receiptPath, "", "", "", nil), 401)
		check(hit("GET", receiptPath, tokens[2], "", "", nil), 404)
		w = post(path, tokens[1], firstID, "人物参考.png", "image/png", pngBytes)
		check(w, 200)
		if receipt(w).File.ID != first.File.ID {
			t.Fatal("duplicate")
		}
		check(post(path, tokens[1], firstID, "renamed.png", "image/png", pngBytes), 409)
		check(post(strings.Replace(path, asset.ID, scene.ID, 1), tokens[1], firstID, "人物参考.png", "image/png", pngBytes), 409)
		// A different actor may use the same UUID but has an independent receipt.
		check(post(path, tokens[0], firstID, "人物参考.png", "image/png", pngBytes), 200)
		files, records, names := snapshot()
		if files != 4 || records != 4 || len(names) != 4 {
			t.Fatal(files, records, names)
		}
	})
	t.Run("04 invalid bytes names MIME multipart and transfer encoding leave no records", func(t *testing.T) {
		f, r, n := snapshot()
		cases := []struct {
			name, mime string
			data       []byte
			status     int
		}{{"fake.png", "image/png", []byte("<svg>bad</svg>"), 422}, {"wrong.jpg", "image/png", pngBytes, 415}, {"bad.png", "image/jpeg", pngBytes, 415}, {"../path.png", "image/png", pngBytes, 400}, {"empty.png", "image/png", nil, 422}, {"cut.png", "image/png", pngBytes[:len(pngBytes)-12], 422}, {"cut.jpg", "image/jpeg", jpegBytes[:len(jpegBytes)/2], 422}, {"cut.webp", "image/webp", webpBytes[:20], 422}}
		for _, item := range cases {
			check(post(path, tokens[1], uuid.NewString(), item.name, item.mime, item.data), item.status)
		}
		data, typ := encode("test.png", "image/png", pngBytes, true)
		check(hit("POST", path, tokens[1], uuid.NewString(), typ, bytes.NewReader(data)), 400)
		data, typ = encode("test.png", "image/png", pngBytes, false)
		data = bytes.Replace(data, []byte("Content-Type: image/png\r\n"), []byte("Content-Type: image/png\r\nContent-Transfer-Encoding: quoted-printable\r\n"), 1)
		check(hit("POST", path, tokens[1], uuid.NewString(), typ, bytes.NewReader(data)), 400)
		data, typ = encode("test.png", "image/png", pngBytes, false)
		data = bytes.Replace(data, []byte(`filename="test.png"`), []byte(`filename*=UTF-8''test.png%0A`), 1)
		check(hit("POST", path, tokens[1], uuid.NewString(), typ, bytes.NewReader(data)), 400)
		check(post(path, tokens[1], "not-a-uuid", "test.png", "image/png", pngBytes), 400)
		f2, r2, n2 := snapshot()
		if f != f2 || r != r2 || len(n) != len(n2) {
			t.Fatal("failed uploads left files or rows")
		}
	})
	t.Run("05 APNG animated WebP and mismatched inner dimensions rejected", func(t *testing.T) {
		pngChunk := func(name string, data []byte) []byte {
			b := make([]byte, 12+len(data))
			binary.BigEndian.PutUint32(b, uint32(len(data)))
			copy(b[4:8], name)
			copy(b[8:], data)
			binary.BigEndian.PutUint32(b[8+len(data):], crc32.ChecksumIEEE(b[4:8+len(data)]))
			return b
		}
		animatedPNG := append(append(append([]byte{}, pngBytes[:33]...), pngChunk("acTL", make([]byte, 8))...), pngBytes[33:]...)
		check(post(path, tokens[1], uuid.NewString(), "animated.png", "image/png", animatedPNG), 422)
		bigPNG := append([]byte{}, pngBytes...)
		binary.BigEndian.PutUint32(bigPNG[16:20], 8193)
		binary.BigEndian.PutUint32(bigPNG[29:33], crc32.ChecksumIEEE(bigPNG[12:29]))
		check(post(path, tokens[1], uuid.NewString(), "huge.png", "image/png", bigPNG), 422)
		binary.BigEndian.PutUint32(bigPNG[16:20], 5000)
		binary.BigEndian.PutUint32(bigPNG[20:24], 5000)
		binary.BigEndian.PutUint32(bigPNG[29:33], crc32.ChecksumIEEE(bigPNG[12:29]))
		check(post(path, tokens[1], uuid.NewString(), "too-many-pixels.png", "image/png", bigPNG), 422)

		makeExtended := func(flags byte) []byte {
			payload := append([]byte("WEBPVP8X\x0a\x00\x00\x00"), []byte{flags, 0, 0, 0, 0, 0, 0, 0, 0, 0}...)
			payload = append(payload, webpBytes[12:]...)
			result := append([]byte("RIFF\x00\x00\x00\x00"), payload...)
			binary.LittleEndian.PutUint32(result[4:8], uint32(len(payload)))
			return result
		}
		check(post(path, tokens[1], uuid.NewString(), "animated.webp", "image/webp", makeExtended(2)), 422)
		check(post(path, tokens[1], uuid.NewString(), "mismatched.webp", "image/webp", makeExtended(0)), 422)
	})
	t.Run("06 oversize body and image rejected without visible result", func(t *testing.T) {
		beforeFiles, beforeReceipts, beforeEntries := snapshot()
		big := make([]byte, service.ProductionFileMaxBytes+1)
		copy(big, pngBytes)
		check(post(path, tokens[1], uuid.NewString(), "large.png", "image/png", big), 413)
		data, typ := encode("test.png", "image/png", pngBytes, false)
		data = append(data, bytes.Repeat([]byte{0}, int(service.ProductionUploadMaxBody))...)
		check(hit("POST", path, tokens[1], uuid.NewString(), typ, bytes.NewBuffer(data)), 413)
		files, records, entries := snapshot()
		if files != beforeFiles || records != beforeReceipts || len(entries) != len(beforeEntries) {
			t.Fatal("oversize left data")
		}
	})
	t.Run("07 two bounded slots and twenty concurrent attempts retry safely", func(t *testing.T) {
		data, typ := encode("busy.png", "image/png", pngBytes, false)
		held := make([]*heldUploadBody, 2)
		results := make(chan *httptest.ResponseRecorder, 2)
		for i := 0; i < 2; i++ {
			held[i] = &heldUploadBody{data: bytes.NewReader(data), entered: make(chan struct{}), release: make(chan struct{})}
			go func(body *heldUploadBody) { results <- hit("POST", path, tokens[1], uuid.NewString(), typ, body) }(held[i])
			<-held[i].entered
		}
		ids := make([]string, 20)
		responses := make(chan *httptest.ResponseRecorder, 20)
		for i := range ids {
			ids[i] = uuid.NewString()
			go func(id string) { responses <- post(path, tokens[1], id, "busy.png", "image/png", pngBytes) }(ids[i])
		}
		for range ids {
			response := <-responses
			check(response, 429)
			if response.Header().Get("Retry-After") == "" {
				t.Fatal("missing Retry-After")
			}
		}
		// Metadata access still works while slow bodies hold both slots; no DB connection is held by upload reads.
		check(hit("GET", path, tokens[1], "", "", nil), 200)
		for _, body := range held {
			close(body.release)
		}
		check(<-results, 200)
		check(<-results, 200)
		for _, id := range ids {
			check(post(path, tokens[1], id, "busy.png", "image/png", pngBytes), 200)
		}
	})
	t.Run("08 authorization revoked during body transfer rejects commit and cleans candidate", func(t *testing.T) {
		data, typ := encode("revoked.png", "image/png", pngBytes, false)
		held := &heldUploadBody{data: bytes.NewReader(data), entered: make(chan struct{}), release: make(chan struct{})}
		result := make(chan *httptest.ResponseRecorder, 1)
		f, r, n := snapshot()
		go func() { result <- hit("POST", path, tokens[1], uuid.NewString(), typ, held) }()
		<-held.entered
		if err := db.Model(&model.ProductionProject{}).Where("id = ?", project.ID).Update("producer_id", users[2].ID).Error; err != nil {
			t.Fatal(err)
		}
		close(held.release)
		check(<-result, 404)
		db.Model(&model.ProductionProject{}).Where("id = ?", project.ID).Update("producer_id", users[1].ID)
		f2, r2, n2 := snapshot()
		if f != f2 || r != r2 || len(n) != len(n2) {
			t.Fatal("revoked upload left data")
		}
		db.Model(&model.User{}).Where("id = ?", users[1].ID).Update("status", model.UserStatusBan)
		check(post(path, tokens[1], uuid.NewString(), "disabled.png", "image/png", pngBytes), 401)
		db.Model(&model.User{}).Where("id = ?", users[1].ID).Update("status", model.UserStatusActive)
	})
	t.Run("09 project quota competition cannot exceed limit", func(t *testing.T) {
		f, r, n := snapshot()
		var count int64
		db.Model(&model.ProductionFile{}).Where("project_id = ?", project.ID).Count(&count)
		config.Cfg.ProductionProjectFileCount = count + 1
		data, typ := encode("quota.png", "image/png", pngBytes, false)
		held := make([]*heldUploadBody, 2)
		results := make(chan *httptest.ResponseRecorder, 2)
		for i := range held {
			held[i] = &heldUploadBody{data: bytes.NewReader(data), entered: make(chan struct{}), release: make(chan struct{})}
			go func(body *heldUploadBody) { results <- hit("POST", path, tokens[1], uuid.NewString(), typ, body) }(held[i])
			<-held[i].entered
		}
		for _, b := range held {
			close(b.release)
		}
		statuses := map[int]int{}
		for i := 0; i < 2; i++ {
			w := <-results
			statuses[w.Code]++
			if w.Code != 200 && w.Code != 409 {
				t.Fatal(w.Code, w.Body.String())
			}
		}
		if statuses[200] != 1 || statuses[409] != 1 {
			t.Fatal(statuses)
		}
		config.Cfg.ProductionProjectFileCount = 0
		f2, r2, n2 := snapshot()
		if f2 != f+1 || r2 != r+1 || len(n2) != len(n)+1 {
			t.Fatal("quota race")
		}
		config.Cfg.ProductionProjectFileBytes = 1
		check(post(path, tokens[1], uuid.NewString(), "quota.png", "image/png", pngBytes), 409)
		config.Cfg.ProductionProjectFileBytes = 0
	})
	t.Run("10 database rollback and filesystem failure leave no half success", func(t *testing.T) {
		f, r, n := snapshot()
		if err := db.Exec(`CREATE TRIGGER reject_upload_receipt BEFORE INSERT ON production_file_upload_requests BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END`).Error; err != nil {
			t.Fatal(err)
		}
		check(post(path, tokens[1], uuid.NewString(), "rollback.png", "image/png", pngBytes), 500)
		db.Exec("DROP TRIGGER reject_upload_receipt")
		f2, r2, n2 := snapshot()
		if f != f2 || r != r2 || len(n) != len(n2) {
			t.Fatal("rollback left data")
		}
		original := config.Cfg.ProductionFileDir
		blocked := filepath.Join(directory, "not-a-directory")
		os.WriteFile(blocked, []byte("blocked"), 0600)
		config.Cfg.ProductionFileDir = blocked
		check(post(path, tokens[1], uuid.NewString(), "disk.png", "image/png", pngBytes), 503)
		config.Cfg.ProductionFileDir = original
		f2, r2, n2 = snapshot()
		if f != f2 || r != r2 || len(n) != len(n2) {
			t.Fatal("disk failure left data")
		}
	})
	t.Run("11 same-key concurrent submissions return one indexed file", func(t *testing.T) {
		f, r, n := snapshot()
		id := uuid.NewString()
		data, typ := encode("duplicate.png", "image/png", pngBytes, false)
		held := make([]*heldUploadBody, 2)
		results := make(chan *httptest.ResponseRecorder, 2)
		for i := range held {
			held[i] = &heldUploadBody{data: bytes.NewReader(data), entered: make(chan struct{}), release: make(chan struct{})}
			go func(body *heldUploadBody) { results <- hit("POST", path, tokens[1], id, typ, body) }(held[i])
			<-held[i].entered
		}
		for _, body := range held {
			close(body.release)
		}
		a, b := <-results, <-results
		check(a, 200)
		check(b, 200)
		if receipt(a).File.ID != receipt(b).File.ID {
			t.Fatal("duplicate IDs")
		}
		f2, r2, n2 := snapshot()
		if f2 != f+1 || r2 != r+1 || len(n2) != len(n)+1 {
			t.Fatal("duplicate file or receipt")
		}
	})
	t.Run("12 committed bytes survive lost commit acknowledgement and same-key recovery", func(t *testing.T) {
		f, r, n := snapshot()
		id := uuid.NewString()
		originalPool := db.Statement.ConnPool
		beginner, ok := originalPool.(gorm.TxBeginner)
		if !ok {
			t.Fatal("test database cannot wrap transactions")
		}
		db.Statement.ConnPool = ambiguousUploadPool{ConnPool: originalPool, begin: beginner}
		w := post(path, tokens[1], id, "uncertain.png", "image/png", pngBytes)
		db.Statement.ConnPool = originalPool
		check(w, 500)
		f2, r2, n2 := snapshot()
		if f2 != f+1 || r2 != r+1 || len(n2) != len(n)+1 {
			t.Fatal("commit ambiguity deleted durable bytes")
		}
		receiptPath := strings.TrimSuffix(path, "/files") + "/file-uploads/" + id
		confirmed := hit("GET", receiptPath, tokens[1], "", "", nil)
		check(confirmed, 200)
		saved := receipt(confirmed)
		check(hit("GET", "/api/v1/production/projects/"+project.ID+"/files/"+saved.File.ID+"/content", tokens[1], "", "", nil), 200)
		repeated := post(path, tokens[1], id, "uncertain.png", "image/png", pngBytes)
		check(repeated, 200)
		if receipt(repeated).File.ID != saved.File.ID {
			t.Fatal("recovery duplicated file")
		}
	})
	t.Run("13 slow network bodies expire and release both upload slots", func(t *testing.T) {
		f, r, n := snapshot()
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { route.ServeHTTP(shortUploadDeadlineWriter{w}, r) }))
		defer server.Close()
		parsed, _ := url.Parse(server.URL)
		connections := make([]net.Conn, 2)
		for i := range connections {
			connection, err := net.Dial("tcp", parsed.Host)
			if err != nil {
				t.Fatal(err)
			}
			connections[i] = connection
			defer connection.Close()
			connection.SetDeadline(time.Now().Add(3 * time.Second))
			fmt.Fprintf(connection, "POST %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nX-Upload-Request-Id: %s\r\nContent-Type: multipart/form-data; boundary=slow\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n--slow\r\n", path, parsed.Host, tokens[1], uuid.NewString())
		}
		for _, connection := range connections {
			response, err := http.ReadResponse(bufio.NewReader(connection), nil)
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != 400 {
				t.Fatalf("slow request status %d", response.StatusCode)
			}
			response.Body.Close()
		}
		f2, r2, n2 := snapshot()
		if f != f2 || r != r2 || len(n) != len(n2) {
			t.Fatal("timed-out upload left data")
		}
		check(post(path, tokens[1], uuid.NewString(), "after-timeout.png", "image/png", pngBytes), 200)
	})
	t.Run("14 orphan blob is unreachable and existing success survives reopened process", func(t *testing.T) {
		orphanID := "file-" + uuid.NewString()
		os.WriteFile(filepath.Join(config.Cfg.ProductionFileDir, orphanID+".blob"), pngBytes, 0600)
		check(hit("GET", "/api/v1/production/projects/"+project.ID+"/files/"+orphanID+"/content", tokens[0], "", "", nil), 404)
		cmd := exec.Command(os.Args[0], "-test.run=^TestProductionUploadRestart$", "-test.v")
		cmd.Env = append(os.Environ(), "PRODUCTION_UPLOAD_RESTART=1", "UPLOAD_DB="+config.Cfg.DatabaseDSN, "UPLOAD_DIR="+config.Cfg.ProductionFileDir, "UPLOAD_TOKEN="+tokens[1], "UPLOAD_FILE="+first.File.ID, "UPLOAD_REQUEST="+firstID)
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("restart: %v %s", err, output)
		}
	})
}

func TestProductionUploadRestart(t *testing.T) {
	if os.Getenv("PRODUCTION_UPLOAD_RESTART") != "1" {
		t.Skip("subprocess-only durable read")
	}
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: os.Getenv("UPLOAD_DB"), ProductionFileDir: os.Getenv("UPLOAD_DIR"), JWTSecret: "synthetic-u04b-test"}
	gin.SetMode(gin.TestMode)
	gin.DefaultWriter = io.Discard
	router := New()
	for _, path := range []string{"/api/v1/production/projects/project-upload/files/" + os.Getenv("UPLOAD_FILE") + "/content", "/api/v1/production/projects/project-upload/assets/asset-upload/file-uploads/" + os.Getenv("UPLOAD_REQUEST")} {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Authorization", "Bearer "+os.Getenv("UPLOAD_TOKEN"))
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatal(w.Code, w.Body.String())
		}
		if strings.HasSuffix(path, "/content") {
			if _, err := png.Decode(bytes.NewReader(w.Body.Bytes())); err != nil {
				t.Fatal(err)
			}
		}
	}
}
