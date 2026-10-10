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

func TestProductionBudgets(t *testing.T) {
	const marker = "PRODUCTION_BUDGET_TEST_CHILD"
	if os.Getenv(marker) != "1" {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestProductionBudgets$", "-test.timeout=85s", "-test.v")
		cmd.Env = append(os.Environ(), marker+"=1")
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("isolated budget API: %v\n%s", err, output)
		}
		t.Log(string(output))
		return
	}
	dsn := os.Getenv("PRODUCTION_BUDGET_RESTART_DSN")
	if dsn == "" {
		dsn = filepath.Join(t.TempDir(), "budgets.db")
	}
	config.Cfg = config.Config{StorageDriver: "sqlite", DatabaseDSN: dsn, JWTSecret: "synthetic-project-budget-secret"}
	gin.SetMode(gin.TestMode)
	gin.DefaultWriter = io.Discard
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	if os.Getenv("PRODUCTION_BUDGET_RESTART_DSN") != "" {
		var budget model.ProductionProjectBudget
		if err := db.Where("project_id = ?", os.Getenv("PRODUCTION_BUDGET_RESTART_PROJECT")).Take(&budget).Error; err != nil || budget.ApprovedTotal != 1600 {
			t.Fatalf("restart lost approved budget: %+v %v", budget, err)
		}
		var request service.DecideProductionBudgetRequest
		if err := json.Unmarshal([]byte(os.Getenv("PRODUCTION_BUDGET_RESTART_REQUEST")), &request); err != nil {
			t.Fatal(err)
		}
		ctx := service.WithUser(context.Background(), model.AuthUser{ID: "budget-admin", Role: model.UserRoleAdmin})
		view, err := service.DecideProductionProjectBudget(ctx, os.Getenv("PRODUCTION_BUDGET_RESTART_APPLICATION"), request)
		if err != nil || view.ApprovedTotal != 1000 || view.Status != "approved" {
			t.Fatalf("restart lost original receipt: %+v %v", view, err)
		}
		return
	}
	users := []model.User{
		{ID: "budget-leader", Username: "budget-leader", Role: model.UserRoleUser, Status: model.UserStatusActive, Credits: 321},
		{ID: "budget-admin", Username: "budget-admin", Role: model.UserRoleAdmin, Status: model.UserStatusActive, Credits: 654},
		{ID: "budget-other", Username: "budget-other", Role: model.UserRoleUser, Status: model.UserStatusActive, Credits: 987},
		{ID: "budget-manager", Username: "budget-manager", Role: model.UserRoleUser, Status: model.UserStatusActive, CanAssignProjects: true},
		{ID: "budget-admin-two", Username: "budget-admin-two", Role: model.UserRoleAdmin, Status: model.UserStatusActive},
		{ID: "budget-guest", Username: "budget-guest", Role: model.UserRoleGuest, Status: model.UserStatusActive},
	}
	tokens := make([]string, len(users))
	for i := range users {
		users[i].AffCode = users[i].ID
		if err := db.Create(&users[i]).Error; err != nil {
			t.Fatal(err)
		}
		tokens[i], err = jwt.NewWithClaims(jwt.SigningMethodHS256, service.TokenClaims{UserID: users[i].ID, Username: users[i].Username, Role: users[i].Role, RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}}).SignedString([]byte(config.Cfg.JWTSecret))
		if err != nil {
			t.Fatal(err)
		}
	}
	router := New()
	type result struct {
		Status int
		Body   []byte
	}
	call := func(method, path, token string, body any) result {
		encoded, _ := json.Marshal(body)
		r := httptest.NewRequest(method, path, bytes.NewReader(encoded))
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		router.ServeHTTP(w, r)
		return result{w.Code, w.Body.Bytes()}
	}
	request := func(t *testing.T, method, path, token string, body any, status int, target any) []byte {
		t.Helper()
		response := call(method, path, token, body)
		if response.Status != status {
			t.Fatalf("%s %s: status %d want %d: %s", method, path, response.Status, status, response.Body)
		}
		var envelope struct {
			Code int             `json:"code"`
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(response.Body, &envelope); err != nil {
			t.Fatal(err)
		}
		if status == 200 && envelope.Code != 0 {
			t.Fatalf("failed envelope: %s", response.Body)
		}
		if target != nil {
			if err := json.Unmarshal(envelope.Data, target); err != nil {
				t.Fatal(err)
			}
		}
		return envelope.Data
	}
	parallel := func(method, path string, tokenFor func(int) string, bodyFor func(int) any) []result {
		results := make([]result, 20)
		var wg sync.WaitGroup
		for i := range results {
			wg.Add(1)
			go func(i int) { defer wg.Done(); results[i] = call(method, path, tokenFor(i), bodyFor(i)) }(i)
		}
		wg.Wait()
		return results
	}
	createProject := func(t *testing.T, token, producer string) model.ProductionProjectView {
		t.Helper()
		var project model.ProductionProjectView
		body := map[string]any{"title": "预算测试项目", "requestId": uuid.NewString()}
		if producer != "" {
			body["producerId"] = producer
		}
		request(t, "POST", "/api/v1/production/projects", token, body, 200, &project)
		return project
	}
	baseFor := func(projectID string) string { return "/api/v1/production/projects/" + projectID }
	apply := func(t *testing.T, projectID, token string, amount int64) model.ProductionBudgetApplicationView {
		t.Helper()
		var budget model.ProductionProjectBudgetView
		request(t, "POST", baseFor(projectID)+"/budget-applications", token, map[string]any{"targetTotal": amount, "reason": "测试制作用途", "requestId": uuid.NewString()}, 200, &budget)
		if budget.ApplicationID == "" {
			t.Fatal("application response missing submitted application identity")
		}
		for _, item := range budget.Applications {
			if item.Status == "pending" {
				return item
			}
		}
		t.Fatal("new application missing")
		return model.ProductionBudgetApplicationView{}
	}
	decidePath := func(id string) string { return "/api/admin/production/budget-applications/" + id + "/decision" }
	decision := func(status string) map[string]any {
		return map[string]any{"decision": status, "note": "审核说明", "revision": 1, "requestId": uuid.NewString()}
	}
	var project model.ProductionProjectView
	var firstApplication model.ProductionBudgetApplicationView
	var firstDecision map[string]any
	t.Run("every-active-account-creates-own-project-with-canonical-replay", func(t *testing.T) {
		body := map[string]any{"title": "自主创建项目", "requestId": uuid.NewString()}
		request(t, "POST", "/api/v1/production/projects", tokens[0], body, 200, &project)
		if project.CreatedBy != users[0].ID || project.ProducerID != users[0].ID || len(project.Workspaces) != 2 {
			t.Fatalf("creator not default leader: %+v", project)
		}
		body["producerId"] = users[0].ID
		var repeated model.ProductionProjectView
		request(t, "POST", "/api/v1/production/projects", tokens[0], body, 200, &repeated)
		if repeated.ID != project.ID {
			t.Fatal("omitted and explicit own producer IDs must replay same project")
		}
		adminProject := createProject(t, tokens[1], "")
		if adminProject.ProducerID != users[1].ID {
			t.Fatal("administrator cannot lead own project")
		}
		body["requestId"], body["producerId"] = uuid.NewString(), users[2].ID
		request(t, "POST", "/api/v1/production/projects", tokens[0], body, 403, nil)
		request(t, "POST", "/api/v1/production/projects", tokens[5], body, 401, nil)
		request(t, "POST", "/api/v1/production/projects", "", body, 401, nil)
	})
	t.Run("unfunded-project-read-and-free-document-preparation", func(t *testing.T) {
		var budget model.ProductionProjectBudgetView
		request(t, "GET", baseFor(project.ID)+"/budget", tokens[0], nil, 200, &budget)
		if budget.ApprovedTotal != 0 || budget.Revision != 0 || !budget.CanApply || budget.Applications == nil {
			t.Fatalf("new project unexpectedly funded or blocked: %+v", budget)
		}
		request(t, "GET", baseFor(project.ID)+"/budget", tokens[2], nil, 404, nil)
		request(t, "GET", baseFor(project.ID)+"/budget", tokens[1], nil, 404, nil)
		body := map[string]any{"title": "免费筹备", "requestId": uuid.NewString(), "content": map[string]any{"schemaVersion": 1, "nodes": []any{}, "connections": []any{}, "viewport": map[string]any{"x": 0, "y": 0, "k": 1}, "backgroundMode": "lines"}}
		request(t, "POST", baseFor(project.ID)+"/workspaces/canvas/documents", tokens[0], body, 200, nil)
	})
	t.Run("twenty-identical-applications-create-one-pending-record", func(t *testing.T) {
		body := map[string]any{"targetTotal": 1000, "reason": "  首次制作预算  ", "requestId": uuid.NewString()}
		for _, response := range parallel("POST", baseFor(project.ID)+"/budget-applications", func(int) string { return tokens[0] }, func(int) any { return body }) {
			if response.Status != 200 {
				t.Fatalf("same-key application: %d %s", response.Status, response.Body)
			}
		}
		var budget model.ProductionProjectBudgetView
		request(t, "GET", baseFor(project.ID)+"/budget", tokens[0], nil, 200, &budget)
		if budget.TotalApplications != 1 || len(budget.Applications) != 1 || budget.CanApply || budget.ApprovedTotal != 0 {
			t.Fatalf("duplicate application or premature funding: %+v", budget)
		}
		firstApplication = budget.Applications[0]
		body["targetTotal"] = 1001
		request(t, "POST", baseFor(project.ID)+"/budget-applications", tokens[0], body, 409, nil)
		body["requestId"] = uuid.NewString()
		request(t, "POST", baseFor(project.ID)+"/budget-applications", tokens[0], body, 409, nil)
		request(t, "POST", baseFor(project.ID)+"/budget-applications", tokens[2], body, 404, nil)
	})
	t.Run("admin-sees-only-budget-metadata-and-twenty-identical-decisions-grant-once", func(t *testing.T) {
		var list model.ProductionBudgetApplicationList
		request(t, "GET", "/api/admin/production/budget-applications?status=pending&pageSize=1", tokens[1], nil, 200, &list)
		if list.Total != 1 || len(list.Items) != 1 || list.Items[0].ProjectTitle != project.Title || list.Items[0].ApplicantName != users[0].Username {
			t.Fatalf("admin metadata wrong: %+v", list)
		}
		request(t, "GET", baseFor(project.ID)+"/workspaces/canvas/documents", tokens[1], nil, 404, nil)
		request(t, "GET", "/api/admin/production/budget-applications", tokens[0], nil, 401, nil)
		firstDecision = decision("approved")
		request(t, "POST", decidePath(firstApplication.ID), tokens[0], firstDecision, 401, nil)
		for _, response := range parallel("POST", decidePath(firstApplication.ID), func(int) string { return tokens[1] }, func(int) any { return firstDecision }) {
			if response.Status != 200 {
				t.Fatalf("same-key approval: %d %s", response.Status, response.Body)
			}
		}
		var grants []model.ProductionBudgetGrant
		if err := db.Where("project_id = ?", project.ID).Find(&grants).Error; err != nil || len(grants) != 1 || grants[0].Amount != 1000 || grants[0].ApprovedTotal != 1000 {
			t.Fatalf("grant not exact-once: %+v %v", grants, err)
		}
		request(t, "POST", decidePath(firstApplication.ID), tokens[1], decision("rejected"), 409, nil)
		request(t, "POST", decidePath(firstApplication.ID), tokens[1], map[string]any{"decision": "rejected", "note": "审核说明", "revision": 1, "requestId": firstDecision["requestId"]}, 409, nil)
	})
	t.Run("additional-total-grants-only-delta-and-rejection-preserves-budget", func(t *testing.T) {
		second := apply(t, project.ID, tokens[0], 1600)
		request(t, "POST", decidePath(second.ID), tokens[1], decision("approved"), 200, nil)
		third := apply(t, project.ID, tokens[0], 2000)
		request(t, "POST", decidePath(third.ID), tokens[1], decision("rejected"), 200, nil)
		var budget model.ProductionProjectBudgetView
		request(t, "GET", baseFor(project.ID)+"/budget", tokens[0], nil, 200, &budget)
		if budget.ApprovedTotal != 1600 || !budget.CanApply || budget.TotalApplications != 3 {
			t.Fatalf("rejection changed funds: %+v", budget)
		}
		var sum int64
		db.Model(&model.ProductionBudgetGrant{}).Where("project_id = ?", project.ID).Select("SUM(amount)").Scan(&sum)
		if sum != 1600 {
			t.Fatalf("target was double-added: %d", sum)
		}
		var replay model.ProductionBudgetApplicationView
		request(t, "POST", decidePath(firstApplication.ID), tokens[1], firstDecision, 200, &replay)
		if replay.ApprovedTotal != 1000 || replay.Revision != 2 {
			t.Fatalf("decision replay did not return original immutable receipt: %+v", replay)
		}
		request(t, "POST", baseFor(project.ID)+"/budget-applications", tokens[0], map[string]any{"targetTotal": 1600, "reason": "不能重复总额", "requestId": uuid.NewString()}, 409, nil)
	})
	t.Run("twenty-competing-administrator-decisions-choose-one", func(t *testing.T) {
		otherProject := createProject(t, tokens[0], "")
		application := apply(t, otherProject.ID, tokens[0], 200)
		results := parallel("POST", decidePath(application.ID), func(i int) string {
			if i%2 == 0 {
				return tokens[1]
			}
			return tokens[4]
		}, func(i int) any {
			if i%2 == 0 {
				return decision("approved")
			}
			return decision("rejected")
		})
		success, conflicts := 0, 0
		for _, response := range results {
			switch response.Status {
			case 200:
				success++
			case 409:
				conflicts++
			default:
				t.Fatalf("competing decision failed: %d %s", response.Status, response.Body)
			}
		}
		if success != 1 || conflicts != 19 {
			t.Fatalf("decision race: %d success %d conflicts", success, conflicts)
		}
		var final model.ProductionBudgetApplication
		db.Where("id = ?", application.ID).Take(&final)
		var budget model.ProductionProjectBudget
		db.Where("project_id = ?", otherProject.ID).Take(&budget)
		var grants int64
		db.Model(&model.ProductionBudgetGrant{}).Where("project_id = ?", otherProject.ID).Count(&grants)
		if final.Status == "approved" && (budget.ApprovedTotal != 200 || grants != 1) || final.Status == "rejected" && (budget.ApprovedTotal != 0 || grants != 0) {
			t.Fatalf("decision/funds diverged: %+v %+v %d", final, budget, grants)
		}
	})
	t.Run("transaction-failure-rolls-back-budget-application-grant-and-receipt", func(t *testing.T) {
		rollbackProject := createProject(t, tokens[0], "")
		if err := db.Exec("CREATE TRIGGER budget_fail_receipt BEFORE INSERT ON production_budget_requests BEGIN SELECT RAISE(ABORT, 'synthetic budget receipt failure'); END;").Error; err != nil {
			t.Fatal(err)
		}
		body := map[string]any{"targetTotal": 300, "reason": "原子性测试", "requestId": uuid.NewString()}
		request(t, "POST", baseFor(rollbackProject.ID)+"/budget-applications", tokens[0], body, 500, nil)
		db.Exec("DROP TRIGGER budget_fail_receipt")
		for _, table := range []string{"production_project_budgets", "production_budget_applications", "production_budget_requests"} {
			var count int64
			if err := db.Table(table).Where("project_id = ?", rollbackProject.ID).Count(&count).Error; err != nil || count != 0 {
				t.Fatalf("application rollback failed %s: %d %v", table, count, err)
			}
		}
		var budget model.ProductionProjectBudgetView
		request(t, "POST", baseFor(rollbackProject.ID)+"/budget-applications", tokens[0], body, 200, &budget)
		application := budget.Applications[0]
		approval := decision("approved")
		if err := db.Exec("CREATE TRIGGER budget_fail_decision BEFORE INSERT ON production_budget_requests WHEN NEW.decision_json <> '' BEGIN SELECT RAISE(ABORT, 'synthetic decision receipt failure'); END;").Error; err != nil {
			t.Fatal(err)
		}
		request(t, "POST", decidePath(application.ID), tokens[1], approval, 500, nil)
		db.Exec("DROP TRIGGER budget_fail_decision")
		request(t, "GET", baseFor(rollbackProject.ID)+"/budget", tokens[0], nil, 200, &budget)
		var grants int64
		db.Model(&model.ProductionBudgetGrant{}).Where("project_id = ?", rollbackProject.ID).Count(&grants)
		if budget.ApprovedTotal != 0 || budget.Applications[0].Status != "pending" || budget.Applications[0].Revision != 1 || grants != 0 {
			t.Fatalf("decision rollback failed: %+v grants=%d", budget, grants)
		}
		request(t, "POST", decidePath(application.ID), tokens[1], approval, 200, nil)
	})
	t.Run("reassignment-ban-and-role-revocation-block-replays", func(t *testing.T) {
		assigned := createProject(t, tokens[3], users[0].ID)
		body := map[string]any{"targetTotal": 400, "reason": "负责人申请", "requestId": uuid.NewString()}
		request(t, "POST", baseFor(assigned.ID)+"/budget-applications", tokens[3], body, 403, nil)
		request(t, "POST", baseFor(assigned.ID)+"/budget-applications", tokens[0], body, 200, nil)
		request(t, "POST", baseFor(assigned.ID)+"/assignment", tokens[3], map[string]any{"producerId": users[2].ID, "revision": 1}, 200, nil)
		request(t, "POST", baseFor(assigned.ID)+"/budget-applications", tokens[0], body, 404, nil)
		request(t, "GET", baseFor(assigned.ID)+"/budget", tokens[0], nil, 404, nil)
		request(t, "GET", baseFor(assigned.ID)+"/budget", tokens[2], nil, 200, nil)
		db.Model(&model.User{}).Where("id = ?", users[0].ID).Update("status", "ban")
		request(t, "GET", baseFor(project.ID)+"/budget", tokens[0], nil, 401, nil)
		request(t, "POST", "/api/v1/production/projects", tokens[0], map[string]any{"title": "被禁用", "requestId": uuid.NewString()}, 401, nil)
		db.Model(&model.User{}).Where("id = ?", users[0].ID).Update("status", "active")
		db.Model(&model.User{}).Where("id = ?", users[1].ID).Update("role", "user")
		request(t, "POST", decidePath(firstApplication.ID), tokens[1], firstDecision, 401, nil)
		ctx := service.WithUser(context.Background(), model.AuthUser{ID: users[1].ID, Role: model.UserRoleAdmin})
		if _, err := service.DecideProductionProjectBudget(ctx, firstApplication.ID, service.DecideProductionBudgetRequest{Decision: "approved", Note: "审核说明", Revision: 1, RequestID: firstDecision["requestId"].(string)}); err == nil {
			t.Fatal("service trusted stale admin identity")
		}
		db.Model(&model.User{}).Where("id = ?", users[1].ID).Update("role", "admin")
	})
	t.Run("strict-input-validation-and-admin-query-limits", func(t *testing.T) {
		for _, amount := range []any{0, -1, 1.5, 1000000001, "100", 1e25, nil} {
			request(t, "POST", baseFor(project.ID)+"/budget-applications", tokens[0], map[string]any{"targetTotal": amount, "reason": "用途", "requestId": uuid.NewString()}, 400, nil)
		}
		for _, reason := range []string{"", "   ", strings.Repeat("字", 501), "bad\x00value"} {
			request(t, "POST", baseFor(project.ID)+"/budget-applications", tokens[0], map[string]any{"targetTotal": 2000, "reason": reason, "requestId": uuid.NewString()}, 400, nil)
		}
		request(t, "POST", baseFor(project.ID)+"/budget-applications", tokens[0], map[string]any{"targetTotal": 2000, "reason": "用途", "requestId": uuid.NewString(), "approvedTotal": 2000}, 400, nil)
		for _, suffix := range []string{"?status=invalid", "?page=0", "?pageSize=501", "?page=NaN"} {
			request(t, "GET", "/api/admin/production/budget-applications"+suffix, tokens[1], nil, 400, nil)
		}
		request(t, "POST", decidePath(firstApplication.ID), tokens[1], map[string]any{"decision": "approved", "note": "", "revision": 0, "requestId": uuid.NewString()}, 400, nil)
		request(t, "POST", decidePath(firstApplication.ID), tokens[1], map[string]any{"decision": "invalid", "note": "", "revision": 1, "requestId": uuid.NewString()}, 400, nil)
		request(t, "POST", decidePath(firstApplication.ID), tokens[1], map[string]any{"decision": "rejected", "note": "  ", "revision": 1, "requestId": uuid.NewString()}, 400, nil)
	})
	t.Run("historical-applicants-and-approvers-cannot-be-deleted", func(t *testing.T) {
		past := model.User{ID: "budget-past-leader", Username: "budget-past-leader", AffCode: "budget-past-leader", Role: model.UserRoleUser, Status: model.UserStatusActive}
		if err := db.Create(&past).Error; err != nil {
			t.Fatal(err)
		}
		assigned := createProject(t, tokens[3], past.ID)
		ctx := service.WithUser(context.Background(), model.AuthUser{ID: past.ID, Role: past.Role})
		if _, err := service.ApplyProductionProjectBudget(ctx, assigned.ID, service.ApplyProductionBudgetRequest{TargetTotal: 100, Reason: "历史申请人", RequestID: uuid.NewString()}); err != nil {
			t.Fatal(err)
		}
		request(t, "POST", baseFor(assigned.ID)+"/assignment", tokens[3], map[string]any{"producerId": users[2].ID, "revision": 1}, 200, nil)
		if err := service.DeleteUser(past.ID); err == nil {
			t.Fatal("past applicant deleted after reassignment")
		}
		independentProject := createProject(t, tokens[0], "")
		application := apply(t, independentProject.ID, tokens[0], 100)
		request(t, "POST", decidePath(application.ID), tokens[4], decision("approved"), 200, nil)
		if err := service.DeleteUser(users[4].ID); err == nil {
			t.Fatal("independent approver deleted")
		}
		plain := model.User{ID: "budget-unreferenced", Username: "budget-unreferenced", AffCode: "budget-unreferenced", Role: model.UserRoleUser, Status: model.UserStatusActive}
		if err := db.Create(&plain).Error; err != nil {
			t.Fatal(err)
		}
		if err := service.DeleteUser(plain.ID); err != nil {
			t.Fatalf("unreferenced account deletion blocked: %v", err)
		}
	})
	t.Run("history-is-limited-to-latest-twenty-and-pending-remains-visible", func(t *testing.T) {
		historyProject := createProject(t, tokens[0], "")
		firstRequest := map[string]any{"targetTotal": 100, "reason": "旧申请回放", "requestId": uuid.NewString()}
		var firstID string
		for i := 0; i < 21; i++ {
			var application model.ProductionBudgetApplicationView
			if i == 0 {
				var budget model.ProductionProjectBudgetView
				request(t, "POST", baseFor(historyProject.ID)+"/budget-applications", tokens[0], firstRequest, 200, &budget)
				application, firstID = budget.Applications[0], budget.ApplicationID
			} else {
				application = apply(t, historyProject.ID, tokens[0], 100)
			}
			request(t, "POST", decidePath(application.ID), tokens[1], decision("rejected"), 200, nil)
		}
		last := apply(t, historyProject.ID, tokens[0], 200)
		var budget model.ProductionProjectBudgetView
		request(t, "GET", baseFor(historyProject.ID)+"/budget", tokens[0], nil, 200, &budget)
		if budget.TotalApplications != 22 || len(budget.Applications) != 20 || budget.CanApply || budget.Applications[0].ID != last.ID {
			t.Fatalf("history window wrong: %+v", budget)
		}
		request(t, "POST", baseFor(historyProject.ID)+"/budget-applications", tokens[0], firstRequest, 200, &budget)
		if budget.ApplicationID != firstID || firstID == "" || budget.TotalApplications != 22 {
			t.Fatalf("old application replay lost identity or created duplicate: %+v", budget)
		}
	})
	t.Run("restart-reopens-budget-and-immutable-decision-receipt", func(t *testing.T) {
		encoded, _ := json.Marshal(firstDecision)
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestProductionBudgets$", "-test.timeout=12s")
		cmd.Env = append(os.Environ(), "PRODUCTION_BUDGET_RESTART_DSN="+dsn, "PRODUCTION_BUDGET_RESTART_PROJECT="+project.ID, "PRODUCTION_BUDGET_RESTART_APPLICATION="+firstApplication.ID, "PRODUCTION_BUDGET_RESTART_REQUEST="+string(encoded))
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("restart: %v\n%s", err, output)
		}
	})
	t.Run("personal-credit-balances-and-ledgers-remain-unchanged", func(t *testing.T) {
		for _, expected := range users {
			var actual model.User
			if err := db.Where("id = ?", expected.ID).Take(&actual).Error; err != nil || actual.Credits != expected.Credits {
				t.Fatalf("personal balance changed for %s: %v", expected.ID, err)
			}
		}
		var logs int64
		db.Model(&model.CreditLog{}).Count(&logs)
		if logs != 0 {
			t.Fatalf("project allocation wrote %d personal ledger rows", logs)
		}
		var sum int64
		db.Model(&model.ProductionBudgetGrant{}).Select("COALESCE(SUM(amount), 0)").Scan(&sum)
		t.Log(fmt.Sprintf("project-only grants total %d; personal logs %d", sum, logs))
	})
}
