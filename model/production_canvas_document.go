package model

import "encoding/json"

type ProductionCanvasDocument struct {
	ID          string          `json:"id" gorm:"primaryKey;size:64"`
	ProjectID   string          `json:"projectId" gorm:"index:idx_production_document_scope,priority:1;size:64;not null"`
	WorkspaceID string          `json:"workspaceId" gorm:"index:idx_production_document_scope,priority:2;size:64;not null"`
	Title       string          `json:"title"`
	Content     json.RawMessage `json:"content,omitempty" gorm:"type:text;not null"`
	Revision    int64           `json:"revision" gorm:"not null"`
	CreatedBy   string          `json:"createdBy" gorm:"size:64;not null"`
	UpdatedBy   string          `json:"updatedBy" gorm:"size:64;not null"`
	CreatedAt   string          `json:"createdAt"`
	UpdatedAt   string          `json:"updatedAt" gorm:"index:idx_production_document_scope,priority:3"`
}

type ProductionCanvasDocumentList struct {
	Items []ProductionCanvasDocument `json:"items"`
	Total int64                      `json:"total"`
}

type CanvasDocumentRequest struct {
	ActorID     string `gorm:"primaryKey;size:64"`
	RequestID   string `gorm:"primaryKey;size:36"`
	PayloadHash string `gorm:"size:64;not null"`
	Operation   string `gorm:"size:16;not null"`
	ProjectID   string `gorm:"size:64;not null"`
	WorkspaceID string `gorm:"size:64;not null"`
	DocumentID  string `gorm:"size:64;not null"`
	Revision    int64  `gorm:"not null"`
	UpdatedAt   string
}

type ProductionCanvasSaveReceipt struct {
	ID          string `json:"id"`
	ProjectID   string `json:"projectId"`
	WorkspaceID string `json:"workspaceId"`
	Revision    int64  `json:"revision"`
	UpdatedAt   string `json:"updatedAt"`
	RequestID   string `json:"requestId"`
}
