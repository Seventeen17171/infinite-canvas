package handler

import (
	"net/http"

	"github.com/tigerowo/infinite-canvas/service"
)

func GetProductionAssetCreative(w http.ResponseWriter, r *http.Request, projectID, assetID string) {
	detail, err := service.GetProductionAssetCreative(r.Context(), projectID, assetID)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, detail)
}

func SaveProductionAssetCreative(w http.ResponseWriter, r *http.Request, projectID, assetID string) {
	var request service.SaveProductionAssetCreativeRequest
	if !decodeProductionAssetRequest(w, r, &request) {
		return
	}
	receipt, err := service.SaveProductionAssetCreative(r.Context(), projectID, assetID, request)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, receipt)
}
