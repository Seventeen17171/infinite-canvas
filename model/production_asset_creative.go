package model

// ProductionAssetCreative stores preparation intent, not a submitted model task.
type ProductionAssetCreative struct {
	ProjectID      string `json:"projectId" gorm:"primaryKey;size:64"`
	AssetID        string `json:"assetId" gorm:"primaryKey;size:64"`
	Prompt         string `json:"prompt" gorm:"type:text;not null"`
	ModelChannelID string `json:"modelChannelId" gorm:"size:128;not null"`
	ModelName      string `json:"modelName" gorm:"size:256;not null"`
	AspectRatio    string `json:"aspectRatio" gorm:"size:16;not null"`
	Resolution     string `json:"resolution" gorm:"size:16;not null"`
	ImageCount     int    `json:"imageCount" gorm:"not null"`
	Revision       int64  `json:"revision" gorm:"not null"`
	UpdatedBy      string `json:"-" gorm:"size:64;not null"`
	UpdatedAt      string `json:"updatedAt"`
}

type ProductionCreativeModel struct {
	ChannelID   string `json:"channelId"`
	ChannelName string `json:"channelName"`
	Model       string `json:"model"`
	Protocol    string `json:"protocol"`
}

type ProductionAssetCreativeDetail struct {
	Creative ProductionAssetCreative   `json:"creative"`
	Models   []ProductionCreativeModel `json:"models"`
}

type ProductionAssetCreativeRequest struct {
	ActorID     string `gorm:"primaryKey;size:64"`
	RequestID   string `gorm:"primaryKey;size:36"`
	PayloadHash string `gorm:"size:64;not null"`
	ProjectID   string `gorm:"size:64;not null"`
	AssetID     string `gorm:"size:64;not null"`
	Revision    int64  `gorm:"not null"`
	UpdatedAt   string
}

type ProductionAssetCreativeReceipt struct {
	ProjectID string `json:"projectId"`
	AssetID   string `json:"assetId"`
	Revision  int64  `json:"revision"`
	UpdatedAt string `json:"updatedAt"`
	RequestID string `json:"requestId"`
}
