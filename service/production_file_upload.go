package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const ProductionUploadMaxBody = ProductionFileMaxBytes + 64<<10

var productionUploadSlots = make(chan struct{}, 2)

type ProductionFileUploadInput struct {
	RequestID, ContentType string
	ContentLength          int64
	Body                   io.Reader
}

func validFileUploadRequestID(value string) bool {
	id, err := uuid.Parse(value)
	return err == nil && id != uuid.Nil && value == id.String()
}

func fileUploadScope(tx *repository.ProductionTx, ctx context.Context, projectID, assetID string, lock bool) (model.User, error) {
	actor, err := productionAssetScope(tx, ctx, projectID, lock)
	if err != nil {
		return actor, err
	}
	if _, found, err := tx.Asset(projectID, assetID); err != nil {
		return actor, err
	} else if !found {
		return actor, unavailableProductionFile()
	}
	return actor, nil
}

func GetProductionFileUpload(ctx context.Context, projectID, assetID, requestID string) (model.ProductionFileUploadReceipt, error) {
	var result model.ProductionFileUploadReceipt
	err := repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		actor, err := fileUploadScope(tx, ctx, projectID, assetID, false)
		if err != nil {
			return err
		}
		if !validFileUploadRequestID(requestID) {
			return projectError(http.StatusBadRequest, "上传请求编号必须为规范UUID")
		}
		record, found, err := tx.FileUploadRequest(actor.ID, requestID)
		if err != nil {
			return err
		}
		if !found || record.ProjectID != projectID || record.AssetID != assetID {
			return projectError(http.StatusNotFound, "尚未找到已完成的上传回执，请稍后确认")
		}
		result, err = fileUploadReceipt(tx, record)
		return err
	})
	return result, err
}

func fileUploadReceipt(tx *repository.ProductionTx, record model.ProductionFileUploadRequest) (model.ProductionFileUploadReceipt, error) {
	var result model.ProductionFileUploadReceipt
	file, found, err := tx.File(record.ProjectID, record.FileID)
	if err != nil {
		return result, err
	}
	if !found || file.AssetID != record.AssetID {
		return result, unavailableProductionFile()
	}
	result.File, err = productionFileView(file)
	result.RequestID = record.RequestID
	return result, err
}

type uploadBodyReader struct {
	ctx    context.Context
	source io.Reader
	read   int64
}

func (r *uploadBodyReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	n, err := r.source.Read(p)
	r.read += int64(n)
	if r.read > ProductionUploadMaxBody {
		return n, &http.MaxBytesError{Limit: ProductionUploadMaxBody}
	}
	return n, err
}
func uploadReadError(err error) error {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return projectError(http.StatusRequestEntityTooLarge, "图片不得超过20MiB，请选择更小的图片")
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return projectError(http.StatusBadRequest, "上传内容不完整，请使用原图片重试")
}

func UploadProductionFile(ctx context.Context, projectID, assetID string, input ProductionFileUploadInput) (model.ProductionFileUploadReceipt, error) {
	var result model.ProductionFileUploadReceipt
	// Reject unauthorized users before reading or creating anything on disk.
	if err := repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		_, err := fileUploadScope(tx, ctx, projectID, assetID, false)
		return err
	}); err != nil {
		return result, err
	}
	if !validFileUploadRequestID(input.RequestID) {
		return result, projectError(http.StatusBadRequest, "上传请求编号必须为规范UUID")
	}
	if input.ContentLength > ProductionUploadMaxBody {
		return result, projectError(http.StatusRequestEntityTooLarge, "上传正文不得超过20MiB加64KiB")
	}
	contentType, params, err := mime.ParseMediaType(input.ContentType)
	if err != nil || contentType != "multipart/form-data" || params["boundary"] == "" || len(params["boundary"]) > 70 || input.Body == nil {
		return result, projectError(http.StatusBadRequest, "请选择一张图片上传")
	}
	select {
	case productionUploadSlots <- struct{}{}:
		defer func() { <-productionUploadSlots }()
	default:
		return result, projectError(http.StatusTooManyRequests, "当前上传繁忙，请稍后使用同一请求重试")
	}
	body := &uploadBodyReader{ctx: ctx, source: io.LimitReader(input.Body, ProductionUploadMaxBody+1)}
	reader := multipart.NewReader(body, params["boundary"])
	part, err := reader.NextRawPart()
	if err != nil {
		return result, uploadReadError(err)
	}
	disposition, partParams, err := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
	rawName := partParams["filename"]
	name := strings.TrimSpace(rawName)
	if err != nil || disposition != "form-data" || partParams["name"] != "file" || strings.ContainsFunc(rawName, unicode.IsControl) || !validUploadFilename(name) {
		return result, projectError(http.StatusBadRequest, "仅接受一个file图片，文件名需为1–180字且不能含路径或控制字符")
	}
	headerBytes := 0
	for key, values := range part.Header {
		if len(values) != 1 {
			return result, projectError(http.StatusBadRequest, "上传文件头不能重复")
		}
		for _, value := range values {
			headerBytes += len(key) + len(value)
		}
	}
	if len(part.Header) > 8 || headerBytes > 16<<10 {
		return result, projectError(http.StatusBadRequest, "上传文件头过大")
	}
	if part.Header.Get("Content-Transfer-Encoding") != "" {
		return result, projectError(http.StatusBadRequest, "不接受编码转换的文件上传")
	}
	declaredMIME := part.Header.Get("Content-Type")
	if declaredMIME != "" {
		declaredMIME, _, err = mime.ParseMediaType(declaredMIME)
		if err != nil {
			return result, projectError(http.StatusUnsupportedMediaType, "图片类型无效")
		}
	}
	directory := strings.TrimSpace(config.Cfg.ProductionFileDir)
	if directory == "" {
		directory = "data/production-files"
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return result, projectError(http.StatusServiceUnavailable, "图片存储暂不可用，请稍后确认或重试")
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return result, projectError(http.StatusServiceUnavailable, "图片存储暂不可用，请稍后确认或重试")
	}
	defer root.Close()
	temporaryKey := "upload-" + uuid.NewString() + ".tmp"
	temporary, err := root.OpenFile(temporaryKey, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return result, projectError(http.StatusServiceUnavailable, "无法保存图片，请稍后确认或重试")
	}
	defer temporary.Close()
	defer root.Remove(temporaryKey)
	hash := sha256.New()
	size, err := io.Copy(io.MultiWriter(temporary, hash), io.LimitReader(part, ProductionFileMaxBytes+1))
	if err != nil {
		return result, uploadReadError(err)
	}
	if size > ProductionFileMaxBytes {
		return result, projectError(http.StatusRequestEntityTooLarge, "图片不得超过20MiB")
	}
	if size == 0 {
		return result, projectError(http.StatusUnprocessableEntity, "图片内容为空")
	}
	if next, err := reader.NextRawPart(); err != io.EOF {
		if next != nil {
			return result, projectError(http.StatusBadRequest, "每次只允许上传一个file图片，不接受其他字段")
		}
		return result, uploadReadError(err)
	}
	// Consume only the bounded multipart epilogue so oversized chunked bodies cannot hide after the final boundary.
	if _, err := io.Copy(io.Discard, body); err != nil {
		return result, uploadReadError(err)
	}
	actualMIME, err := validateProductionImage(temporary)
	if err != nil {
		return result, err
	}
	if (declaredMIME != "" && declaredMIME != "application/octet-stream" && declaredMIME != actualMIME) || !uploadExtensionMatches(name, actualMIME) {
		return result, projectError(http.StatusUnsupportedMediaType, "文件扩展名或声明类型与真实图片不一致")
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if err := temporary.Sync(); err != nil {
		return result, projectError(http.StatusServiceUnavailable, "图片写入未完成，请稍后确认或重试")
	}
	file := model.ProductionFile{ID: "file-" + uuid.NewString(), ProjectID: projectID, AssetID: assetID, Name: name, MimeType: actualMIME, Bytes: size, CreatedAt: now()}
	file.StorageKey = file.ID + ".blob"
	if err := root.Link(temporaryKey, file.StorageKey); err != nil {
		return result, projectError(http.StatusServiceUnavailable, "图片写入未完成，请稍后确认或重试")
	}
	removeCandidate := true
	defer func() {
		if removeCandidate {
			_ = root.Remove(file.StorageKey)
		}
	}()
	folder, err := root.Open(".")
	if err != nil {
		return result, projectError(http.StatusServiceUnavailable, "图片写入未完成，请稍后确认或重试")
	}
	err = folder.Sync()
	_ = folder.Close()
	if err != nil {
		return result, projectError(http.StatusServiceUnavailable, "图片写入未完成，请稍后确认或重试")
	}
	encoded, _ := json.Marshal([]any{projectID, assetID, name, actualMIME, size, hex.EncodeToString(hash.Sum(nil))})
	payloadHash := sha256.Sum256(encoded)
	committedCallback := false
	inserted := false
	err = repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		actor, err := fileUploadScope(tx, ctx, projectID, assetID, true)
		if err != nil {
			return err
		}
		previous, found, err := tx.FileUploadRequest(actor.ID, input.RequestID)
		if err != nil {
			return err
		}
		if found {
			if previous.PayloadHash != hex.EncodeToString(payloadHash[:]) {
				return projectError(http.StatusConflict, "此上传请求编号已用于其他图片或资产，请确认原上传结果")
			}
			result, err = fileUploadReceipt(tx, previous)
			return err
		}
		count, bytesUsed, err := tx.FileUsage(projectID)
		if err != nil {
			return err
		}
		maxCount, maxBytes := productionFileQuota()
		if count >= maxCount || bytesUsed > maxBytes-size {
			return projectError(http.StatusConflict, "项目图片存储额度不足，请联系管理员")
		}
		file.CreatedBy = actor.ID
		record := model.ProductionFileUploadRequest{ActorID: actor.ID, RequestID: input.RequestID, ProjectID: projectID, AssetID: assetID, FileID: file.ID, PayloadHash: hex.EncodeToString(payloadHash[:]), CreatedAt: file.CreatedAt}
		if err := tx.CreateUploadedFile(file, record); err != nil {
			return err
		}
		result.File, err = productionFileView(file)
		result.RequestID = input.RequestID
		inserted, committedCallback = true, err == nil
		return err
	})
	// A Commit error may follow a successful commit. Keep the durable bytes and resolve through the receipt instead of deleting an indexed file.
	if inserted && committedCallback {
		removeCandidate = false
	}
	if err != nil {
		return model.ProductionFileUploadReceipt{}, err
	}
	return result, nil
}

func validUploadFilename(name string) bool {
	return utf8.ValidString(name) && len([]rune(name)) >= 1 && utf8.RuneCountInString(name) <= 180 && !strings.ContainsAny(name, "/\\") && !strings.ContainsFunc(name, unicode.IsControl)
}
func uploadExtensionMatches(name, mime string) bool {
	extension := strings.ToLower(filepath.Ext(name))
	return (mime == "image/png" && extension == ".png") || (mime == "image/jpeg" && (extension == ".jpg" || extension == ".jpeg")) || (mime == "image/webp" && extension == ".webp")
}
func productionFileQuota() (int64, int64) {
	count, size := config.Cfg.ProductionProjectFileCount, config.Cfg.ProductionProjectFileBytes
	if count < 1 || count > 100000 {
		count = 1000
	}
	if size < 1 || size > 1<<40 {
		size = 2 << 30
	}
	return count, size
}
