package handler

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

func decodeProductionAssetRequest(w http.ResponseWriter, r *http.Request, request any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10))
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
		FailWithStatus(w, http.StatusRequestEntityTooLarge, "资产请求正文不能超过256KiB")
	} else {
		FailWithStatus(w, http.StatusBadRequest, "请求正文无效或包含未知字段")
	}
	return false
}

func ProductionAssets(w http.ResponseWriter, r *http.Request, projectID string) {
	values := r.URL.Query()
	query := model.Query{Page: 1, PageSize: 20, Category: values.Get("category"), Keyword: values.Get("q")}
	for key, values := range values {
		if len(values) != 1 || (key != "page" && key != "pageSize" && key != "category" && key != "q") {
			FailWithStatus(w, http.StatusBadRequest, "列表参数无效")
			return
		}
		if key == "page" || key == "pageSize" {
			number, err := strconv.Atoi(values[0])
			if err != nil {
				FailWithStatus(w, http.StatusBadRequest, "分页参数无效")
				return
			}
			if key == "page" {
				query.Page = number
			} else {
				query.PageSize = number
			}
		}
	}
	list, err := service.ListProductionAssets(r.Context(), projectID, query)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, list)
}

func CreateProductionAsset(w http.ResponseWriter, r *http.Request, projectID string) {
	var request service.CreateProductionAssetRequest
	if !decodeProductionAssetRequest(w, r, &request) {
		return
	}
	asset, err := service.CreateProductionAsset(r.Context(), projectID, request)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, asset)
}

func GetProductionAsset(w http.ResponseWriter, r *http.Request, projectID, id string) {
	asset, err := service.GetProductionAsset(r.Context(), projectID, id)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, asset)
}

func SaveProductionAsset(w http.ResponseWriter, r *http.Request, projectID, id string) {
	var request service.SaveProductionAssetRequest
	if !decodeProductionAssetRequest(w, r, &request) {
		return
	}
	receipt, err := service.SaveProductionAsset(r.Context(), projectID, id, request)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, receipt)
}
