package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type ProductionError struct {
	Status  int
	Message string
}

func (err ProductionError) Error() string       { return err.Message }
func (err ProductionError) SafeMessage() string { return err.Message }

func projectError(status int, message string) error {
	return ProductionError{Status: status, Message: message}
}

type CreateProductionProjectRequest struct {
	Title      string `json:"title"`
	Summary    string `json:"summary"`
	ProducerID string `json:"producerId"`
	RequestID  string `json:"requestId"`
}

type AssignProductionProjectRequest struct {
	ProducerID string `json:"producerId"`
	Revision   int64  `json:"revision"`
}

func normalizeProductionRequest(request CreateProductionProjectRequest) (CreateProductionProjectRequest, error) {
	request.Title = strings.TrimSpace(request.Title)
	request.Summary = strings.TrimSpace(request.Summary)
	request.ProducerID = strings.TrimSpace(request.ProducerID)
	id, err := uuid.Parse(request.RequestID)
	if err != nil || len(request.RequestID) != 36 || id == uuid.Nil {
		return request, projectError(http.StatusBadRequest, "requestId必须为UUID")
	}
	request.RequestID = id.String()
	if utf8.RuneCountInString(request.Title) < 1 || utf8.RuneCountInString(request.Title) > 80 || strings.ContainsFunc(request.Title, unicode.IsControl) {
		return request, projectError(http.StatusBadRequest, "项目名称需为1–80字且不能含控制字符")
	}
	if utf8.RuneCountInString(request.Summary) > 500 || strings.ContainsFunc(request.Summary, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' }) {
		return request, projectError(http.StatusBadRequest, "项目说明最多500字，不能含异常控制字符")
	}
	if !validProductionID(request.ProducerID) {
		return request, projectError(http.StatusBadRequest, "请选择有效制作负责人")
	}
	return request, nil
}

func validProductionID(id string) bool {
	return id != "" && len(id) <= 64 && !strings.ContainsFunc(id, unicode.IsControl)
}

func productionActor(tx *repository.ProductionTx, ctx context.Context, producerID string, lock bool) (model.User, map[string]model.User, error) {
	identity, ok := UserFromContext(ctx)
	if !ok || identity.ID == "" {
		return model.User{}, nil, projectError(http.StatusUnauthorized, "请先登录")
	}
	ids := []string{identity.ID}
	if producerID != "" && producerID != identity.ID {
		ids = append(ids, producerID)
	}
	users, err := tx.Users(ids, lock)
	if err != nil {
		return model.User{}, nil, err
	}
	byID := make(map[string]model.User, len(users))
	for _, user := range users {
		byID[user.ID] = user
	}
	actor, found := byID[identity.ID]
	if !found || actor.Status != model.UserStatusActive || (actor.Role != model.UserRoleUser && actor.Role != model.UserRoleAdmin) {
		return model.User{}, nil, projectError(http.StatusUnauthorized, "登录状态无效或账号已禁用")
	}
	return actor, byID, nil
}

func productionProjectView(tx *repository.ProductionTx, projects []model.ProductionProject, actor model.User) ([]model.ProductionProjectView, error) {
	ids, users := make([]string, 0, len(projects)), make([]string, 0, len(projects)*2)
	for _, project := range projects {
		ids = append(ids, project.ID)
		users = append(users, project.CreatedBy, project.ProducerID)
	}
	people, err := tx.Users(users, false)
	if err != nil {
		return nil, err
	}
	names := make(map[string]string, len(people))
	for _, person := range people {
		names[person.ID] = firstNonEmpty(person.DisplayName, person.Username)
	}
	spaces, err := tx.Workspaces(ids)
	if err != nil {
		return nil, err
	}
	byProject := make(map[string][]model.ProductionWorkspace)
	for _, space := range spaces {
		byProject[space.ProjectID] = append(byProject[space.ProjectID], space)
	}
	result := make([]model.ProductionProjectView, 0, len(projects))
	for _, project := range projects {
		result = append(result, model.ProductionProjectView{ProductionProject: project, CreatorName: names[project.CreatedBy], ProducerName: names[project.ProducerID], CanAssign: project.CreatedBy == actor.ID && actor.MayAssignProjects(), Workspaces: byProject[project.ID]})
	}
	return result, nil
}

func productionVisibleProject(tx *repository.ProductionTx, id, actorID string, lock ...bool) (model.ProductionProject, error) {
	project, found, err := tx.Project(id, actorID, lock...)
	if err != nil {
		return project, err
	}
	if !found {
		return project, projectError(http.StatusNotFound, "项目不存在或未分派给你")
	}
	return project, nil
}

func ListProductionProjects(ctx context.Context, query model.Query) (model.ProductionProjectList, error) {
	var list model.ProductionProjectList
	err := repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		actor, _, err := productionActor(tx, ctx, "", false)
		if err != nil {
			return err
		}
		projects, total, err := tx.Projects(actor.ID, query)
		if err != nil {
			return err
		}
		list.Items, err = productionProjectView(tx, projects, actor)
		list.Total = total
		return err
	})
	return list, err
}

func ProductionProducers(ctx context.Context) ([]model.ProductionProducer, error) {
	var items []model.ProductionProducer
	err := repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		actor, _, err := productionActor(tx, ctx, "", false)
		if err != nil {
			return err
		}
		if !actor.MayAssignProjects() {
			return projectError(http.StatusForbidden, "需要项目分派权限")
		}
		items, err = tx.Producers()
		return err
	})
	return items, err
}

func GetProductionProject(ctx context.Context, id string) (model.ProductionProjectView, error) {
	var view model.ProductionProjectView
	err := repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		actor, _, err := productionActor(tx, ctx, "", false)
		if err != nil {
			return err
		}
		project, err := productionVisibleProject(tx, id, actor.ID)
		if err != nil {
			return err
		}
		views, err := productionProjectView(tx, []model.ProductionProject{project}, actor)
		if err == nil {
			view = views[0]
		}
		return err
	})
	return view, err
}

func GetProductionWorkspace(ctx context.Context, id, kind string) (model.ProductionProjectView, model.ProductionWorkspace, error) {
	if kind != "canvas" && kind != "assets" {
		return model.ProductionProjectView{}, model.ProductionWorkspace{}, projectError(http.StatusBadRequest, "工作台类型无效")
	}
	project, err := GetProductionProject(ctx, id)
	if err != nil {
		return project, model.ProductionWorkspace{}, err
	}
	for _, workspace := range project.Workspaces {
		if workspace.Kind == kind {
			return project, workspace, nil
		}
	}
	return project, model.ProductionWorkspace{}, projectError(http.StatusNotFound, "工作台不存在")
}

func CreateProductionProject(ctx context.Context, request CreateProductionProjectRequest) (model.ProductionProjectView, error) {
	identity, ok := UserFromContext(ctx)
	if !ok || identity.ID == "" {
		return model.ProductionProjectView{}, projectError(http.StatusUnauthorized, "请先登录")
	}
	if strings.TrimSpace(request.ProducerID) == "" {
		request.ProducerID = identity.ID
	}
	request, err := normalizeProductionRequest(request)
	if err != nil {
		return model.ProductionProjectView{}, err
	}
	content, _ := json.Marshal(struct{ Title, Summary, ProducerID string }{request.Title, request.Summary, request.ProducerID})
	hash := sha256.Sum256(content)
	payloadHash := hex.EncodeToString(hash[:])
	var view model.ProductionProjectView
	err = repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		actor, users, err := productionActor(tx, ctx, request.ProducerID, true)
		if err != nil {
			return err
		}
		if request.ProducerID != actor.ID && !actor.MayAssignProjects() {
			return projectError(http.StatusForbidden, "只有具备分派权限的人员可以指定其他制作组长")
		}
		previous, found, err := tx.Request(actor.ID, request.RequestID)
		if err != nil {
			return err
		}
		var project model.ProductionProject
		if found {
			if previous.PayloadHash != payloadHash {
				return projectError(http.StatusConflict, "此创建请求已用于其他内容")
			}
			project, err = productionVisibleProject(tx, previous.ProjectID, actor.ID)
			if err != nil {
				return err
			}
		} else {
			producer, found := users[request.ProducerID]
			if !found || !producer.MayCreateProjects() {
				return projectError(http.StatusBadRequest, "制作组长必须是有效账号")
			}
			timestamp := now()
			project = model.ProductionProject{ID: newID("project"), Title: request.Title, Summary: request.Summary, CreatedBy: actor.ID, ProducerID: producer.ID, Revision: 1, CreatedAt: timestamp, UpdatedAt: timestamp}
			spaces := []model.ProductionWorkspace{{ID: newID("workspace"), ProjectID: project.ID, Kind: "canvas", CreatedAt: timestamp}, {ID: newID("workspace"), ProjectID: project.ID, Kind: "assets", CreatedAt: timestamp}}
			if err := tx.Create(project, spaces, model.ProjectRequest{ActorID: actor.ID, RequestID: request.RequestID, PayloadHash: payloadHash, ProjectID: project.ID}); err != nil {
				return err
			}
		}
		views, err := productionProjectView(tx, []model.ProductionProject{project}, actor)
		if err == nil {
			view = views[0]
		}
		return err
	})
	return view, err
}

func AssignProductionProject(ctx context.Context, id string, request AssignProductionProjectRequest) (model.ProductionProjectView, error) {
	request.ProducerID = strings.TrimSpace(request.ProducerID)
	if !validProductionID(request.ProducerID) || request.Revision < 1 {
		return model.ProductionProjectView{}, projectError(http.StatusBadRequest, "负责人或版本无效")
	}
	var view model.ProductionProjectView
	err := repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		actor, users, err := productionActor(tx, ctx, request.ProducerID, true)
		if err != nil {
			return err
		}
		project, err := productionVisibleProject(tx, id, actor.ID, true)
		if err != nil {
			return err
		}
		if project.CreatedBy != actor.ID || !actor.MayAssignProjects() {
			return projectError(http.StatusForbidden, "仅有分派权限的项目创建者可改派")
		}
		producer, found := users[request.ProducerID]
		if !found || !producer.MayCreateProjects() {
			return projectError(http.StatusBadRequest, "制作组长必须是有效账号")
		}
		timestamp := now()
		updated, err := tx.Assign(project.ID, producer.ID, request.Revision, timestamp)
		if err != nil {
			return err
		}
		if !updated {
			return projectError(http.StatusConflict, "项目已更新，请重新加载后再改派")
		}
		project.ProducerID, project.Revision, project.UpdatedAt = producer.ID, request.Revision+1, timestamp
		views, err := productionProjectView(tx, []model.ProductionProject{project}, actor)
		if err == nil {
			view = views[0]
		}
		return err
	})
	return view, err
}
