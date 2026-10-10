package model

// ProductionAsset belongs to the business project, independent of its workspaces.
type ProductionAsset struct {
	ID          string `json:"id" gorm:"primaryKey;size:64"`
	ProjectID   string `json:"projectId" gorm:"index:idx_production_asset_scope,priority:1;size:64;not null"`
	Category    string `json:"category" gorm:"index:idx_production_asset_scope,priority:2;size:16;not null"`
	Name        string `json:"name" gorm:"size:80;not null"`
	Description string `json:"description" gorm:"type:text;not null"`
	Revision    int64  `json:"revision" gorm:"not null"`
	CreatedBy   string `json:"createdBy" gorm:"size:64;not null"`
	UpdatedBy   string `json:"updatedBy" gorm:"size:64;not null"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt" gorm:"index:idx_production_asset_scope,priority:3"`
}

type ProductionAssetCounts struct {
	Character int64 `json:"character"`
	Scene     int64 `json:"scene"`
}

type ProductionAssetList struct {
	Items  []ProductionAsset     `json:"items"`
	Total  int64                 `json:"total"`
	Counts ProductionAssetCounts `json:"counts"`
}

type ProductionAssetRequest struct {
	ActorID     string `gorm:"primaryKey;size:64"`
	RequestID   string `gorm:"primaryKey;size:36"`
	PayloadHash string `gorm:"size:64;not null"`
	Operation   string `gorm:"size:16;not null"`
	ProjectID   string `gorm:"size:64;not null"`
	AssetID     string `gorm:"size:64;not null"`
	Revision    int64  `gorm:"not null"`
	UpdatedAt   string
}

type ProductionAssetSaveReceipt struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	Revision  int64  `json:"revision"`
	UpdatedAt string `json:"updatedAt"`
	RequestID string `json:"requestId"`
}
