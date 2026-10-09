package service

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type discoveryTransport func(*http.Request) (*http.Response, error)

func (f discoveryTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestCloudModelDiscovery(t *testing.T) {
	const marker = "CLOUD_MODEL_DISCOVERY_CHILD"
	if os.Getenv(marker) != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestCloudModelDiscovery$", "-test.timeout=20s", "-test.v")
		cmd.Env = append(os.Environ(), marker+"=1")
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("discovery: %v\n%s", err, output)
		}
		t.Log(string(output))
		return
	}
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: ":memory:", AILogDir: t.TempDir()}
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	conn, _ := db.DB()
	defer conn.Close()
	channel := model.ModelChannel{ID: "autodl-backend", Protocol: "autodl", BaseURL: "https://autodl-backend.invalid", APIKey: "backend-key", Enabled: true, Models: []string{"indextts2-v1", "minimax_h3_b99_002"}}
	settings := model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{channel}}, Public: model.PublicSetting{ModelChannel: model.PublicModelChannelSetting{AvailableModels: []string{"indextts2-v1"}}}}
	if _, err := repository.SaveSettings(settings, "fixture"); err != nil {
		t.Fatal(err)
	}
	calls := 0
	old := safeProxyHTTPClient
	t.Cleanup(func() { safeProxyHTTPClient = old })
	safeProxyHTTPClient = &http.Client{Transport: discoveryTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Host != "autodl-backend.invalid" {
			t.Fatalf("caller changed discovery host")
		}
		payload := `{"code":"Success","data":{"list":[{"uuid":"indextts2-v1","name":"audio"},{"uuid":"minimax_h3_b99_002","name":"hidden"},{"uuid":"unconfigured","name":"unconfigured"}],"max_page":1}}`
		if strings.HasSuffix(r.URL.Path, "/indextts2-v1") {
			payload = `{"code":"Success","data":{"uuid":"indextts2-v1","name":"audio","input_rules":{"text":{"type":"string"}}}}`
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(payload)), Header: http.Header{}}, nil
	})}
	user := model.AuthUser{ID: "producer", Role: model.UserRoleUser}
	result, err := UserAutoDLWorkflows(user, channel.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	items := result.([]AutoDLWorkflow)
	if len(items) != 1 || items[0].UUID != "indextts2-v1" {
		t.Fatalf("disclosed unopened workflow: %+v", items)
	}
	result, err = UserAutoDLWorkflows(user, channel.ID, "indextts2-v1")
	if err != nil || result.(AutoDLWorkflow).InputRules == nil {
		t.Fatalf("detail failed: %v", err)
	}
	before := calls
	for _, args := range [][2]string{{channel.ID, "minimax_h3_b99_002"}, {channel.ID, "unknown"}, {"personal", "indextts2-v1"}} {
		if _, err := UserAutoDLWorkflows(user, args[0], args[1]); err == nil {
			t.Fatalf("discovery override accepted: %v", args)
		}
	}
	if calls != before {
		t.Fatal("rejected discovery called upstream")
	}
	settings.Public.ModelChannel.AvailableModels = []string{}
	if _, err := repository.SaveSettings(settings, "no-open-models"); err != nil {
		t.Fatal(err)
	}
	empty, err := UserAutoDLWorkflows(user, channel.ID, "")
	if err != nil || len(empty.([]AutoDLWorkflow)) != 0 {
		t.Fatalf("empty publication disclosed discovery: %v %v", empty, err)
	}
	if _, err := UserAutoDLWorkflows(user, channel.ID, "indextts2-v1"); err == nil {
		t.Fatal("unpublished discovery detail accepted")
	}
	if calls != before {
		t.Fatal("unpublished discovery reached provider")
	}
	adminItems, err := UserAutoDLWorkflows(model.AuthUser{ID: "administrator", Role: model.UserRoleAdmin}, channel.ID, "")
	if err != nil || len(adminItems.([]AutoDLWorkflow)) != 2 {
		t.Fatalf("admin configured model discovery lost: %v %v", adminItems, err)
	}
	settings.Private.Channels[0].Enabled = false
	if _, err := repository.SaveSettings(settings, "disabled"); err != nil {
		t.Fatal(err)
	}
	if _, err := UserAutoDLWorkflows(user, channel.ID, ""); err == nil {
		t.Fatal("disabled channel discovered")
	}
	if calls != before {
		t.Fatal("disabled channel called upstream")
	}
	// The storage-only payload cannot restore any personal model connection data.
	legacy := `{"localChannels":[{"apiKey":"private-key"}],"syncStorageConfig":true,"syncWebDAVStorageConfig":true}`
	if err := db.Save(&model.UserConfig{UserID: user.ID, ModelConfig: legacy}).Error; err != nil {
		t.Fatal(err)
	}
	value, err := CurrentUserConfig(WithUser(context.Background(), user))
	encoded, _ := json.Marshal(value)
	if err != nil || strings.Contains(string(encoded), "private-key") || !value.StorageSync.S3 || !value.StorageSync.WebDAV {
		t.Fatalf("storage flags/privacy failed %s %v", encoded, err)
	}
	t.Run("system-workflows-require-explicit-publication", func(t *testing.T) {
		account := model.User{ID: user.ID, Username: user.ID, Role: model.UserRoleUser, Status: model.UserStatusActive, Credits: 100}
		if err := db.Create(&account).Error; err != nil {
			t.Fatal(err)
		}
		ref := WorkflowRef{Scope: "system", ChannelID: "managed-workflow", Kind: "workflow", WorkflowID: "configured-workflow"}
		workflowChannel := model.ModelChannel{ID: ref.ChannelID, Name: "managed workflow", Protocol: "runninghub", BaseURL: "https://managed-workflow.invalid", APIKey: "managed-workflow-key", Enabled: true, Workflows: []model.WorkflowEntry{{Provider: "runninghub", Kind: ref.Kind, WorkflowID: ref.WorkflowID, Title: "test workflow", Capability: "image", Enabled: true, Fields: []model.WorkflowFieldMapping{}}}}
		setting := model.Settings{Private: model.PrivateSetting{Channels: []model.ModelChannel{workflowChannel}}}
		if _, err := repository.SaveSettings(setting, "workflow-closed"); err != nil {
			t.Fatal(err)
		}
		workflowCalls := 0
		safeProxyHTTPClient = &http.Client{Transport: discoveryTransport(func(r *http.Request) (*http.Response, error) {
			workflowCalls++
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if r.URL.String() != "https://managed-workflow.invalid/task/openapi/create" || body["apiKey"] != "managed-workflow-key" || body["workflowId"] != ref.WorkflowID {
				t.Fatalf("workflow authority changed: %s", r.URL)
			}
			return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(`{"code":0,"data":{"taskId":"managed-upstream-task"}}`))}, nil
		})}
		public, err := PublicSettings()
		if err != nil || len(public.ModelChannel.Channels) != 0 || len(public.ModelChannel.AvailableWorkflows) != 0 {
			t.Fatalf("empty workflow publication expanded: %+v %v", public.ModelChannel, err)
		}
		input := WorkflowRunInput{Ref: ref, ExpectedCapability: "image", Prompt: "test", ClientTaskID: "workflow-policy-fixture"}
		if _, err := CreateWorkflowTask(context.Background(), user, input); err == nil {
			t.Fatal("ordinary user executed unpublished workflow")
		}
		if workflowCalls != 0 {
			t.Fatal("unpublished workflow reached provider")
		}
		if _, err := ResolveWorkflowForUser(model.AuthUser{ID: "administrator", Role: model.UserRoleAdmin}, ref); err != nil {
			t.Fatalf("administrator private workflow management blocked: %v", err)
		}
		setting.Public.ModelChannel.AvailableWorkflows = []string{workflowBillingName(ref)}
		if _, err := repository.SaveSettings(setting, "workflow-opened"); err != nil {
			t.Fatal(err)
		}
		public, err = PublicSettings()
		if err != nil || len(public.ModelChannel.Channels) != 1 || len(public.ModelChannel.Channels[0].Workflows) != 1 {
			t.Fatalf("published workflow unavailable: %+v %v", public.ModelChannel, err)
		}
		task, err := CreateWorkflowTask(context.Background(), user, input)
		if err != nil || task.Status != "running" || workflowCalls != 1 {
			t.Fatalf("published workflow execution failed: %+v %v calls=%d", task, err, workflowCalls)
		}
	})

}
