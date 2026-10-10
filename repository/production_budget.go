package repository

import (
	"errors"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// BudgetProject is used only after service-level administrator authorization.
func (tx *ProductionTx) BudgetProject(id string, lock bool) (model.ProductionProject, bool, error) {
	var project model.ProductionProject
	query := tx.db.Where("id = ?", id)
	if lock && tx.db.Dialector.Name() != "sqlite" {
		query = query.Clauses(clause.Locking{Strength: "UPDATE"})
	}
	err := query.Take(&project).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return project, false, nil
	}
	return project, err == nil, err
}

func (tx *ProductionTx) ProjectBudget(projectID string) (model.ProductionProjectBudget, bool, error) {
	var budget model.ProductionProjectBudget
	err := tx.db.Where("project_id = ?", projectID).Take(&budget).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.ProductionProjectBudget{ProjectID: projectID}, false, nil
	}
	return budget, err == nil, err
}

func (tx *ProductionTx) CreateProjectBudget(budget model.ProductionProjectBudget) error {
	return tx.db.Create(&budget).Error
}

func (tx *ProductionTx) BudgetApplication(id string) (model.ProductionBudgetApplication, bool, error) {
	var application model.ProductionBudgetApplication
	err := tx.db.Where("id = ?", id).Take(&application).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return application, false, nil
	}
	return application, err == nil, err
}

func (tx *ProductionTx) BudgetApplications(projectID, status string, q model.Query) ([]model.ProductionBudgetApplication, int64, error) {
	query := tx.db.Model(&model.ProductionBudgetApplication{})
	if projectID != "" {
		query = query.Where("project_id = ?", projectID)
	}
	if status != "" {
		query = query.Where("status = ?", status)
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	items := make([]model.ProductionBudgetApplication, 0)
	err := query.Order("created_at DESC, id DESC").Offset(q.Offset()).Limit(q.PageSize).Find(&items).Error
	return items, total, err
}

func (tx *ProductionTx) CreateBudgetApplication(application model.ProductionBudgetApplication) error {
	return tx.db.Create(&application).Error
}

func (tx *ProductionTx) BudgetApplicationViews(applications []model.ProductionBudgetApplication) ([]model.ProductionBudgetApplicationView, error) {
	views := make([]model.ProductionBudgetApplicationView, 0, len(applications))
	if len(applications) == 0 {
		return views, nil
	}
	ids := make([]string, len(applications))
	for i, application := range applications {
		ids[i] = application.ID
	}
	var rows []model.ProductionBudgetApplicationView
	err := tx.db.Table("production_budget_applications AS a").Select("a.*, p.title AS project_title, COALESCE(NULLIF(u.display_name, ''), u.username, '') AS producer_name, COALESCE(b.approved_total, 0) AS approved_total").
		Joins("JOIN production_projects AS p ON p.id = a.project_id").
		Joins("LEFT JOIN users AS u ON u.id = p.producer_id").
		Joins("LEFT JOIN production_project_budgets AS b ON b.project_id = a.project_id").Where("a.id IN ?", ids).Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	byID := make(map[string]model.ProductionBudgetApplicationView, len(rows))
	for _, row := range rows {
		byID[row.ID] = row
	}
	for _, id := range ids {
		view, found := byID[id]
		if !found {
			return nil, gorm.ErrRecordNotFound
		}
		views = append(views, view)
	}
	return views, nil
}

func (tx *ProductionTx) BudgetRequest(actorID, requestID string) (model.ProductionBudgetRequest, bool, error) {
	var request model.ProductionBudgetRequest
	err := tx.db.Where("actor_id = ? AND request_id = ?", actorID, requestID).Take(&request).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return request, false, nil
	}
	return request, err == nil, err
}

func (tx *ProductionTx) RecordBudgetRequest(request model.ProductionBudgetRequest) error {
	return tx.db.Create(&request).Error
}

func (tx *ProductionTx) DecideBudgetApplication(application model.ProductionBudgetApplication, revision int64) (bool, error) {
	result := tx.db.Model(&model.ProductionBudgetApplication{}).Where("id = ? AND project_id = ? AND status = ? AND revision = ?", application.ID, application.ProjectID, "pending", revision).Updates(map[string]any{
		"status": application.Status, "revision": revision + 1, "pending_project_id": nil,
		"decided_by": application.DecidedBy, "decided_by_name": application.DecidedByName,
		"decision_note": application.DecisionNote, "updated_at": application.UpdatedAt,
	})
	return result.RowsAffected == 1, result.Error
}

func (tx *ProductionTx) GrantProjectBudget(budget model.ProductionProjectBudget, targetTotal int64, grant model.ProductionBudgetGrant) (bool, error) {
	result := tx.db.Model(&model.ProductionProjectBudget{}).Where("project_id = ? AND revision = ? AND approved_total = ?", budget.ProjectID, budget.Revision, budget.ApprovedTotal).Updates(map[string]any{
		"approved_total": targetTotal, "revision": budget.Revision + 1, "updated_at": grant.CreatedAt,
	})
	if result.Error != nil || result.RowsAffected != 1 {
		return false, result.Error
	}
	return true, tx.db.Create(&grant).Error
}
