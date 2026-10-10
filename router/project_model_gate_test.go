package router

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestPersonalModelRoutesCannotSpendOutsideProject(t *testing.T) {
	const marker = "PROJECT_MODEL_GATE_CHILD"
	if os.Getenv(marker) != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPersonalModelRoutesCannotSpendOutsideProject$", "-test.timeout=25s", "-test.v")
		cmd.Env = append(os.Environ(), marker+"=1")
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated project model gate: %v\n%s", err, output)
		}
		t.Log(string(output))
		return
	}
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: filepath.Join(t.TempDir(), "gate.db"), JWTSecret: "synthetic-project-budget-gate"}
	gin.SetMode(gin.TestMode)
	gin.DefaultWriter = io.Discard
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	users := []model.User{
		{ID: "gate-producer", Username: "gate-producer", AffCode: "gate-producer", Role: model.UserRoleUser, Status: model.UserStatusActive, Credits: 2468},
		{ID: "gate-admin", Username: "gate-admin", AffCode: "gate-admin", Role: model.UserRoleAdmin, Status: model.UserStatusActive, Credits: 2468},
	}
	if err := db.Create(&users).Error; err != nil {
		t.Fatal(err)
	}
	tokens := make([]string, 2)
	for i, u := range users {
		tokens[i], err = jwt.NewWithClaims(jwt.SigningMethodHS256, service.TokenClaims{UserID: u.ID, Username: u.Username, Role: u.Role, RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}}).SignedString([]byte(config.Cfg.JWTSecret))
		if err != nil {
			t.Fatal(err)
		}
	}
	server := New()
	call := func(method, path, token string) int {
		// Claiming an arbitrary project does not convert a retired endpoint into project billing.
		request := httptest.NewRequest(method, path, bytes.NewBufferString(`{"model":"synthetic","projectId":"forged-project","prompt":"no provider call","credits":0}`))
		request.Header.Set("Content-Type", "application/json")
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		server.ServeHTTP(w, request)
		if w.Code == http.StatusConflict {
			var reply struct {
				Code int    `json:"code"`
				Msg  string `json:"msg"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &reply); err != nil || reply.Code == 0 || reply.Msg == "" {
				t.Errorf("missing failure body: %s", w.Body.String())
			}
		}
		return w.Code
	}
	endpoints := []string{"/images/generations", "/images/edits", "/responses", "/chat/completions", "/audio/speech", "/canvas/image-tasks", "/canvas/audio-tasks", "/videos", "/workflow-tasks", "/workflows/agent-draft"}
	for _, endpoint := range endpoints {
		t.Run(endpoint, func(t *testing.T) {
			for _, token := range tokens {
				if status := call("POST", "/api/v1"+endpoint, token); status != 409 {
					t.Fatalf("status %d expected409", status)
				}
			}
			if status := call("POST", "/api/v1"+endpoint, ""); status != 401 {
				t.Fatalf("unauthenticated status %d", status)
			}
		})
	}
	t.Run("legacy-workflow-resume-and-admin-probe-also-require-project-execution", func(t *testing.T) {
		if status := call("GET", "/api/v1/workflow-tasks/old-task", tokens[0]); status != 409 {
			t.Fatalf("workflow status %d", status)
		}
		if status := call("POST", "/api/admin/settings/channel-test", tokens[1]); status != 409 {
			t.Fatalf("admin probe status %d", status)
		}
		if status := call("POST", "/api/admin/comfy-bridges/inspect", tokens[1]); status != 409 {
			t.Fatalf("bridge inspection status %d", status)
		}
		if status := call("POST", "/api/admin/settings/channel-test", tokens[0]); status != 401 {
			t.Fatalf("admin auth status %d", status)
		}
		if status := call("GET", "/api/bridge/comfy/poll", ""); status != 409 {
			t.Fatalf("bridge poll status %d", status)
		}
		if status := call("POST", "/api/bridge/comfy/lease", ""); status != 409 {
			t.Fatalf("bridge lease status %d", status)
		}
	})
	t.Run("twenty-calls-do-not-touch-personal-balance-or-create-tasks", func(t *testing.T) {
		var wg sync.WaitGroup
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if status := call("POST", "/api/v1/images/generations", tokens[0]); status != 409 {
					t.Errorf("status %d", status)
				}
			}()
		}
		wg.Wait()
		var saved []model.User
		if err := db.Find(&saved).Error; err != nil {
			t.Fatal(err)
		}
		for _, u := range saved {
			if u.Credits != 2468 {
				t.Fatalf("personal credits changed: %f", u.Credits)
			}
		}
		for _, table := range []string{"credit_logs", "canvas_image_tasks", "canvas_audio_tasks", "video_tasks"} {
			var count int64
			if err := db.Table(table).Count(&count).Error; err != nil {
				t.Fatal(err)
			}
			if count != 0 {
				t.Fatalf("unexpected %s rows %d", table, count)
			}
		}
	})
}
