package repository

import (
	"context"
	"errors"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

var ErrUserReferencedByProject = errors.New("user is referenced by a production project")

// ProductionTx keeps every query in a project operation on the same transaction.
type ProductionTx struct{ db *gorm.DB }

func ProductionTransaction(ctx context.Context, fn func(*ProductionTx) error) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error { return fn(&ProductionTx{db: tx}) })
}

func (tx *ProductionTx) Users(ids []string, lock bool) ([]model.User, error) {
	query := tx.db.Where("id IN ?", ids).Order("id")
	if lock && tx.db.Dialector.Name() != "sqlite" {
		query = query.Clauses(clause.Locking{Strength: "UPDATE"})
	}
	var users []model.User
	err := query.Find(&users).Error
	return users, err
}

func (tx *ProductionTx) Request(actorID, requestID string) (model.ProjectRequest, bool, error) {
	var request model.ProjectRequest
	err := tx.db.Where("actor_id = ? AND request_id = ?", actorID, requestID).Take(&request).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return request, false, nil
	}
	return request, err == nil, err
}

func (tx *ProductionTx) Project(id, actorID string, lock ...bool) (model.ProductionProject, bool, error) {
	var project model.ProductionProject
	query := tx.db.Where("id = ? AND (created_by = ? OR producer_id = ?)", id, actorID, actorID)
	if len(lock) > 0 && lock[0] && tx.db.Dialector.Name() != "sqlite" {
		query = query.Clauses(clause.Locking{Strength: "UPDATE"})
	}
	err := query.Take(&project).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return project, false, nil
	}
	return project, err == nil, err
}

func (tx *ProductionTx) Projects(actorID string, q model.Query) ([]model.ProductionProject, int64, error) {
	query := tx.db.Model(&model.ProductionProject{}).Where("(created_by = ? OR producer_id = ?)", actorID, actorID)
	if keyword := strings.TrimSpace(q.Keyword); keyword != "" {
		query = query.Where("title LIKE ?", "%"+keyword+"%")
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	projects := make([]model.ProductionProject, 0)
	err := query.Order("created_at DESC, id ASC").Offset(q.Offset()).Limit(q.PageSize).Find(&projects).Error
	return projects, total, err
}

func (tx *ProductionTx) Workspaces(projectIDs []string) ([]model.ProductionWorkspace, error) {
	spaces := make([]model.ProductionWorkspace, 0)
	if len(projectIDs) == 0 {
		return spaces, nil
	}
	err := tx.db.Where("project_id IN ?", projectIDs).Order("kind DESC").Find(&spaces).Error
	return spaces, err
}

func (tx *ProductionTx) Producers() ([]model.ProductionProducer, error) {
	items := make([]model.ProductionProducer, 0)
	err := tx.db.Model(&model.User{}).Select("id, username, display_name").Where("role = ? AND status = ?", model.UserRoleUser, model.UserStatusActive).Order("display_name, username, id").Find(&items).Error
	return items, err
}

func (tx *ProductionTx) Create(project model.ProductionProject, spaces []model.ProductionWorkspace, request model.ProjectRequest) error {
	if err := tx.db.Create(&project).Error; err != nil {
		return err
	}
	if err := tx.db.Create(&spaces).Error; err != nil {
		return err
	}
	return tx.db.Create(&request).Error
}

func (tx *ProductionTx) Assign(id, producerID string, revision int64, timestamp string) (bool, error) {
	result := tx.db.Model(&model.ProductionProject{}).Where("id = ? AND revision = ?", id, revision).Updates(map[string]any{
		"producer_id": producerID, "revision": gorm.Expr("revision + 1"), "updated_at": timestamp,
	})
	return result.RowsAffected == 1, result.Error
}
