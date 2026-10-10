package handler

import (
	"net/http"
	"strconv"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

func ProductionProjectBudget(w http.ResponseWriter, r *http.Request, projectID string) {
	view, err := service.GetProductionProjectBudget(r.Context(), projectID)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, view)
}

func ApplyProductionProjectBudget(w http.ResponseWriter, r *http.Request, projectID string) {
	var request service.ApplyProductionBudgetRequest
	if !decodeProductionRequest(w, r, &request) {
		return
	}
	view, err := service.ApplyProductionProjectBudget(r.Context(), projectID, request)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, view)
}

func AdminBudgetApplications(w http.ResponseWriter, r *http.Request) {
	query := model.Query{Page: 1, PageSize: 20}
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
	list, err := service.ListProductionBudgetApplications(r.Context(), query, r.URL.Query().Get("status"))
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, list)
}

func DecideProductionProjectBudget(w http.ResponseWriter, r *http.Request, applicationID string) {
	var request service.DecideProductionBudgetRequest
	if !decodeProductionRequest(w, r, &request) {
		return
	}
	view, err := service.DecideProductionProjectBudget(r.Context(), applicationID, request)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, view)
}
