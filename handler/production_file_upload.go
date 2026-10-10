package handler

import (
	"errors"
	"net/http"
	"time"

	"github.com/tigerowo/infinite-canvas/service"
)

func UploadProductionFile(w http.ResponseWriter, r *http.Request, projectID, assetID string) {
	PrivateFileHeaders(w)
	if len(r.URL.Query()) != 0 || (len(r.Header.Values("X-Upload-Request-Id")) != 1 || len(r.Header.Values("Content-Type")) != 1) {
		FailWithStatus(w, http.StatusBadRequest, "上传参数无效")
		return
	}
	controller := http.NewResponseController(w)
	// Gin exposes Unwrap. A bounded read deadline prevents slow clients monopolizing the two upload slots.
	_ = controller.SetReadDeadline(time.Now().Add(90 * time.Second))
	defer controller.SetReadDeadline(time.Time{})
	r.Body = http.MaxBytesReader(w, r.Body, service.ProductionUploadMaxBody)
	receipt, err := service.UploadProductionFile(r.Context(), projectID, assetID, service.ProductionFileUploadInput{RequestID: r.Header.Get("X-Upload-Request-Id"), ContentType: r.Header.Get("Content-Type"), ContentLength: r.ContentLength, Body: r.Body})
	if err != nil {
		var failure service.ProductionError
		if errors.As(err, &failure) && failure.Status == http.StatusTooManyRequests {
			w.Header().Set("Retry-After", "2")
		}
		failProduction(w, err)
		return
	}
	OK(w, receipt)
}

func GetProductionFileUpload(w http.ResponseWriter, r *http.Request, projectID, assetID, requestID string) {
	PrivateFileHeaders(w)
	if len(r.URL.Query()) != 0 {
		FailWithStatus(w, http.StatusBadRequest, "上传回执参数无效")
		return
	}
	result, err := service.GetProductionFileUpload(r.Context(), projectID, assetID, requestID)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, result)
}
