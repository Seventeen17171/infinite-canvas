package service

import (
	"context"
	"net/http"
	"os"
	"strings"
	"syscall"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const ProductionFileMaxBytes int64 = 20 << 20

func unavailableProductionFile() error {
	return projectError(http.StatusNotFound, "文件不存在或不可用")
}

func productionFileView(file model.ProductionFile) (model.ProductionFileView, error) {
	if !strings.HasPrefix(file.ID, "file-") {
		return model.ProductionFileView{}, unavailableProductionFile()
	}
	id, err := uuid.Parse(strings.TrimPrefix(file.ID, "file-"))
	if err != nil || file.ID != "file-"+id.String() || file.StorageKey != file.ID+".blob" ||
		file.Bytes <= 0 || file.Bytes > ProductionFileMaxBytes || !utf8.ValidString(file.Name) ||
		strings.TrimSpace(file.Name) == "" || utf8.RuneCountInString(file.Name) > 180 ||
		strings.ContainsAny(file.Name, "/\\") || strings.ContainsFunc(file.Name, unicode.IsControl) ||
		(file.MimeType != "image/png" && file.MimeType != "image/jpeg" && file.MimeType != "image/webp") {
		return model.ProductionFileView{}, unavailableProductionFile()
	}
	return model.ProductionFileView{ID: file.ID, ProjectID: file.ProjectID, AssetID: file.AssetID, Name: file.Name, MimeType: file.MimeType, Bytes: file.Bytes, CreatedAt: file.CreatedAt}, nil
}

func ListProductionFiles(ctx context.Context, projectID, assetID string, q model.Query) (model.ProductionFileList, error) {
	list := model.ProductionFileList{Items: make([]model.ProductionFileView, 0)}
	if q.Page < 1 || q.Page > 1000000 || q.PageSize < 1 || q.PageSize > 20 {
		return list, projectError(http.StatusBadRequest, "文件分页参数无效")
	}
	err := repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		if _, err := productionAssetScope(tx, ctx, projectID, false); err != nil {
			return err
		}
		if _, found, err := tx.Asset(projectID, assetID); err != nil {
			return err
		} else if !found {
			return unavailableProductionFile()
		}
		files, total, err := tx.Files(projectID, assetID, q)
		if err != nil {
			return err
		}
		list.Total = total
		for _, file := range files {
			view, err := productionFileView(file)
			if err != nil {
				return err
			}
			list.Items = append(list.Items, view)
		}
		return nil
	})
	return list, err
}

func authorizedProductionFile(ctx context.Context, projectID, fileID string) (model.ProductionFile, model.ProductionFileView, error) {
	var file model.ProductionFile
	var view model.ProductionFileView
	err := repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		if _, err := productionAssetScope(tx, ctx, projectID, false); err != nil {
			return err
		}
		var found bool
		var err error
		file, found, err = tx.File(projectID, fileID)
		if err != nil {
			return err
		}
		if !found {
			return unavailableProductionFile()
		}
		if _, found, err := tx.Asset(projectID, file.AssetID); err != nil {
			return err
		} else if !found {
			return unavailableProductionFile()
		}
		view, err = productionFileView(file)
		return err
	})
	return file, view, err
}

func GetProductionFile(ctx context.Context, projectID, fileID string) (model.ProductionFileView, error) {
	_, view, err := authorizedProductionFile(ctx, projectID, fileID)
	return view, err
}

// Authorization ends before opening/streaming, so a slow reader never holds a DB connection.
func OpenProductionFile(ctx context.Context, projectID, fileID string) (model.ProductionFileView, *os.File, error) {
	file, view, err := authorizedProductionFile(ctx, projectID, fileID)
	if err != nil {
		return view, nil, err
	}
	directory := strings.TrimSpace(config.Cfg.ProductionFileDir)
	if directory == "" {
		directory = "data/production-files"
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return view, nil, unavailableProductionFile()
	}
	defer root.Close()
	before, err := root.Lstat(file.StorageKey)
	if err != nil || !before.Mode().IsRegular() {
		return view, nil, unavailableProductionFile()
	}
	// O_NONBLOCK avoids hanging if a trusted disk entry is replaced with a FIFO between checks.
	stream, err := root.OpenFile(file.StorageKey, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return view, nil, unavailableProductionFile()
	}
	after, err := stream.Stat()
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) || after.Size() != file.Bytes {
		stream.Close()
		return view, nil, unavailableProductionFile()
	}
	return view, stream, nil
}
