package repository

import (
	"errors"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func (tx *ProductionTx) CanvasWorkspace(projectID string) (model.ProductionWorkspace, bool, error) {
	var workspace model.ProductionWorkspace
	err := tx.db.Where("project_id = ? AND kind = ?", projectID, "canvas").Take(&workspace).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return workspace, false, nil
	}
	return workspace, err == nil, err
}

func (tx *ProductionTx) CanvasDocument(projectID, workspaceID, id string) (model.ProductionCanvasDocument, bool, error) {
	var document model.ProductionCanvasDocument
	err := tx.db.Where("project_id = ? AND workspace_id = ? AND id = ?", projectID, workspaceID, id).Take(&document).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return document, false, nil
	}
	return document, err == nil, err
}

func (tx *ProductionTx) CanvasDocuments(projectID, workspaceID string, q model.Query) (model.ProductionCanvasDocumentList, error) {
	result := model.ProductionCanvasDocumentList{Items: make([]model.ProductionCanvasDocument, 0)}
	query := tx.db.Model(&model.ProductionCanvasDocument{}).Where("project_id = ? AND workspace_id = ?", projectID, workspaceID)
	if err := query.Count(&result.Total).Error; err != nil {
		return result, err
	}
	err := query.Omit("content").Order("updated_at DESC, id ASC").Offset(q.Offset()).Limit(q.PageSize).Find(&result.Items).Error
	return result, err
}

func (tx *ProductionTx) CreateCanvasDocument(document model.ProductionCanvasDocument) error {
	return tx.db.Create(&document).Error
}

func (tx *ProductionTx) CanvasDocumentRequest(actorID, requestID string) (model.CanvasDocumentRequest, bool, error) {
	var request model.CanvasDocumentRequest
	err := tx.db.Where("actor_id = ? AND request_id = ?", actorID, requestID).Take(&request).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return request, false, nil
	}
	return request, err == nil, err
}

func (tx *ProductionTx) RecordCanvasDocumentRequest(request model.CanvasDocumentRequest) error {
	return tx.db.Create(&request).Error
}

func (tx *ProductionTx) SaveCanvasDocument(document model.ProductionCanvasDocument, revision int64) (bool, error) {
	result := tx.db.Model(&model.ProductionCanvasDocument{}).Where("id = ? AND project_id = ? AND workspace_id = ? AND revision = ?", document.ID, document.ProjectID, document.WorkspaceID, revision).Updates(map[string]any{"title": document.Title, "content": document.Content, "revision": gorm.Expr("revision + 1"), "updated_by": document.UpdatedBy, "updated_at": document.UpdatedAt})
	return result.RowsAffected == 1, result.Error
}
