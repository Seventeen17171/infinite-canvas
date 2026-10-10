package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const MaxProjectBudget int64 = 1_000_000_000

type ApplyProductionBudgetRequest struct {
	TargetTotal int64  `json:"targetTotal"`
	Reason      string `json:"reason"`
	RequestID   string `json:"requestId"`
}

type DecideProductionBudgetRequest struct {
	Decision  string `json:"decision"`
	Note      string `json:"note"`
	Revision  int64  `json:"revision"`
	RequestID string `json:"requestId"`
}

func normalizeBudgetRequestID(value string) (string, error) {
	id, err := uuid.Parse(value)
	if err != nil || len(value) != 36 || id == uuid.Nil {
		return "", projectError(http.StatusBadRequest, "requestId必须为UUID")
	}
	return id.String(), nil
}

func validBudgetNote(value string, required bool) bool {
	count := utf8.RuneCountInString(value)
	return (!required || count > 0) && count <= 500 && !strings.ContainsFunc(value, func(r rune) bool {
		return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t'
	})
}

func budgetRequestHash(operation, projectID, applicationID string, payload any) string {
	encoded, _ := json.Marshal(struct {
		Operation, ProjectID, ApplicationID string
		Payload                             any
	}{operation, projectID, applicationID, payload})
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:])
}

func productionBudgetView(tx *repository.ProductionTx, project model.ProductionProject, actor model.User) (model.ProductionProjectBudgetView, error) {
	budget, _, err := tx.ProjectBudget(project.ID)
	if err != nil {
		return model.ProductionProjectBudgetView{}, err
	}
	applications, total, err := tx.BudgetApplications(project.ID, "", model.Query{Page: 1, PageSize: 20})
	if err != nil {
		return model.ProductionProjectBudgetView{}, err
	}
	views, err := tx.BudgetApplicationViews(applications)
	if err != nil {
		return model.ProductionProjectBudgetView{}, err
	}
	_, pending, err := tx.BudgetApplications(project.ID, "pending", model.Query{Page: 1, PageSize: 1})
	canApply := actor.ID == project.ProducerID && budget.ApprovedTotal < MaxProjectBudget && pending == 0
	return model.ProductionProjectBudgetView{ProjectID: project.ID, ApprovedTotal: budget.ApprovedTotal, Revision: budget.Revision, CanApply: canApply, Applications: views, TotalApplications: total}, err
}

func GetProductionProjectBudget(ctx context.Context, projectID string) (model.ProductionProjectBudgetView, error) {
	var view model.ProductionProjectBudgetView
	err := repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		actor, _, err := productionActor(tx, ctx, "", false)
		if err != nil {
			return err
		}
		project, err := productionVisibleProject(tx, projectID, actor.ID)
		if err != nil {
			return err
		}
		view, err = productionBudgetView(tx, project, actor)
		return err
	})
	return view, err
}

func ApplyProductionProjectBudget(ctx context.Context, projectID string, request ApplyProductionBudgetRequest) (model.ProductionProjectBudgetView, error) {
	var view model.ProductionProjectBudgetView
	request.Reason = strings.TrimSpace(request.Reason)
	var err error
	request.RequestID, err = normalizeBudgetRequestID(request.RequestID)
	if err != nil {
		return view, err
	}
	if request.TargetTotal < 1 || request.TargetTotal > MaxProjectBudget || !validBudgetNote(request.Reason, true) {
		return view, projectError(http.StatusBadRequest, "目标总积分需为1至1000000000的整数，用途需为1至500字")
	}
	hash := budgetRequestHash("apply", projectID, "", request)
	err = repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		actor, _, err := productionActor(tx, ctx, "", true)
		if err != nil {
			return err
		}
		project, err := productionVisibleProject(tx, projectID, actor.ID, true)
		if err != nil {
			return err
		}
		if project.ProducerID != actor.ID {
			return projectError(http.StatusForbidden, "仅当前制作组长可申请项目积分")
		}
		previous, found, err := tx.BudgetRequest(actor.ID, request.RequestID)
		if err != nil {
			return err
		}
		if found {
			if previous.PayloadHash != hash {
				return projectError(http.StatusConflict, "此请求编号已用于其他预算操作")
			}
			view, err = productionBudgetView(tx, project, actor)
			view.ApplicationID = previous.ApplicationID
			return err
		}
		budget, found, err := tx.ProjectBudget(projectID)
		if err != nil {
			return err
		}
		if request.TargetTotal <= budget.ApprovedTotal {
			return projectError(http.StatusConflict, "目标总积分必须高于当前已批准总额")
		}
		_, pending, err := tx.BudgetApplications(projectID, "pending", model.Query{Page: 1, PageSize: 1})
		if err != nil {
			return err
		}
		if pending > 0 {
			return projectError(http.StatusConflict, "该项目已有待审批的积分申请，请等待审批")
		}
		timestamp := time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z")
		if !found {
			if err := tx.CreateProjectBudget(model.ProductionProjectBudget{ProjectID: projectID, Revision: 1, UpdatedAt: timestamp}); err != nil {
				return err
			}
		}
		application := model.ProductionBudgetApplication{ID: newID("budget"), ProjectID: projectID, PendingProjectID: &projectID, ApplicantID: actor.ID, ApplicantName: firstNonEmpty(actor.DisplayName, actor.Username), TargetTotal: request.TargetTotal, Reason: request.Reason, Status: "pending", Revision: 1, CreatedAt: timestamp, UpdatedAt: timestamp}
		if err := tx.CreateBudgetApplication(application); err != nil {
			return err
		}
		if err := tx.RecordBudgetRequest(model.ProductionBudgetRequest{ActorID: actor.ID, RequestID: request.RequestID, PayloadHash: hash, ProjectID: projectID, ApplicationID: application.ID}); err != nil {
			return err
		}
		view, err = productionBudgetView(tx, project, actor)
		view.ApplicationID = application.ID
		return err
	})
	return view, err
}

func productionBudgetAdmin(tx *repository.ProductionTx, ctx context.Context, lock bool) (model.User, error) {
	actor, _, err := productionActor(tx, ctx, "", lock)
	if err != nil {
		return actor, err
	}
	if actor.Role != model.UserRoleAdmin {
		return actor, projectError(http.StatusForbidden, "需要管理员审批权限")
	}
	return actor, nil
}

func ListProductionBudgetApplications(ctx context.Context, q model.Query, status string) (model.ProductionBudgetApplicationList, error) {
	var list model.ProductionBudgetApplicationList
	if status != "" && status != "pending" && status != "approved" && status != "rejected" {
		return list, projectError(http.StatusBadRequest, "申请状态无效")
	}
	q.Normalize()
	err := repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		if _, err := productionBudgetAdmin(tx, ctx, false); err != nil {
			return err
		}
		applications, total, err := tx.BudgetApplications("", status, q)
		if err != nil {
			return err
		}
		list.Total = total
		list.Items, err = tx.BudgetApplicationViews(applications)
		return err
	})
	return list, err
}

func DecideProductionProjectBudget(ctx context.Context, applicationID string, request DecideProductionBudgetRequest) (model.ProductionBudgetApplicationView, error) {
	var view model.ProductionBudgetApplicationView
	request.Note = strings.TrimSpace(request.Note)
	var err error
	request.RequestID, err = normalizeBudgetRequestID(request.RequestID)
	if err != nil {
		return view, err
	}
	if (request.Decision != "approved" && request.Decision != "rejected") || request.Revision < 1 || !validBudgetNote(request.Note, request.Decision == "rejected") {
		return view, projectError(http.StatusBadRequest, "审批决定、版本或说明无效")
	}
	err = repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		actor, err := productionBudgetAdmin(tx, ctx, true)
		if err != nil {
			return err
		}
		application, found, err := tx.BudgetApplication(applicationID)
		if err != nil {
			return err
		}
		if !found {
			return projectError(http.StatusNotFound, "积分申请不存在")
		}
		if _, found, err := tx.BudgetProject(application.ProjectID, true); err != nil {
			return err
		} else if !found {
			return projectError(http.StatusNotFound, "项目不存在")
		}
		// Re-read after the project lock: another administrator may have decided it.
		application, found, err = tx.BudgetApplication(applicationID)
		if err != nil {
			return err
		}
		if !found {
			return projectError(http.StatusNotFound, "积分申请不存在")
		}
		hash := budgetRequestHash("decide", application.ProjectID, application.ID, request)
		previous, replay, err := tx.BudgetRequest(actor.ID, request.RequestID)
		if err != nil {
			return err
		}
		if replay {
			if previous.PayloadHash != hash {
				return projectError(http.StatusConflict, "此请求编号已用于其他预算操作")
			}
			return json.Unmarshal([]byte(previous.DecisionJSON), &view)
		}
		if application.Status != "pending" || application.Revision != request.Revision {
			return projectError(http.StatusConflict, "申请已被处理或版本已更新，请重新载入")
		}
		budget, found, err := tx.ProjectBudget(application.ProjectID)
		if err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("budget missing for application %s", application.ID)
		}
		timestamp := time.Now().UTC().Format("2006-01-02T15:04:05.000000000Z")
		application.Status, application.PendingProjectID = request.Decision, nil
		application.DecidedBy, application.DecidedByName = actor.ID, firstNonEmpty(actor.DisplayName, actor.Username)
		application.DecisionNote, application.UpdatedAt, application.Revision = request.Note, timestamp, request.Revision+1
		if updated, err := tx.DecideBudgetApplication(application, request.Revision); err != nil {
			return err
		} else if !updated {
			return projectError(http.StatusConflict, "申请已被处理，请重新载入")
		}
		if request.Decision == "approved" {
			if application.TargetTotal <= budget.ApprovedTotal {
				return projectError(http.StatusConflict, "项目额度已变更，请重新申请")
			}
			grant := model.ProductionBudgetGrant{ID: newID("grant"), ProjectID: application.ProjectID, ApplicationID: application.ID, Amount: application.TargetTotal - budget.ApprovedTotal, ApprovedTotal: application.TargetTotal, ActorID: actor.ID, CreatedAt: timestamp}
			if updated, err := tx.GrantProjectBudget(budget, application.TargetTotal, grant); err != nil {
				return err
			} else if !updated {
				return projectError(http.StatusConflict, "项目额度已变更，请重新载入")
			}
		}
		views, err := tx.BudgetApplicationViews([]model.ProductionBudgetApplication{application})
		if err != nil {
			return err
		}
		view = views[0]
		encoded, err := json.Marshal(view)
		if err != nil {
			return err
		}
		return tx.RecordBudgetRequest(model.ProductionBudgetRequest{ActorID: actor.ID, RequestID: request.RequestID, PayloadHash: hash, ProjectID: application.ProjectID, ApplicationID: application.ID, DecisionJSON: string(encoded)})
	})
	return view, err
}
