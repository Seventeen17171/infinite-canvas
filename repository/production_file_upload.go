package repository

import (
	"errors"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func (tx *ProductionTx) FileUploadRequest(actorID, requestID string) (model.ProductionFileUploadRequest, bool, error) {
	var request model.ProductionFileUploadRequest
	err := tx.db.Where("actor_id = ? AND request_id = ?", actorID, requestID).Take(&request).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return request, false, nil
	}
	return request, err == nil, err
}

func (tx *ProductionTx) FileUsage(projectID string) (int64, int64, error) {
	var usage struct {
		Count int64
		Bytes int64
	}
	err := tx.db.Model(&model.ProductionFile{}).Select("COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes").Where("project_id = ?", projectID).Scan(&usage).Error
	return usage.Count, usage.Bytes, err
}

func (tx *ProductionTx) CreateUploadedFile(file model.ProductionFile, receipt model.ProductionFileUploadRequest) error {
	if err := tx.db.Create(&file).Error; err != nil {
		return err
	}
	return tx.db.Create(&receipt).Error
}
