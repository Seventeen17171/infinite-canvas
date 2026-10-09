package handler

import (
	"encoding/json"
	"errors"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
	"io"
	"net/http"
	"strconv"
)

func decodeProductionDocumentRequest(w http.ResponseWriter, r *http.Request, request any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 2<<20))
	decoder.DisallowUnknownFields()
	err := decoder.Decode(request)
	if err == nil {
		var extra any
		err = decoder.Decode(&extra)
		if err == io.EOF {
			return true
		}
	}
	var oversized *http.MaxBytesError
	if errors.As(err, &oversized) {
		FailWithStatus(w, http.StatusRequestEntityTooLarge, "画布正文不能超过2MiB")
	} else {
		FailWithStatus(w, http.StatusBadRequest, "请求正文无效或包含未知字段")
	}
	return false
}

func ProductionCanvasDocuments(w http.ResponseWriter, r *http.Request, projectID, kind string) {
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
	list, err := service.ListProductionCanvasDocuments(r.Context(), projectID, kind, query)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, list)
}

func CreateProductionCanvasDocument(w http.ResponseWriter, r *http.Request, projectID, kind string) {
	var request service.CreateProductionCanvasDocumentRequest
	if !decodeProductionDocumentRequest(w, r, &request) {
		return
	}
	document, err := service.CreateProductionCanvasDocument(r.Context(), projectID, kind, request)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, document)
}

func GetProductionCanvasDocument(w http.ResponseWriter, r *http.Request, projectID, kind, id string) {
	document, err := service.GetProductionCanvasDocument(r.Context(), projectID, kind, id)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, document)
}

func SaveProductionCanvasDocument(w http.ResponseWriter, r *http.Request, projectID, kind, id string) {
	var request service.SaveProductionCanvasDocumentRequest
	if !decodeProductionDocumentRequest(w, r, &request) {
		return
	}
	receipt, err := service.SaveProductionCanvasDocument(r.Context(), projectID, kind, id, request)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, receipt)
}
