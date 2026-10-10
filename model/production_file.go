package model

// ProductionFile is immutable and never shared through the legacy public storage index.
type ProductionFile struct {
	ID         string `json:"-" gorm:"primaryKey;size:64"`
	ProjectID  string `json:"-" gorm:"index:idx_production_file_scope,priority:1;size:64;not null"`
	AssetID    string `json:"-" gorm:"index:idx_production_file_scope,priority:2;size:64;not null"`
	Name       string `json:"-" gorm:"size:180;not null"`
	MimeType   string `json:"-" gorm:"size:32;not null"`
	Bytes      int64  `json:"-" gorm:"not null"`
	StorageKey string `json:"-" gorm:"uniqueIndex;size:80;not null"`
	CreatedBy  string `json:"-" gorm:"size:64;not null"`
	CreatedAt  string `json:"-" gorm:"index:idx_production_file_scope,priority:3"`
}

type ProductionFileView struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	AssetID   string `json:"assetId"`
	Name      string `json:"name"`
	MimeType  string `json:"mimeType"`
	Bytes     int64  `json:"bytes"`
	CreatedAt string `json:"createdAt"`
}

type ProductionFileList struct {
	Items []ProductionFileView `json:"items"`
	Total int64                `json:"total"`
}
