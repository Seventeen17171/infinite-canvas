package handler

import (
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

func PrivateFileHeaders(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Vary", "Authorization")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func LegacyFileRead(w http.ResponseWriter, r *http.Request) {
	PrivateFileHeaders(w)
	FailWithStatus(w, http.StatusNotFound, "文件不存在或不可用")
}

func ProjectFileEntryRequired(w http.ResponseWriter, r *http.Request) {
	PrivateFileHeaders(w)
	FailWithStatus(w, http.StatusGone, "请使用项目内文件入口；旧文件上传与删除已停用")
}

func ProductionFiles(w http.ResponseWriter, r *http.Request, projectID, assetID string) {
	PrivateFileHeaders(w)
	q := model.Query{Page: 1, PageSize: 20}
	for key, values := range r.URL.Query() {
		if len(values) != 1 || (key != "page" && key != "pageSize") {
			FailWithStatus(w, http.StatusBadRequest, "文件列表参数无效")
			return
		}
		n, err := strconv.Atoi(values[0])
		if err != nil {
			FailWithStatus(w, http.StatusBadRequest, "文件分页参数无效")
			return
		}
		if key == "page" {
			q.Page = n
		} else {
			q.PageSize = n
		}
	}
	list, err := service.ListProductionFiles(r.Context(), projectID, assetID, q)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, list)
}

func GetProductionFile(w http.ResponseWriter, r *http.Request, projectID, fileID string) {
	PrivateFileHeaders(w)
	if len(r.URL.Query()) != 0 {
		FailWithStatus(w, http.StatusBadRequest, "文件参数无效")
		return
	}
	file, err := service.GetProductionFile(r.Context(), projectID, fileID)
	if err != nil {
		failProduction(w, err)
		return
	}
	OK(w, file)
}

// ServeContent removes Cache-Control on some errors; restore our privacy policy at commit.
type privateFileWriter struct{ http.ResponseWriter }

func (w privateFileWriter) WriteHeader(status int) {
	PrivateFileHeaders(w.ResponseWriter)
	w.ResponseWriter.WriteHeader(status)
}

func ProductionFileContent(w http.ResponseWriter, r *http.Request, projectID, fileID string) {
	PrivateFileHeaders(w)
	file, stream, err := service.OpenProductionFile(r.Context(), projectID, fileID)
	if err != nil {
		failProduction(w, err)
		return
	}
	defer stream.Close()
	download := false
	for key, values := range r.URL.Query() {
		if key != "download" || len(values) != 1 || (values[0] != "0" && values[0] != "1") {
			FailWithStatus(w, http.StatusBadRequest, "文件参数无效")
			return
		}
		download = values[0] == "1"
	}
	if values := r.Header.Values("Range"); len(values) > 1 || strings.Contains(r.Header.Get("Range"), ",") {
		w.Header().Set("Content-Range", "bytes */"+strconv.FormatInt(file.Bytes, 10))
		FailWithStatus(w, http.StatusRequestedRangeNotSatisfiable, "一次只能读取一个文件范围")
		return
	}
	disposition := "inline"
	if download {
		disposition = "attachment"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": file.Name}))
	w.Header().Set("Content-Type", file.MimeType)
	http.ServeContent(privateFileWriter{w}, r, file.Name, time.Time{}, stream)
}
