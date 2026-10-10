package model

// ProductionProjectBudget is a project's approved ceiling, independent of personal credits.
type ProductionProjectBudget struct {
	ProjectID     string `json:"projectId" gorm:"primaryKey;size:64"`
	ApprovedTotal int64  `json:"approvedTotal" gorm:"not null"`
	Revision      int64  `json:"revision" gorm:"not null"`
	UpdatedAt     string `json:"updatedAt"`
}

type ProductionBudgetApplication struct {
	ID               string  `json:"id" gorm:"primaryKey;size:64"`
	ProjectID        string  `json:"projectId" gorm:"index;size:64;not null"`
	PendingProjectID *string `json:"-" gorm:"uniqueIndex;size:64"`
	ApplicantID      string  `json:"applicantId" gorm:"index;size:64;not null"`
	ApplicantName    string  `json:"applicantName"`
	TargetTotal      int64   `json:"targetTotal" gorm:"not null"`
	Reason           string  `json:"reason" gorm:"type:text"`
	Status           string  `json:"status" gorm:"index;size:16;not null"`
	Revision         int64   `json:"revision" gorm:"not null"`
	DecidedBy        string  `json:"-" gorm:"index;size:64"`
	DecidedByName    string  `json:"decidedByName"`
	DecisionNote     string  `json:"decisionNote" gorm:"type:text"`
	CreatedAt        string  `json:"createdAt" gorm:"index"`
	UpdatedAt        string  `json:"updatedAt"`
}

type ProductionBudgetApplicationView struct {
	ProductionBudgetApplication
	ProjectTitle  string `json:"projectTitle"`
	ProducerName  string `json:"producerName"`
	ApprovedTotal int64  `json:"approvedTotal"`
}

type ProductionProjectBudgetView struct {
	ApplicationID     string                            `json:"applicationId,omitempty"`
	ProjectID         string                            `json:"projectId"`
	ApprovedTotal     int64                             `json:"approvedTotal"`
	Revision          int64                             `json:"revision"`
	CanApply          bool                              `json:"canApply"`
	Applications      []ProductionBudgetApplicationView `json:"applications"`
	TotalApplications int64                             `json:"totalApplications"`
}

type ProductionBudgetApplicationList struct {
	Items []ProductionBudgetApplicationView `json:"items"`
	Total int64                             `json:"total"`
}

// A grant records only an approved project allocation; no personal funds are transferred.
type ProductionBudgetGrant struct {
	ID            string `json:"id" gorm:"primaryKey;size:64"`
	ProjectID     string `json:"projectId" gorm:"index;size:64;not null"`
	ApplicationID string `json:"applicationId" gorm:"uniqueIndex;size:64;not null"`
	Amount        int64  `json:"amount" gorm:"not null"`
	ApprovedTotal int64  `json:"approvedTotal" gorm:"not null"`
	ActorID       string `json:"actorId" gorm:"index;size:64;not null"`
	CreatedAt     string `json:"createdAt"`
}

type ProductionBudgetRequest struct {
	ActorID       string `gorm:"primaryKey;size:64"`
	RequestID     string `gorm:"primaryKey;size:36"`
	PayloadHash   string `gorm:"size:64;not null"`
	ProjectID     string `gorm:"size:64;not null"`
	ApplicationID string `gorm:"size:64;not null"`
	DecisionJSON  string `gorm:"type:text"`
}
