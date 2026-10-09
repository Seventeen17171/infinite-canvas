package model

// ProductionProject is the team's business project, distinct from a personal CanvasProject.
type ProductionProject struct {
	ID         string `json:"id" gorm:"primaryKey;size:64"`
	Title      string `json:"title"`
	Summary    string `json:"summary" gorm:"type:text"`
	CreatedBy  string `json:"createdBy" gorm:"index;size:64;not null"`
	ProducerID string `json:"producerId" gorm:"index;size:64;not null"`
	Revision   int64  `json:"revision" gorm:"not null"`
	CreatedAt  string `json:"createdAt"`
	UpdatedAt  string `json:"updatedAt"`
}

type ProductionWorkspace struct {
	ID        string `json:"id" gorm:"primaryKey;size:64"`
	ProjectID string `json:"projectId" gorm:"uniqueIndex:idx_production_workspace;size:64;not null"`
	Kind      string `json:"kind" gorm:"uniqueIndex:idx_production_workspace;size:16;not null"`
	CreatedAt string `json:"createdAt"`
}

type ProjectRequest struct {
	ActorID     string `json:"-" gorm:"primaryKey;size:64"`
	RequestID   string `json:"-" gorm:"primaryKey;size:36"`
	PayloadHash string `json:"-" gorm:"size:64;not null"`
	ProjectID   string `json:"-" gorm:"size:64;not null"`
}

type ProductionProjectView struct {
	ProductionProject
	CreatorName  string                `json:"creatorName"`
	ProducerName string                `json:"producerName"`
	CanAssign    bool                  `json:"canAssign"`
	Workspaces   []ProductionWorkspace `json:"workspaces"`
}

type ProductionProjectList struct {
	Items []ProductionProjectView `json:"items"`
	Total int64                   `json:"total"`
}

type ProductionProducer struct {
	ID          string `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
}
