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

type CreateProductionAssetRequest struct {
	Category    string `json:"category"`
	Name        string `json:"name"`
	Description string `json:"description"`
	RequestID   string `json:"requestId"`
}

type SaveProductionAssetRequest struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Revision    int64  `json:"revision"`
	RequestID   string `json:"requestId"`
}

func validAssetCategory(category string) bool { return category == "character" || category == "scene" }

func normalizeAssetWrite(name, description, requestID string) (string, string, error) {
	name = strings.TrimSpace(name)
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 80 || strings.ContainsFunc(name, unicode.IsControl) {
		return "", "", projectError(http.StatusBadRequest, "资产名称需为1–80字且不能含控制字符")
	}
	if !utf8.ValidString(description) || utf8.RuneCountInString(description) > 8000 || strings.ContainsFunc(description, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\r' && r != '\t' }) {
		return "", "", projectError(http.StatusBadRequest, "资产描述最多8000字，不能含异常控制字符")
	}
	id, err := uuid.Parse(requestID)
	if err != nil || len(requestID) != 36 || id == uuid.Nil {
		return "", "", projectError(http.StatusBadRequest, "requestId必须为UUID")
	}
	return name, id.String(), nil
}

func assetRequestHash(operation, projectID, assetID, category, name, description string, revision int64) string {
	encoded, _ := json.Marshal(struct {
		Operation, ProjectID, AssetID, Category, Name, Description string
		Revision                                                   int64
	}{operation, projectID, assetID, category, name, description, revision})
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:])
}

func assetReceipt(request model.ProductionAssetRequest) model.ProductionAssetSaveReceipt {
	return model.ProductionAssetSaveReceipt{ID: request.AssetID, ProjectID: request.ProjectID, Revision: request.Revision, UpdatedAt: request.UpdatedAt, RequestID: request.RequestID}
}

func productionAssetScope(tx *repository.ProductionTx, ctx context.Context, projectID string, lock bool) (model.User, error) {
	actor, _, err := productionActor(tx, ctx, "", lock)
	if err != nil {
		return actor, err
	}
	_, err = productionVisibleProject(tx, projectID, actor.ID, lock)
	return actor, err
}

func ListProductionAssets(ctx context.Context, projectID string, q model.Query) (model.ProductionAssetList, error) {
	var list model.ProductionAssetList
	q.Keyword = strings.TrimSpace(q.Keyword)
	if (q.Category != "" && !validAssetCategory(q.Category)) || !utf8.ValidString(q.Keyword) || utf8.RuneCountInString(q.Keyword) > 80 || strings.ContainsFunc(q.Keyword, unicode.IsControl) || q.Page < 1 || q.Page > 1000000 || q.PageSize < 1 || q.PageSize > 100 {
		return list, projectError(http.StatusBadRequest, "分类、搜索或分页参数无效")
	}
	err := repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		if _, err := productionAssetScope(tx, ctx, projectID, false); err != nil {
			return err
		}
		var err error
		list, err = tx.Assets(projectID, q)
		return err
	})
	return list, err
}

func GetProductionAsset(ctx context.Context, projectID, id string) (model.ProductionAsset, error) {
	var asset model.ProductionAsset
	err := repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		if _, err := productionAssetScope(tx, ctx, projectID, false); err != nil {
			return err
		}
		var found bool
		var err error
		asset, found, err = tx.Asset(projectID, id)
		if err != nil {
			return err
		}
		if !found {
			return projectError(http.StatusNotFound, "资产不存在或无权访问")
		}
		return nil
	})
	return asset, err
}

func CreateProductionAsset(ctx context.Context, projectID string, request CreateProductionAssetRequest) (model.ProductionAsset, error) {
	var asset model.ProductionAsset
	if !validAssetCategory(request.Category) {
		return asset, projectError(http.StatusBadRequest, "请选择人物或场景分类")
	}
	var err error
	request.Name, request.RequestID, err = normalizeAssetWrite(request.Name, request.Description, request.RequestID)
	if err != nil {
		return asset, err
	}
	err = repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		actor, err := productionAssetScope(tx, ctx, projectID, true)
		if err != nil {
			return err
		}
		hash := assetRequestHash("create", projectID, "", request.Category, request.Name, request.Description, 0)
		previous, found, err := tx.AssetRequest(actor.ID, request.RequestID)
		if err != nil {
			return err
		}
		if found {
			if previous.PayloadHash != hash {
				return projectError(http.StatusConflict, "此请求编号已用于其他资产或内容")
			}
			asset, found, err = tx.Asset(projectID, previous.AssetID)
			if err != nil {
				return err
			}
			if !found {
				return projectError(http.StatusNotFound, "资产不存在或无权访问")
			}
			return nil
		}
		timestamp := now()
		asset = model.ProductionAsset{ID: newID("asset"), ProjectID: projectID, Category: request.Category, Name: request.Name, Description: request.Description, Revision: 1, CreatedBy: actor.ID, UpdatedBy: actor.ID, CreatedAt: timestamp, UpdatedAt: timestamp}
		if err := tx.CreateAsset(asset); err != nil {
			return err
		}
		return tx.RecordAssetRequest(model.ProductionAssetRequest{ActorID: actor.ID, RequestID: request.RequestID, PayloadHash: hash, Operation: "create", ProjectID: projectID, AssetID: asset.ID, Revision: 1, UpdatedAt: timestamp})
	})
	return asset, err
}

func SaveProductionAsset(ctx context.Context, projectID, id string, request SaveProductionAssetRequest) (model.ProductionAssetSaveReceipt, error) {
	var receipt model.ProductionAssetSaveReceipt
	var err error
	request.Name, request.RequestID, err = normalizeAssetWrite(request.Name, request.Description, request.RequestID)
	if err != nil {
		return receipt, err
	}
	if request.Revision < 1 || request.Revision >= 9007199254740991 {
		return receipt, projectError(http.StatusBadRequest, "资产版本无效")
	}
	err = repository.ProductionTransaction(ctx, func(tx *repository.ProductionTx) error {
		actor, err := productionAssetScope(tx, ctx, projectID, true)
		if err != nil {
			return err
		}
		asset, found, err := tx.Asset(projectID, id)
		if err != nil {
			return err
		}
		if !found {
			return projectError(http.StatusNotFound, "资产不存在或无权访问")
		}
		hash := assetRequestHash("save", projectID, id, asset.Category, request.Name, request.Description, request.Revision)
		previous, found, err := tx.AssetRequest(actor.ID, request.RequestID)
		if err != nil {
			return err
		}
		if found {
			if previous.PayloadHash != hash {
				return projectError(http.StatusConflict, "此请求编号已用于其他资产或内容")
			}
			receipt = assetReceipt(previous)
			return nil
		}
		asset.Name, asset.Description, asset.UpdatedBy, asset.UpdatedAt = request.Name, request.Description, actor.ID, now()
		updated, err := tx.SaveAsset(asset, request.Revision)
		if err != nil {
			return err
		}
		if !updated {
			return projectError(http.StatusConflict, "资产已被更新，请保留草稿并载入最新版本")
		}
		record := model.ProductionAssetRequest{ActorID: actor.ID, RequestID: request.RequestID, PayloadHash: hash, Operation: "save", ProjectID: projectID, AssetID: id, Revision: request.Revision + 1, UpdatedAt: asset.UpdatedAt}
		if err := tx.RecordAssetRequest(record); err != nil {
			return err
		}
		receipt = assetReceipt(record)
		return nil
	})
	return receipt, err
}
