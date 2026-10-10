package model

// ProductionFileUploadRequest is an immutable receipt, scoped to the submitting actor.
type ProductionFileUploadRequest struct {
	ActorID     string `gorm:"primaryKey;size:64"`
	RequestID   string `gorm:"primaryKey;size:36"`
	ProjectID   string `gorm:"size:64;not null"`
	AssetID     string `gorm:"size:64;not null"`
	FileID      string `gorm:"size:64;not null"`
	PayloadHash string `gorm:"size:64;not null"`
	CreatedAt   string
}

type ProductionFileUploadReceipt struct {
	RequestID string             `json:"requestId"`
	File      ProductionFileView `json:"file"`
}
