package repository

import (
	"errors"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func (tx *ProductionTx) Asset(projectID, id string) (model.ProductionAsset, bool, error) {
	var asset model.ProductionAsset
	err := tx.db.Where("project_id = ? AND id = ?", projectID, id).Take(&asset).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return asset, false, nil
	}
	return asset, err == nil, err
}

func (tx *ProductionTx) Assets(projectID string, q model.Query) (model.ProductionAssetList, error) {
	result := model.ProductionAssetList{Items: make([]model.ProductionAsset, 0)}
	var counts []struct {
		Category string
		Total    int64
	}
	if err := tx.db.Model(&model.ProductionAsset{}).Select("category, COUNT(*) AS total").Where("project_id = ?", projectID).Group("category").Scan(&counts).Error; err != nil {
		return result, err
	}
	for _, count := range counts {
		if count.Category == "character" {
			result.Counts.Character = count.Total
		} else if count.Category == "scene" {
			result.Counts.Scene = count.Total
		}
	}
	query := tx.db.Model(&model.ProductionAsset{}).Where("project_id = ?", projectID)
	if q.Category != "" {
		query = query.Where("category = ?", q.Category)
	}
	if q.Keyword != "" {
		// Treat %, _ and the escape character literally, rather than as query wildcards.
		pattern := "%" + strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(q.Keyword) + "%"
		query = query.Where("(LOWER(name) LIKE LOWER(?) ESCAPE '!' OR LOWER(description) LIKE LOWER(?) ESCAPE '!')", pattern, pattern)
	}
	if err := query.Count(&result.Total).Error; err != nil {
		return result, err
	}
	err := query.Order("updated_at DESC, id ASC").Offset(q.Offset()).Limit(q.PageSize).Find(&result.Items).Error
	return result, err
}

func (tx *ProductionTx) CreateAsset(asset model.ProductionAsset) error {
	return tx.db.Create(&asset).Error
}

func (tx *ProductionTx) AssetRequest(actorID, requestID string) (model.ProductionAssetRequest, bool, error) {
	var request model.ProductionAssetRequest
	err := tx.db.Where("actor_id = ? AND request_id = ?", actorID, requestID).Take(&request).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return request, false, nil
	}
	return request, err == nil, err
}

func (tx *ProductionTx) RecordAssetRequest(request model.ProductionAssetRequest) error {
	return tx.db.Create(&request).Error
}

func (tx *ProductionTx) SaveAsset(asset model.ProductionAsset, revision int64) (bool, error) {
	result := tx.db.Model(&model.ProductionAsset{}).Where("id = ? AND project_id = ? AND revision = ?", asset.ID, asset.ProjectID, revision).Updates(map[string]any{
		"name": asset.Name, "description": asset.Description, "revision": gorm.Expr("revision + 1"), "updated_by": asset.UpdatedBy, "updated_at": asset.UpdatedAt,
	})
	return result.RowsAffected == 1, result.Error
}
