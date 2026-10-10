package repository

import (
	"errors"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func (tx *ProductionTx) AssetCreative(projectID, assetID string) (model.ProductionAssetCreative, bool, error) {
	var creative model.ProductionAssetCreative
	err := tx.db.Where("project_id = ? AND asset_id = ?", projectID, assetID).Take(&creative).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return creative, false, nil
	}
	return creative, err == nil, err
}

func (tx *ProductionTx) SaveAssetCreative(creative model.ProductionAssetCreative, revision int64) (bool, error) {
	if revision == 0 {
		result := tx.db.Clauses(clause.OnConflict{DoNothing: true}).Create(&creative)
		return result.RowsAffected == 1, result.Error
	}
	result := tx.db.Model(&model.ProductionAssetCreative{}).Where("project_id = ? AND asset_id = ? AND revision = ?", creative.ProjectID, creative.AssetID, revision).Updates(map[string]any{
		"prompt": creative.Prompt, "model_channel_id": creative.ModelChannelID, "model_name": creative.ModelName,
		"aspect_ratio": creative.AspectRatio, "resolution": creative.Resolution, "image_count": creative.ImageCount,
		"revision": gorm.Expr("revision + 1"), "updated_by": creative.UpdatedBy, "updated_at": creative.UpdatedAt,
	})
	return result.RowsAffected == 1, result.Error
}

func (tx *ProductionTx) AssetCreativeRequest(actorID, requestID string) (model.ProductionAssetCreativeRequest, bool, error) {
	var request model.ProductionAssetCreativeRequest
	err := tx.db.Where("actor_id = ? AND request_id = ?", actorID, requestID).Take(&request).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return request, false, nil
	}
	return request, err == nil, err
}

func (tx *ProductionTx) RecordAssetCreativeRequest(request model.ProductionAssetCreativeRequest) error {
	return tx.db.Create(&request).Error
}
