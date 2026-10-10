package repository

import (
	"errors"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func (tx *ProductionTx) File(projectID, id string) (model.ProductionFile, bool, error) {
	var file model.ProductionFile
	err := tx.db.Where("project_id = ? AND id = ?", projectID, id).Take(&file).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return file, false, nil
	}
	return file, err == nil, err
}

func (tx *ProductionTx) Files(projectID, assetID string, q model.Query) ([]model.ProductionFile, int64, error) {
	query := tx.db.Model(&model.ProductionFile{}).Where("project_id = ? AND asset_id = ?", projectID, assetID)
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	files := make([]model.ProductionFile, 0)
	err := query.Order("created_at DESC, id ASC").Offset(q.Offset()).Limit(q.PageSize).Find(&files).Error
	return files, total, err
}
