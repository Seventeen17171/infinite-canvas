package handler

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestCloudModelPolicy(t *testing.T) {
	const marker = "CLOUD_MODEL_POLICY_CHILD"
	if os.Getenv(marker) != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestCloudModelPolicy$", "-test.timeout=40s", "-test.v")
		cmd.Env = append(os.Environ(), marker+"=1")
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated policy: %v\n%s", err, output)
		}
		t.Log(string(output))
		return
	}
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: ":memory:", AILogDir: t.TempDir()}
	blockProtocolNetwork(t)
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	conn.SetMaxOpenConns(1)
	defer conn.Close()
	user := model.User{ID: "policy-producer", Username: "policy-producer", Role: model.UserRoleUser, Status: model.UserStatusActive, Credits: 100}
	if err := db.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	ctx := service.WithUser(context.Background(), model.PublicUser(user))
	channel := model.ModelChannel{ID: "backend", Name: "backend", Protocol: "openai", BaseURL: "https://backend.invalid/v1", APIKey: "backend-key-canary", Models: []string{"model", "hidden"}, Enabled: true, Weight: 1}
	settings := model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{channel}}, Public: model.PublicSetting{ModelChannel: model.PublicModelChannelSetting{AvailableModels: []string{"model"}}}}
	if _, err := service.SaveSettings(settings); err != nil {
		t.Fatal(err)
	}
	legacy := `{"localChannels":[{"id":"backend","baseUrl":"https://personal.invalid","apiKey":"personal-key-canary","models":["model"]}],"channelTranslations":[{"parameterTranslation":"private-source-canary"}],"syncStorageConfig":true,"syncWebDAVStorageConfig":false}`
	if err := db.Save(&model.UserConfig{UserID: user.ID, ModelConfig: legacy}).Error; err != nil {
		t.Fatal(err)
	}
	request := func(method, path, body string, handler http.HandlerFunc, headers map[string]string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body)).WithContext(ctx)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Model-Channel-ID", "backend")
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		handler(w, r)
		return w
	}
	t.Run("public-settings-and-user-config-hide-connection-material", func(t *testing.T) {
		for _, path := range []string{"public", "user"} {
			var value any
			if path == "public" {
				value, err = service.PublicSettings()
			} else {
				value, err = service.CurrentUserConfig(ctx)
			}
			encoded, _ := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			for _, forbidden := range []string{"backend.invalid", "backend-key-canary", "personal.invalid", "personal-key-canary", "private-source-canary", "modelConfig", "allowCustomChannel", "allowUserRemoteChannel"} {
				if strings.Contains(string(encoded), forbidden) {
					t.Fatalf("%s leaked %s", path, forbidden)
				}
			}
		}
		cfg, err := service.CurrentUserConfig(ctx)
		if err != nil || !cfg.StorageSync.S3 || cfg.StorageSync.WebDAV {
			t.Fatalf("storage preference lost: %+v %v", cfg.StorageSync, err)
		}
		admin, err := service.AdminSettings()
		if err != nil || admin.Private.Channels[0].APIKey != "" {
			t.Fatalf("admin key exposure: %v", err)
		}
		if _, err := service.SaveSettings(admin); err != nil {
			t.Fatal(err)
		}
		saved, _ := repository.GetSettings()
		if saved.Private.Channels[0].APIKey != channel.APIKey {
			t.Fatal("blank key save erased backend credential")
		}
	})
	paths := []struct {
		path string
		fn   http.HandlerFunc
	}{
		{"/chat/completions", AIChatCompletions}, {"/responses", AIResponses}, {"/images/generations", AIImagesGenerations}, {"/images/edits", AIImagesEdits}, {"/audio/speech", AIAudioSpeech}, {"/videos", AIVideos},
	}
	t.Run("storage-sync-persists-without-model-payload", func(t *testing.T) {
		saved, _ := repository.GetSettings()
		saved.Public.Storage.AllowUserProvider = true
		if _, err := repository.SaveSettings(saved, "storage-policy"); err != nil {
			t.Fatal(err)
		}
		flags := &service.UserStorageSync{S3: false, WebDAV: true}
		cfg, err := service.SaveCurrentUserStorageProvider(ctx, service.UserStorageProviders{}, flags)
		if err != nil || cfg.StorageSync.S3 || !cfg.StorageSync.WebDAV {
			t.Fatalf("storage save %+v %v", cfg.StorageSync, err)
		}
		stored, _, _ := repository.GetUserConfig(user.ID)
		if strings.Contains(stored.ModelConfig, "personal-key-canary") || strings.Contains(stored.ModelConfig, "localChannels") {
			t.Fatal("non-model preference write retained obsolete model material")
		}
		// Restore the historical canary so subsequent requests prove it cannot be executed.
		stored.ModelConfig = legacy
		if err := db.Save(&stored).Error; err != nil {
			t.Fatal(err)
		}
	})
	t.Run("all-modalities-use-backend-for-normal-producer", func(t *testing.T) {
		for _, entry := range paths {
			t.Run(entry.path, func(t *testing.T) {
				calls := 0
				protocolMockHTTP(t, func(r *http.Request) (*http.Response, error) {
					calls++
					if r.URL.Host != "backend.invalid" || r.Header.Get("Authorization") != "Bearer backend-key-canary" {
						t.Errorf("unexpected model authority %s", r.URL.Host)
					}
					payload, content := `{"choices":[],"data":[{"url":"https://media.invalid/image"}]}`, "application/json"
					if entry.path == "/videos" {
						payload = `{"id":"backend-task","status":"processing"}`
					}
					if entry.path == "/audio/speech" {
						payload, content = "audio-data", "audio/wav"
					}
					return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {content}}, Body: io.NopCloser(strings.NewReader(payload))}, nil
				})
				w := request("POST", entry.path, `{"model":"model","prompt":"hello"}`, entry.fn, nil)
				if calls != 1 || strings.Contains(w.Body.String(), `"code":1`) {
					t.Fatalf("cloud call failed calls=%d body=%s", calls, w.Body)
				}
			})
		}
	})
	t.Run("workflow-draft-uses-backend", func(t *testing.T) {
		calls := 0
		protocolMockHTTP(t, func(r *http.Request) (*http.Response, error) {
			calls++
			if r.URL.Host != "backend.invalid" || r.Header.Get("Authorization") != "Bearer backend-key-canary" {
				t.Error("wrong draft authority")
			}
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"{\"name\":\"test\",\"variables\":[]}"}}]}`))}, nil
		})
		w := request("POST", "/workflows/agent-draft", `{"prompt":"hello","model":"model","channelId":"backend"}`, DraftUserWorkflow, nil)
		if calls != 1 || strings.Contains(w.Body.String(), `"code":1`) {
			t.Fatalf("draft response %s calls=%d", w.Body, calls)
		}
	})
	t.Run("legacy-headers-and-body-overrides-have-zero-network", func(t *testing.T) {
		blockProtocolNetwork(t)
		for _, entry := range paths {
			w := request("POST", entry.path, `{"model":"model"}`, entry.fn, map[string]string{userModelChannelHeader: "backend"})
			if !strings.Contains(w.Body.String(), `"code":1`) {
				t.Fatalf("header accepted %s", entry.path)
			}
			for _, field := range []string{`"baseUrl":"https://personal.invalid"`, `"apiKey":"personal-key-canary"`, `"channelMode":"local"`, `"channel":{"baseUrl":"https://personal.invalid"}`, `"userChannelId":"backend"`, `"parameterTranslation":"custom-source"`} {
				w = request("POST", entry.path, `{"model":"model",`+field+`}`, entry.fn, nil)
				if !strings.Contains(w.Body.String(), `"code":1`) {
					t.Fatalf("override accepted %s %s", entry.path, field)
				}
			}
			w = request("POST", entry.path, `{"model":"hidden"}`, entry.fn, nil)
			if !strings.Contains(w.Body.String(), `"code":1`) {
				t.Fatalf("hidden model accepted %s", entry.path)
			}
		}
		for _, entry := range []struct {
			path string
			fn   http.HandlerFunc
		}{{"/canvas/image-tasks", CreateCanvasImageTask}, {"/canvas/audio-tasks", CreateCanvasAudioTask}} {
			for _, body := range []string{`{"channelId":"backend","baseUrl":"https://personal.invalid","request":{"model":"model"}}`, `{"channelId":"backend","request":{"model":"model","apiKey":"legacy"}}`} {
				w := request("POST", entry.path, body, entry.fn, nil)
				if !strings.Contains(w.Body.String(), `"code":1`) {
					t.Fatalf("canvas override accepted %s", w.Body)
				}
			}
		}
		var body bytes.Buffer
		form := multipart.NewWriter(&body)
		form.WriteField("model", "model")
		form.WriteField("base_url", "https://personal.invalid")
		form.Close()
		r := httptest.NewRequest("POST", "/images/edits", &body).WithContext(ctx)
		r.Header.Set("Content-Type", form.FormDataContentType())
		w := httptest.NewRecorder()
		AIImagesEdits(w, r)
		if !strings.Contains(w.Body.String(), `"code":1`) {
			t.Fatal("multipart override accepted")
		}
	})
	t.Run("canvas-async-executor-uses-backend", func(t *testing.T) {
		calls := 0
		protocolMockHTTP(t, func(r *http.Request) (*http.Response, error) {
			calls++
			if r.URL.Host != "backend.invalid" || r.Header.Get("Authorization") != "Bearer backend-key-canary" {
				t.Error("wrong canvas authority")
			}
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"data":[{"url":"https://media.invalid/image"}]}`))}, nil
		})
		_, status, _, err := executeCanvasAIRequest(model.PublicUser(user), "/images/generations", []byte(`{"model":"model"}`), "application/json", "backend", "")
		if err != nil || status != 200 || calls != 1 {
			t.Fatalf("canvas execution %v %d %d", err, status, calls)
		}
		_, _, _, _ = executeCanvasAIRequest(model.PublicUser(user), "/images/generations", []byte(`{"model":"model"}`), "application/json", "backend", "backend")
		if calls != 1 {
			t.Fatal("legacy canvas channel executed")
		}
	})
	t.Run("workflow-and-bridge-legacy-paths-rejected", func(t *testing.T) {
		blockProtocolNetwork(t)
		discovery := request("POST", "/model-channels/autodl/workflows", `{"channelId":"backend","baseUrl":"https://personal.invalid"}`, UserAutoDLWorkflows, nil)
		if !strings.Contains(discovery.Body.String(), `"code":1`) {
			t.Fatal("discovery accepted user BaseURL")
		}
		w := request("POST", "/workflows/agent-draft", `{"prompt":"hello","model":"model","channelMode":"local","baseUrl":"https://personal.invalid","apiKey":"legacy"}`, DraftUserWorkflow, nil)
		if !strings.Contains(w.Body.String(), `"code":1`) {
			t.Fatal("local draft accepted")
		}
		w = request("POST", "/workflow-tasks", `{"ref":{"scope":"personal","channelId":"backend","workflowId":"wf","kind":"workflow"},"expectedCapability":"image"}`, CreateWorkflowTask, nil)
		if !strings.Contains(w.Body.String(), `"code":1`) {
			t.Fatal("personal workflow accepted")
		}
		if _, err := service.RegisterComfyBridge("personal", user.ID, "old"); err == nil {
			t.Fatal("personal registration accepted")
		}
		token := strings.Repeat("a", 64)
		hash := sha256.Sum256([]byte(token))
		bridge := model.ComfyBridge{ID: "old-bridge", OwnerScope: "personal", OwnerID: user.ID, Enabled: true, TokenHash: hex.EncodeToString(hash[:])}
		if err := db.Create(&bridge).Error; err != nil {
			t.Fatal(err)
		}
		if _, err := service.AuthenticateComfyBridge(token); err == nil {
			t.Fatal("legacy personal bridge authenticated")
		}
		registration, err := service.RegisterComfyBridge("system", "system", "cloud bridge")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := service.AuthenticateComfyBridge(registration.Token); err != nil {
			t.Fatal("system bridge stopped working")
		}
	})
	t.Run("legacy-video-poll-and-content-never-fallback", func(t *testing.T) {
		blockProtocolNetwork(t)
		old := model.VideoTask{ID: "legacy-task", UserID: user.ID, Model: "model", ChannelID: "backend", UserChannelID: "backend", Status: "running", VideoURL: "https://personal.invalid/video"}
		if err := db.Create(&old).Error; err != nil {
			t.Fatal(err)
		}
		if _, err := pollVideoTaskFromUpstream(old); err == nil {
			t.Fatal("legacy poll allowed")
		}
		w := request("GET", "/videos/legacy-task/content?model=model", "", func(w http.ResponseWriter, r *http.Request) { AIVideoContent(w, r, old.ID) }, nil)
		if !strings.Contains(w.Body.String(), `"code":1`) {
			t.Fatalf("legacy content allowed: %s", w.Body)
		}
	})
	t.Run("unknown-and-other-user-video-ids-never-reach-provider", func(t *testing.T) {
		blockProtocolNetwork(t)
		other := model.VideoTask{ID: "someone-elses-task", UserID: "other-user", Model: "model", ChannelID: "backend", UpstreamTaskID: "someone-upstream", Status: "completed"}
		if err := db.Create(&other).Error; err != nil {
			t.Fatal(err)
		}
		for _, id := range []string{"unknown-old-direct-id", "client_video_task_not_saved", other.ID, other.UpstreamTaskID} {
			for _, content := range []bool{false, true} {
				w := request("GET", "/videos/"+id+"?model=model", "", func(w http.ResponseWriter, r *http.Request) {
					if content {
						AIVideoContent(w, r, id)
					} else {
						AIVideo(w, r, id)
					}
				}, nil)
				if w.Code != http.StatusNotFound {
					t.Fatalf("unknown/foreign video %s content=%v returned %d", id, content, w.Code)
				}
			}
		}
	})
	t.Run("video-content-authority-is-bound-to-persisted-task", func(t *testing.T) {
		saved, _ := repository.GetSettings()
		decoy := model.ModelChannel{ID: "decoy", Name: "decoy", Protocol: "openai", BaseURL: "https://wrong-channel.invalid", APIKey: "wrong-key", Models: []string{"wrong-model"}, Enabled: true, Weight: 1}
		gemini := model.ModelChannel{ID: "gemini-task-channel", Name: "gemini", Protocol: "gemini", BaseURL: "https://gemini-backend.invalid", APIKey: "gemini-server-key", Models: []string{"veo"}, Enabled: true, Weight: 1}
		saved.Private.Channels = append(saved.Private.Channels, decoy, gemini)
		if _, err := repository.SaveSettings(saved, "video-content"); err != nil {
			t.Fatal(err)
		}
		tasks := []model.VideoTask{
			{ID: "content-task", UserID: user.ID, Model: "model", ChannelID: "backend", UpstreamTaskID: "provider-job", Status: "completed"},
			{ID: "gemini-content-task", UserID: user.ID, Model: "veo", ChannelID: gemini.ID, UpstreamTaskID: "operations/provider-job", VideoURL: "https://gemini-backend.invalid/protected/video", Status: "completed"},
		}
		for _, task := range tasks {
			if err := db.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
		}
		calls := 0
		protocolMockHTTP(t, func(r *http.Request) (*http.Response, error) {
			calls++
			if calls == 1 {
				if r.URL.String() != "https://backend.invalid/v1/videos/provider-job/content" || r.Header.Get("Authorization") != "Bearer backend-key-canary" {
					t.Errorf("client overrode saved task: %s", r.URL)
				}
			} else {
				if r.URL.String() != "https://gemini-backend.invalid/protected/video" || r.Header.Get("x-goog-api-key") != "gemini-server-key" {
					t.Errorf("Gemini task authority changed: %s", r.URL)
				}
			}
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"video/mp4"}}, Body: io.NopCloser(strings.NewReader("mock-video-content"))}, nil
		})
		for _, task := range tasks {
			w := request("GET", "/videos/"+task.ID+"/content?model=wrong-model", "", func(w http.ResponseWriter, r *http.Request) { AIVideoContent(w, r, task.ID) }, map[string]string{"X-Model-Channel-ID": "decoy"})
			if w.Code != 200 || w.Body.String() != "mock-video-content" {
				t.Fatalf("content failed: %d %s", w.Code, w.Body)
			}
			// Poll aliases still read the owner's persisted row and never query a provider.
			w = request("GET", "/videos/poll?model=wrong-model", "", func(w http.ResponseWriter, r *http.Request) { AIVideo(w, r, task.UpstreamTaskID) }, map[string]string{"X-Model-Channel-ID": "decoy"})
			if w.Code != 200 || !strings.Contains(w.Body.String(), task.ID) {
				t.Fatalf("stored poll alias failed: %s", w.Body)
			}
		}
		if calls != 2 {
			t.Fatalf("poll/content unexpected calls=%d", calls)
		}
	})
	t.Run("twenty-concurrent-producer-requests-keep-server-authority", func(t *testing.T) {
		var calls atomic.Int32
		protocolMockHTTP(t, func(r *http.Request) (*http.Response, error) {
			calls.Add(1)
			if r.URL.Host != "backend.invalid" || r.Header.Get("Authorization") != "Bearer backend-key-canary" {
				t.Error("crossed authority")
			}
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"choices":[]}`))}, nil
		})
		var wg sync.WaitGroup
		for i := 0; i < 20; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				w := request("POST", "/chat/completions", `{"model":"model"}`, AIChatCompletions, nil)
				if strings.Contains(w.Body.String(), `"code":1`) {
					t.Error("concurrent cloud request failed")
				}
			}()
		}
		wg.Wait()
		if calls.Load() != 20 {
			t.Fatalf("calls=%d", calls.Load())
		}
	})
	t.Run("empty-open-model-list-is-closed-with-private-channels-present", func(t *testing.T) {
		blockProtocolNetwork(t)
		saved, err := repository.GetSettings()
		if err != nil {
			t.Fatal(err)
		}
		saved.Public.ModelChannel.AvailableModels = []string{}
		if _, err := repository.SaveSettings(saved, "close-all-models"); err != nil {
			t.Fatal(err)
		}
		public, err := service.PublicSettings()
		if err != nil || len(public.ModelChannel.AvailableModels) != 0 || len(public.ModelChannel.Channels) != 0 || public.ModelChannel.DefaultModel != "" {
			t.Fatalf("empty publication expanded: %+v %v", public.ModelChannel, err)
		}
		for _, entry := range paths {
			w := request("POST", entry.path, `{"model":"model","prompt":"test"}`, entry.fn, nil)
			if !strings.Contains(w.Body.String(), `"code":1`) {
				t.Fatalf("closed model accepted at %s: %s", entry.path, w.Body)
			}
		}
		w := request("POST", "/workflows/agent-draft", `{"prompt":"hello","model":"model","channelId":"backend"}`, DraftUserWorkflow, nil)
		if !strings.Contains(w.Body.String(), `"code":1`) {
			t.Fatal("draft accepted closed model")
		}
		if _, err := service.SelectModelChannelForModel("model", "backend", true); err == nil {
			t.Fatal("public resolver expanded empty list")
		}
		// Administrator configuration and previously authorized task lookups keep
		// their explicit private-channel access; this does not publish models.
		admin, err := service.AdminSettings()
		if err != nil || len(admin.Private.Channels) == 0 || len(admin.Private.Channels[0].Models) == 0 {
			t.Fatal("private admin model options lost")
		}
		if _, err := service.SelectModelChannelForModel("model", "backend", false); err != nil {
			t.Fatalf("private task channel lost: %v", err)
		}
	})

}
