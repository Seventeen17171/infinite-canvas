package handler

import (
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"unicode/utf8"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

func decodeProductionRequest(w http.ResponseWriter, r *http.Request, request any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(request); err != nil {
		FailWithStatus(w, http.StatusBadRequest, "请求正文无效或包含未知字段")
		return false
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		FailWithStatus(w, http.StatusBadRequest, "请求正文只允许一个JSON对象")
		return false
	}
	return true
}

func failProduction(w http.ResponseWriter, err error) {
	var failure service.ProductionError
	if errors.As(err, &failure) {
		FailWithStatus(w, failure.Status, failure.Message)
		return
	}
	log.Printf("production project request failed: %v", err)
	FailWithStatus(w, http.StatusInternalServerError, "项目操作失败，请重试")
}

func ProductionProjects(w http.ResponseWriter, r *http.Request) {
	query := model.Query{Page: 1, PageSize: 20, Keyword: r.URL.Query().Get("keyword")}
	if utf8.RuneCountInString(query.Keyword) > 80 {
		FailWithStatus(w, http.StatusBadRequest, "搜索内容最多80字")
		return
	}
	for key, value := range map[string]*int{"page": &query.Page, "pageSize": &query.PageSize} {
		if raw := r.URL.Query().Get(key); raw != "" {
			number, err := strconv.Atoi(raw)
			if err != nil || number < 1 || (key == "pageSize" && number > model.MaxPageSize) || (key == "page" && number > 1000000) {
				FailWithStatus(w, http.StatusBadRequest, "分页参数无效")
				return
			}
			*value = number
		}
	}
	projects, err := service.ListProductionProjects(r.Context(), query)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, projects)
}

func CreateProductionProject(w http.ResponseWriter, r *http.Request) {
	var request service.CreateProductionProjectRequest
	if !decodeProductionRequest(w, r, &request) {
		return
	}
	project, err := service.CreateProductionProject(r.Context(), request)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, project)
}

func ProductionProducers(w http.ResponseWriter, r *http.Request) {
	items, err := service.ProductionProducers(r.Context())
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, map[string]any{"items": items})
}

func GetProductionProject(w http.ResponseWriter, r *http.Request, id string) {
	project, err := service.GetProductionProject(r.Context(), id)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, project)
}

func GetProductionWorkspace(w http.ResponseWriter, r *http.Request, id, kind string) {
	project, workspace, err := service.GetProductionWorkspace(r.Context(), id, kind)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, map[string]any{"project": project, "workspace": workspace})
}

func AssignProductionProject(w http.ResponseWriter, r *http.Request, id string) {
	var request service.AssignProductionProjectRequest
	if !decodeProductionRequest(w, r, &request) {
		return
	}
	project, err := service.AssignProductionProject(r.Context(), id, request)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, project)
}
